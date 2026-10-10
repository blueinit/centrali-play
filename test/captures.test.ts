import { exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { redisCommand } from '../src/redis'
import {
  bindings,
  config,
  captureFixture,
  storedCaptures,
} from './capture-fixture'

const keys: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

describe('capture HTTP contract', () => {
  it('returns 408 for a stalled body without writing an event', async () => {
    const session = await captureFixture(keys)
    const body = new ReadableStream<Uint8Array>()
    const response = await app.request(
      `/capture/${session.captureToken}`,
      { method: 'POST', body },
      bindings,
    )
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: 'request_timeout' })
    expect(await redisCommand(config, ['EXISTS', session.eventsKey])).toBe(0)
  }, 10_000)

  it('returns 400 for a failed body without exposing the stream error', async () => {
    const session = await captureFixture(keys)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error('private stream detail'))
      },
    })
    const response = await app.request(
      `/capture/${session.captureToken}`,
      { method: 'POST', body },
      bindings,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(await redisCommand(config, ['EXISTS', session.eventsKey])).toBe(0)
  })

  it.each([
    { path: `?${'x'.repeat(4_096)}`, headers: {} },
    { path: '', headers: { 'X-Large': 'x'.repeat(16_384) } },
  ])(
    'rejects oversized metadata before storage access',
    async ({ path, headers }) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        `/capture/${'0'.repeat(64)}${path}`,
        { method: 'POST', headers },
        bindings,
      )
      expect(response.status).toBe(413)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it('rejects an unknown capability without waiting for its stalled body', async () => {
    const body = new ReadableStream<Uint8Array>()
    const response = await app.request(
      `/capture/${'0'.repeat(64)}`,
      { method: 'POST', body },
      bindings,
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  it('preserves binary bytes and query while redacting credential headers', async () => {
    const session = await captureFixture(keys)
    const response = await exports.default.fetch(
      `https://play.example/capture/${session.captureToken}?a=%FF`,
      {
        method: 'POST',
        body: new Uint8Array([0, 255, 128, 10]),
        headers: {
          Authorization: 'secret',
          Cookie: 'secret',
          'Proxy-Authorization': 'secret',
          'Set-Cookie': 'secret',
          'X-Test': 'visible',
        },
      },
    )
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const [event] = await storedCaptures(session.eventsKey)
    expect(event).toMatchObject({
      version: 1,
      method: 'POST',
      query: '?a=%FF',
      body: { encoding: 'base64', data: 'AP+ACg==', byteLength: 4 },
    })
    expect(event.headers).toContainEqual(['x-test', 'visible'])
    expect(JSON.stringify(event)).not.toContain('secret')
    expect(JSON.stringify(event)).not.toContain(session.captureToken)
    expect(event.receivedAt).toBeGreaterThan(0)
    expect(event.id).toMatch(/^\d+-\d+$/)
  })

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
    'captures an empty %s request',
    async (method) => {
      const session = await captureFixture(keys)
      const response = await exports.default.fetch(
        `https://play.example/capture/${session.captureToken}`,
        { method },
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      const [event] = await storedCaptures(session.eventsKey)
      expect(event.method).toBe(method)
      expect(event.headers).toEqual([])
      expect(event.body).toEqual({
        encoding: 'base64',
        data: '',
        byteLength: 0,
      })
    },
  )

  it('persists the exact body-size boundary and rejects the next byte', async () => {
    const session = await captureFixture(keys)
    const url = `https://play.example/capture/${session.captureToken}`
    expect(
      (
        await app.request(
          url,
          { method: 'POST', body: new Uint8Array(65_536) },
          bindings,
        )
      ).status,
    ).toBe(204)
    const response = await app.request(
      url,
      { method: 'POST', body: new Uint8Array(65_537) },
      bindings,
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
    expect(await redisCommand(config, ['XLEN', session.eventsKey])).toBe(1)
  })

  it.each(['bad', 'A'.repeat(64), '0'.repeat(63)])(
    'rejects malformed capability %s before storage',
    async (token) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        `/capture/${token}`,
        { method: 'POST' },
        bindings,
      )
      expect(response.status).toBe(404)
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it('does not accept the read capability or session identifier for capture', async () => {
    const session = await captureFixture(keys)
    for (const token of [session.readToken, session.id, '0'.repeat(64)]) {
      const response = await app.request(
        `/capture/${token}`,
        { method: 'POST' },
        bindings,
      )
      expect(response.status).toBe(404)
    }
    expect(await redisCommand(config, ['EXISTS', session.eventsKey])).toBe(0)
  })

  it('rejects unsupported methods before storage and supplies Allow', async () => {
    const storage = vi.spyOn(globalThis, 'fetch')
    const response = await app.request(
      `/capture/${'0'.repeat(64)}`,
      { method: 'TRACE' },
      bindings,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toContain('OPTIONS')
    expect(storage).not.toHaveBeenCalled()
  })

  it('returns bodyless HEAD errors', async () => {
    const response = await exports.default.fetch(
      'https://play.example/capture/bad',
      { method: 'HEAD' },
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not retry or expose uncertain backend failures', async () => {
    const session = await captureFixture(keys)
    const original = globalThis.fetch.bind(globalThis)
    // Let Redis persist the append, then simulate losing its HTTP response.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const command = JSON.parse(init?.body as string)
        const response = await original(input, init)
        if (command[0] === 'EVAL' && command[2] === 4)
          throw new Error('private backend detail')
        return response
      })
    const response = await app.request(
      `/capture/${session.captureToken}`,
      { method: 'POST' },
      bindings,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
    expect(spy).toHaveBeenCalledTimes(3)
    spy.mockRestore()
    expect(await redisCommand(config, ['XLEN', session.eventsKey])).toBe(1)
  })
})
