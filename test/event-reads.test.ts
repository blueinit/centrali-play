import { exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { appendCapture } from '../src/capture-store'
import { readEventsCommand } from '../src/read-store'
import type { EventPage } from '../src/read-store'
import { authorizeRead } from '../src/read-auth'
import { sessionKeys } from '../src/session-store'
import { tokenDigest } from '../src/tokens'
import { eventKey } from '../src/capture-store'
import { sessionLimitKey } from '../src/session-limits'
import { redisCommand } from '../src/redis'
import {
  bindings,
  captureFixture,
  config,
  emptyCapture,
} from './capture-fixture'

const keys: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

function read(id: string, token: string, query = '', method = 'GET') {
  return app.request(
    `/sessions/${id}/events${query}`,
    { method, headers: { Authorization: `Bearer ${token}` } },
    bindings,
  )
}

describe('event-read HTTP contract', () => {
  it('creates, captures, and reads through the Worker API', async () => {
    const created = await exports.default.fetch(
      'https://play.example/sessions',
      { method: 'POST' },
    )
    expect(created.status).toBe(201)
    const session = await created.json<{
      id: string
      captureUrl: string
      readToken: string
    }>()
    const token = session.captureUrl.split('/').at(-1)!
    keys.push(
      ...sessionKeys(session.id, await tokenDigest(token)),
      eventKey(session.id),
      sessionLimitKey(session.id),
    )
    const captured = await exports.default.fetch(session.captureUrl, {
      method: 'POST',
      body: 'hello',
    })
    expect(captured.status).toBe(204)
    const response = await read(session.id, session.readToken)
    expect(response.status).toBe(200)
    const page = await response.json<EventPage>()
    expect(page.events[0]!.body).toEqual({
      encoding: 'base64',
      data: 'aGVsbG8=',
      byteLength: 5,
    })
  })

  it('returns safe JSON headers and the stored binary event shape', async () => {
    const capture = await captureFixture(keys)
    await appendCapture(config, capture, {
      ...emptyCapture,
      body: { encoding: 'base64', data: 'AP8=', byteLength: 2 },
    })
    const response = await exports.default.fetch(
      `https://play.example/sessions/${capture.id}/events`,
      { headers: { Authorization: `Bearer ${capture.readToken}` } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const page = await response.json<EventPage>()
    expect(page.events[0]).toMatchObject({
      ...emptyCapture,
      body: { encoding: 'base64', data: 'AP8=', byteLength: 2 },
    })
    expect(page.nextCursor).toBe(page.events[0]!.id)
    expect(JSON.stringify(page)).not.toContain(capture.readToken)
    expect(JSON.stringify(page)).not.toContain(capture.captureHash)
  })

  it('uses the Worker timing-safe primitive for digest verification', async () => {
    const capture = await captureFixture(keys)
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual')
    expect((await read(capture.id, capture.readToken)).status).toBe(200)
    expect(compare).toHaveBeenCalledOnce()
    expect(compare.mock.calls[0]![0]).toHaveLength(32)
    expect(compare.mock.calls[0]![1]).toHaveLength(32)
  })

  it("denies capture capabilities and another session's read capability", async () => {
    const capture = await captureFixture(keys)
    const other = await captureFixture(keys)
    for (const token of [
      capture.captureToken,
      other.readToken,
      '0'.repeat(64),
    ]) {
      const response = await read(capture.id, token)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
  })

  it.each([
    '',
    'Basic secret',
    `Bearer ${'A'.repeat(64)}`,
    `Bearer ${'a'.repeat(64)}, Bearer ${'b'.repeat(64)}`,
  ])('rejects malformed credentials before storage', async (authorization) => {
    const storage = vi.spyOn(globalThis, 'fetch')
    const response = await app.request(
      `/sessions/${'a'.repeat(32)}/events`,
      { headers: { Authorization: authorization } },
      bindings,
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="play"')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(storage).not.toHaveBeenCalled()
  })

  it.each([
    '?after=',
    '?after=01-0',
    '?after=0-0&after=1-0',
    '?readToken=secret',
  ])('rejects malformed query before storage', async (query) => {
    const storage = vi.spyOn(globalThis, 'fetch')
    expect((await read('a'.repeat(32), 'b'.repeat(64), query)).status).toBe(400)
    expect(storage).not.toHaveBeenCalled()
  })

  it('returns a uniform 404 for unknown sessions and malformed IDs', async () => {
    for (const id of ['bad', '0'.repeat(32)]) {
      const response = await read(id, 'a'.repeat(64))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
  })

  it('returns HEAD status without transferring event payloads', async () => {
    const capture = await captureFixture(keys)
    await appendCapture(config, capture, emptyCapture)
    const response = await exports.default.fetch(
      `https://play.example/sessions/${capture.id}/events`,
      {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${capture.readToken}` },
      },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const session = await authorizeRead(config, capture.id, capture.readToken)
    expect(
      await redisCommand(config, readEventsCommand(session, '0-0', true)),
    ).toEqual(['head', capture.expiresAt])
  })

  it('returns bodyless HEAD authorization errors', async () => {
    const response = await app.request(
      `/sessions/${'a'.repeat(32)}/events`,
      { method: 'HEAD' },
      bindings,
    )
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('')
  })

  it.each(['POST', 'OPTIONS'])(
    'rejects %s without CORS or database access',
    async (method) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await read('a'.repeat(32), 'b'.repeat(64), '', method)
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET, HEAD')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(storage).not.toHaveBeenCalled()
    },
  )

  it('returns invalid_cursor after authorization for a nonzero cursor on an empty stream', async () => {
    const capture = await captureFixture(keys)
    const response = await read(capture.id, capture.readToken, '?after=1-0')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_cursor' })
  })

  it('pages the largest accepted captures within both response bounds', async () => {
    const capture = await captureFixture(keys)
    const input = {
      ...emptyCapture,
      query: `?${'q'.repeat(4_095)}`,
      headers: [['x', '<'.repeat(16_383)]] as [string, string][],
      body: {
        encoding: 'base64' as const,
        data: btoa('\x00'.repeat(65_536)),
        byteLength: 65_536,
      },
    }
    await appendCapture(config, capture, input)
    await appendCapture(config, capture, input)
    const response = await read(capture.id, capture.readToken)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      262_144,
    )
    const first: EventPage = JSON.parse(text)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]!.body).toEqual(input.body)
    expect(first.hasMore).toBe(true)
    const second = await read(
      capture.id,
      capture.readToken,
      `?after=${first.nextCursor}`,
    )
    const page = await second.json<EventPage>()
    expect(page.events).toHaveLength(1)
    expect(page.hasMore).toBe(false)
  })

  it('fails safely on corrupt stored data rather than returning a partial page', async () => {
    const capture = await captureFixture(keys)
    await appendCapture(config, capture, emptyCapture)
    await redisCommand(config, [
      'XADD',
      capture.eventsKey,
      '*',
      'event',
      JSON.stringify({ ...emptyCapture, readToken: 'secret' }),
      'receivedAt',
      '1',
    ])
    const response = await read(capture.id, capture.readToken)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
  })

  it.each(['network', 'oversized', 'malformed'])(
    'hides %s read backend failures without retrying',
    async (failure) => {
      const capture = await captureFixture(keys)
      const original = globalThis.fetch.bind(globalThis)
      const storage = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url, init) => {
          const command = JSON.parse(init?.body as string)
          if (command[0] !== 'EVAL') return original(url, init)
          if (failure === 'network') throw new Error('private storage detail')
          if (failure === 'oversized') return new Response('x'.repeat(262_145))
          return Response.json({
            result: ['ok', 1, 0, 0, 'private storage detail'],
          })
        })
      const response = await read(capture.id, capture.readToken)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'service_unavailable' })
      expect(storage).toHaveBeenCalledTimes(2)
    },
  )
})
