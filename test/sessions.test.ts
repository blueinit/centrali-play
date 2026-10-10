import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../src/config'
import { sessionConfig } from '../src/config'
import app from '../src/index'
import { redisCommand } from '../src/redis'
import { sessionKeys } from '../src/session-store'
import { tokenDigest } from '../src/tokens'

const bindings = env as Bindings
const config = sessionConfig(bindings)
const keys: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

describe('session creation', () => {
  it('persists only token digests and returns a fixed Redis deadline', async () => {
    const response = await exports.default.fetch(
      'https://attacker.example/sessions',
      {
        method: 'POST',
        headers: { 'X-Forwarded-Host': 'attacker.example' },
      },
    )
    const session = await response.json<{
      id: string
      captureUrl: string
      readToken: string
      expiresAt: string
    }>()
    const captureToken = session.captureUrl.split('/').at(-1)!
    const captureHash = await tokenDigest(captureToken)
    const readHash = await tokenDigest(session.readToken)
    const [metadataKey, lookupKey] = sessionKeys(session.id, captureHash)
    keys.push(metadataKey, lookupKey)

    expect(response.status).toBe(201)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(session.id).toMatch(/^[a-f0-9]{32}$/)
    expect(captureToken).toMatch(/^[a-f0-9]{64}$/)
    expect(session.readToken).toMatch(/^[a-f0-9]{64}$/)
    expect(captureToken).not.toBe(session.readToken)
    expect(new URL(session.captureUrl).origin).toBe('https://play.example')

    const stored = await redisCommand(config, ['GET', metadataKey])
    expect(typeof stored).toBe('string')
    const metadata = JSON.parse(stored as string)
    expect(metadata).toEqual({
      id: session.id,
      captureTokenHash: captureHash,
      readTokenHash: readHash,
      expiresAt: Date.parse(session.expiresAt) / 1_000,
    })
    expect(stored).not.toContain(captureToken)
    expect(stored).not.toContain(session.readToken)
    expect(await redisCommand(config, ['GET', lookupKey])).toBe(session.id)
    const expiry = await redisCommand(config, ['EXPIRETIME', metadataKey])
    expect(expiry).toBe(metadata.expiresAt)
    expect(await redisCommand(config, ['EXPIRETIME', lookupKey])).toBe(expiry)
    const remaining = await redisCommand(config, ['TTL', metadataKey])
    expect(remaining).toBeGreaterThan(3_590)
    expect(remaining).toBeLessThanOrEqual(3_600)
    // Inspecting metadata cannot refresh the deadline.
    expect(await redisCommand(config, ['EXPIRETIME', metadataKey])).toBe(expiry)
  })

  it('rejects a streamed body without storage access', async () => {
    const storage = vi.spyOn(globalThis, 'fetch')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
    })
    const response = await app.request(
      'https://play.example/sessions',
      {
        method: 'POST',
        body,
      },
      bindings,
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(storage).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    'http://public.example',
    'https://play.example/path',
    'https://play.example?',
    'https://play.example#',
    'https://user:secret@play.example',
    ' https://play.example',
    'https://play.example/../',
    'https://play.example\\path',
  ])(
    'rejects invalid public origin %s before storage access',
    async (origin) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        '/sessions',
        { method: 'POST' },
        {
          ...bindings,
          PUBLIC_BASE_URL: origin,
        },
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'service_unavailable' })
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it.each([
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://[::1]:8787',
  ])('accepts loopback public origin %s', async (origin) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ result: 2_000_000_000 }))
      .mockResolvedValueOnce(Response.json({ result: ['reserved'] }))
    const response = await app.request(
      '/sessions',
      { method: 'POST' },
      {
        ...bindings,
        PUBLIC_BASE_URL: origin,
      },
    )
    expect(response.status).toBe(201)
    const session = await response.json<{ captureUrl: string }>()
    expect(new URL(session.captureUrl).origin).toBe(origin)
  })

  it.each([
    { UPSTASH_REDIS_REST_URL: 'http://public.example' },
    { UPSTASH_REDIS_REST_URL: 'https://redis.example/redirect' },
    { UPSTASH_REDIS_REST_TOKEN: '' },
    { UPSTASH_REDIS_REST_TOKEN: 'bad\ncredential' },
  ])('rejects invalid Redis configuration %j', async (override) => {
    const storage = vi.spyOn(globalThis, 'fetch')
    const response = await app.request(
      '/sessions',
      { method: 'POST' },
      {
        ...bindings,
        ...override,
      },
    )
    expect(response.status).toBe(503)
    expect(storage).not.toHaveBeenCalled()
  })

  it.each([
    () => Response.json({ error: 'secret backend detail' }),
    () => new Response('secret backend detail', { status: 429 }),
    () => new Response('not JSON'),
    () => new Response('x'.repeat(4_097)),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example' },
      }),
    () => Response.json({ result: 'OK' }),
    () => Response.json({ result: -1 }),
    () => Response.json({ result: null }),
  ])(
    'hides backend errors and does not retry an uncertain write',
    async (reply) => {
      const storage = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(reply())
        .mockResolvedValueOnce(Response.json({ result: ['reserved'] }))
      const response = await app.request(
        '/sessions',
        { method: 'POST' },
        bindings,
      )
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'service_unavailable' })
      expect(storage).toHaveBeenCalledTimes(2)
      expect(storage.mock.calls[0]?.[1]?.redirect).toBe('manual')
    },
  )

  it('handles a network failure without returning credentials', async () => {
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('credential leak'))
      .mockResolvedValueOnce(Response.json({ result: ['reserved'] }))
    const response = await app.request(
      '/sessions',
      { method: 'POST' },
      bindings,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
    expect(storage).toHaveBeenCalledTimes(2)
  })

  it('retries only confirmed collisions with fresh credentials and a fixed cap', async () => {
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ result: 0 }))
      .mockResolvedValueOnce(Response.json({ result: ['reserved'] }))
    const response = await app.request(
      '/sessions',
      { method: 'POST' },
      bindings,
    )
    expect(response.status).toBe(503)
    expect(storage).toHaveBeenCalledTimes(4)
    const commands = storage.mock.calls
      .slice(1)
      .map((call) => JSON.parse(call[1]?.body as string))
    expect(new Set(commands.map((command) => command[3])).size).toBe(3)
    expect(new Set(commands.map((command) => command[4])).size).toBe(3)
  })
})
