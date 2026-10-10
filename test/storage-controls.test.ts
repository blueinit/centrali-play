import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import type { Bindings } from '../src/config'

const capturePath = `/capture/${'a'.repeat(64)}`
const readPath = `/sessions/${'a'.repeat(32)}/events`

afterEach(() => vi.restoreAllMocks())

describe('operator shutdown controls', () => {
  it.each([
    ['POST', '/sessions'],
    ['POST', capturePath],
    ['GET', readPath],
    ['HEAD', capturePath],
    ['HEAD', readPath],
    ['OPTIONS', capturePath],
  ])('stops %s %s before storage access', async (method, path) => {
    const storage = vi.spyOn(globalThis, 'fetch')
    const response = await app.request(
      path,
      { method },
      {
        DISABLE_STORAGE_ROUTES: 'true',
      },
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    if (method === 'HEAD') expect(await response.text()).toBe('')
    else expect(await response.json()).toEqual({ error: 'service_unavailable' })
    expect(storage).not.toHaveBeenCalled()
  })

  it.each(['DISABLE_STORAGE_ROUTES', 'DISABLE_SESSION_CREATION'] as const)(
    '%s stops creation without touching a request body',
    async (switchName) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const request = new Request('https://play.example/sessions', {
        method: 'POST',
        body: 'must not be read',
      })
      const response = await app.fetch(request, { [switchName]: 'true' })
      expect(response.status).toBe(503)
      expect(request.bodyUsed).toBe(false)
      expect(request.body?.locked).toBe(false)
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it('stops capture before touching its body', async () => {
    const request = new Request(`https://play.example${capturePath}`, {
      method: 'POST',
      body: 'must not be read',
    })
    const storage = vi.spyOn(globalThis, 'fetch')
    const response = await app.fetch(request, {
      DISABLE_STORAGE_ROUTES: 'true',
    })
    expect(response.status).toBe(503)
    expect(request.bodyUsed).toBe(false)
    expect(request.body?.locked).toBe(false)
    expect(storage).not.toHaveBeenCalled()
  })

  it.each(['', 'TRUE', '1', ' false ', 'no'])(
    'fails closed for malformed switch %j on every storage route',
    async (value) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      for (const switchName of [
        'DISABLE_STORAGE_ROUTES',
        'DISABLE_SESSION_CREATION',
      ]) {
        for (const [method, path] of [
          ['POST', '/sessions'],
          ['POST', capturePath],
          ['GET', readPath],
        ] as const) {
          const response = await app.request(
            path,
            { method },
            { [switchName]: value },
          )
          expect(response.status).toBe(503)
          expect(await response.json()).toEqual({
            error: 'service_unavailable',
          })
        }
      }
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it.each([
    {},
    { DISABLE_STORAGE_ROUTES: 'false', DISABLE_SESSION_CREATION: 'false' },
    { DISABLE_SESSION_CREATION: 'true' },
  ] satisfies Bindings[])(
    'preserves capture/read validation when those routes are enabled: %j',
    async (bindings) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const capture = await app.request(
        '/capture/invalid',
        { method: 'POST' },
        bindings,
      )
      const read = await app.request(readPath, {}, bindings)
      expect(capture.status).toBe(404)
      expect(read.status).toBe(401)
      expect(capture.headers.get('Retry-After')).toBeNull()
      expect(read.headers.get('Retry-After')).toBeNull()
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it('does not accept request-selected switches', async () => {
    const response = await app.request(
      '/sessions?DISABLE_STORAGE_ROUTES=false',
      {
        method: 'POST',
        headers: { DISABLE_STORAGE_ROUTES: 'false' },
      },
      { DISABLE_STORAGE_ROUTES: 'true' },
    )
    expect(response.status).toBe(503)
  })

  it('keeps capture and read storage available while creation is paused', async () => {
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const command = JSON.parse(init?.body as string)
        return Response.json({
          result: command[0] === 'EVAL' ? ['reserved'] : null,
        })
      })
    const bindings: Bindings = {
      PUBLIC_BASE_URL: 'https://play.example',
      UPSTASH_REDIS_REST_URL: 'https://redis.example',
      UPSTASH_REDIS_REST_TOKEN: 'synthetic-test-token',
      DISABLE_SESSION_CREATION: 'true',
    }
    const creation = await app.request(
      '/sessions',
      { method: 'POST' },
      bindings,
    )
    expect(creation.status).toBe(503)
    expect(storage).not.toHaveBeenCalled()
    const capture = await app.request(capturePath, { method: 'POST' }, bindings)
    const read = await app.request(
      readPath,
      {
        headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
      },
      bindings,
    )
    // The fake backend reports unknown sessions; both lookups must still run.
    expect(capture.status).toBe(404)
    expect(read.status).toBe(404)
    expect(storage).toHaveBeenCalledTimes(4)
  })

  it.each(['true', 'invalid'])(
    'keeps health and unknown routes independent of switches: %s',
    async (value) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const bindings = { DISABLE_STORAGE_ROUTES: value }
      const health = await app.request('/health', {}, bindings)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: 'ok' })
      const unknown = await app.request('/unknown', {}, bindings)
      expect(unknown.status).toBe(404)
      const unsupportedCreation = await app.request('/sessions', {}, bindings)
      expect(unsupportedCreation.status).toBe(404)
      expect(storage).not.toHaveBeenCalled()
    },
  )
})
