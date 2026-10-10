import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { appendCapture, appendCaptureCommand } from '../src/capture-store'
import { authorizeRead } from '../src/read-auth'
import { readEventPage, readEventsCommand } from '../src/read-store'
import { redisCommand } from '../src/redis'
import {
  DEFAULT_SESSION_LIMITS,
  sessionLimitKey,
  sessionLimits,
} from '../src/session-limits'
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

async function counters(id: string) {
  const raw = await redisCommand(config, ['GET', sessionLimitKey(id)])
  return raw === null ? null : JSON.parse(raw as string)
}

function frozenTime(command: (string | number)[], time: number) {
  command[1] = String(command[1]).replace(
    "redis.call('TIME')",
    `({ '${time}', '0' })`,
  )
  return command
}

async function redisTime(): Promise<number> {
  const time = (await redisCommand(config, ['TIME'])) as string[]
  return Number(time[0])
}

describe('session limits against real Redis', () => {
  it.each(['capture', 'read'] as const)(
    'admits exactly the minute boundary under concurrent %s requests',
    async (route) => {
      const capture = await captureFixture(keys)
      const session = await authorizeRead(config, capture.id, capture.readToken)
      const limits = {
        ...DEFAULT_SESSION_LIMITS,
        capturePerMinute: 3,
        readPerMinute: 3,
      }
      const now = await redisTime()
      const results = await Promise.all(
        Array.from({ length: 20 }, () => {
          const command =
            route === 'capture'
              ? appendCaptureCommand(capture, emptyCapture, limits)
              : readEventsCommand(session, '0-0', false, limits)
          return redisCommand(config, frozenTime(command, now))
        }),
      )
      expect(
        results.filter(
          (result) => Array.isArray(result) && result[0] === 'rate_limited',
        ),
      ).toHaveLength(17)
      expect((await counters(capture.id))[route].total).toBe(3)
      expect(await redisCommand(config, ['XLEN', capture.eventsKey])).toBe(
        route === 'capture' ? 3 : 0,
      )
      expect(
        await redisCommand(config, ['EXPIRETIME', sessionLimitKey(capture.id)]),
      ).toBe(capture.expiresAt)
    },
  )

  it.each(['capture', 'read'] as const)(
    'enforces the %s lifetime boundary independently of minute limits',
    async (route) => {
      const capture = await captureFixture(keys)
      const session = await authorizeRead(config, capture.id, capture.readToken)
      const limits = {
        ...DEFAULT_SESSION_LIMITS,
        capturePerSession: 3,
        readPerSession: 3,
      }
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          route === 'capture'
            ? appendCapture(config, capture, emptyCapture, limits)
            : readEventPage(config, session, '0-0', false, limits),
        ),
      )
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(3)
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(17)
      expect((await counters(capture.id))[route].total).toBe(3)
    },
  )

  it('resets minute counts at UTC rollover while preserving lifetime totals and expiry', async () => {
    const capture = await captureFixture(keys)
    const limits = {
      ...DEFAULT_SESSION_LIMITS,
      capturePerMinute: 1,
      capturePerSession: 2,
    }
    const minute = Math.floor((await redisTime()) / 60) * 60
    const append = (time: number) =>
      redisCommand(
        config,
        frozenTime(appendCaptureCommand(capture, emptyCapture, limits), time),
      )
    expect(typeof (await append(minute + 59))).toBe('string')
    expect(await append(minute + 59)).toEqual(['rate_limited', 1])
    expect(typeof (await append(minute + 60))).toBe('string')
    expect(await append(minute + 120)).toEqual([
      'rate_limited',
      Number(capture.expiresAt) - minute - 120,
    ])
    expect((await counters(capture.id)).capture).toEqual({
      window: (minute + 60) / 60,
      minute: 1,
      total: 2,
    })
    expect(
      await redisCommand(config, ['EXPIRETIME', sessionLimitKey(capture.id)]),
    ).toBe(capture.expiresAt)
  })

  it('charges HEAD and future cursors without changing event storage', async () => {
    const capture = await captureFixture(keys)
    const session = await authorizeRead(config, capture.id, capture.readToken)
    await expect(readEventPage(config, session, '1-0')).rejects.toMatchObject({
      status: 400,
    })
    expect(await readEventPage(config, session, '0-0', true)).toBeNull()
    expect((await counters(capture.id)).read.total).toBe(2)
    expect((await counters(capture.id)).capture.total).toBe(0)
    expect(await redisCommand(config, ['EXISTS', capture.eventsKey])).toBe(0)
  })

  it('denies expired sessions before limits and never recreates counters', async () => {
    const capture = await captureFixture(keys)
    const session = await authorizeRead(config, capture.id, capture.readToken)
    await appendCapture(config, capture, emptyCapture)
    const raw = await redisCommand(config, ['GET', capture.metadataKey])
    await redisCommand(config, [
      'SET',
      capture.metadataKey,
      JSON.stringify({ ...JSON.parse(raw as string), expiresAt: 1 }),
      'KEEPTTL',
    ])
    await redisCommand(config, ['DEL', sessionLimitKey(capture.id)])
    expect(await appendCapture(config, capture, emptyCapture)).toBe(false)
    await expect(readEventPage(config, session, '0-0')).rejects.toMatchObject({
      status: 404,
    })
    expect(await counters(capture.id)).toBeNull()
  })

  it('keeps counters reserved when later capture storage fails', async () => {
    const capture = await captureFixture(keys)
    await redisCommand(config, [
      'SET',
      capture.eventsKey,
      'wrong-type',
      'EX',
      60,
    ])
    await expect(appendCapture(config, capture, emptyCapture)).rejects.toThrow()
    expect((await counters(capture.id)).capture.total).toBe(1)
    expect(
      await redisCommand(config, ['EXPIRETIME', sessionLimitKey(capture.id)]),
    ).toBe(capture.expiresAt)
  })

  it('leaves no partial counter or append when the atomic expiring SET fails', async () => {
    const capture = await captureFixture(keys)
    const command = appendCaptureCommand(capture, emptyCapture)
    command[1] = String(command[1]).replace(
      "'EXAT', expiresAt",
      "'INVALID_EXPIRY', expiresAt",
    )
    await expect(redisCommand(config, command)).rejects.toThrow()
    expect(await counters(capture.id)).toBeNull()
    expect(await redisCommand(config, ['EXISTS', capture.eventsKey])).toBe(0)
  })

  it('fails closed on corrupt counters without replacing them', async () => {
    const capture = await captureFixture(keys)
    await redisCommand(config, [
      'SET',
      sessionLimitKey(capture.id),
      '{"capture":false}',
      'EXAT',
      Number(capture.expiresAt),
    ])
    await expect(appendCapture(config, capture, emptyCapture)).rejects.toThrow()
    expect(await counters(capture.id)).toEqual({ capture: false })
    expect(await redisCommand(config, ['EXISTS', capture.eventsKey])).toBe(0)
  })

  it('preserves an existing allowance when the next expiring SET fails', async () => {
    const capture = await captureFixture(keys)
    await appendCapture(config, capture, emptyCapture)
    const before = await counters(capture.id)
    const command = appendCaptureCommand(capture, emptyCapture)
    command[1] = String(command[1]).replace(
      "'EXAT', expiresAt",
      "'INVALID_EXPIRY', expiresAt",
    )
    await expect(redisCommand(config, command)).rejects.toThrow()
    expect(await counters(capture.id)).toEqual(before)
    expect(await redisCommand(config, ['XLEN', capture.eventsKey])).toBe(1)
    expect(
      await redisCommand(config, ['EXPIRETIME', sessionLimitKey(capture.id)]),
    ).toBe(capture.expiresAt)
  })

  it.each(['false', 'null'])(
    'does not reset a corrupt %s counter record',
    async (raw) => {
      const capture = await captureFixture(keys)
      await redisCommand(config, [
        'SET',
        sessionLimitKey(capture.id),
        raw,
        'EXAT',
        Number(capture.expiresAt),
      ])
      await expect(
        appendCapture(config, capture, emptyCapture),
      ).rejects.toThrow()
      expect(
        await redisCommand(config, ['GET', sessionLimitKey(capture.id)]),
      ).toBe(raw)
    },
  )
})

describe('session limit HTTP behavior', () => {
  it.each(['capture', 'read'] as const)(
    'returns safe 429 and bodyless HEAD for exhausted %s allowance',
    async (route) => {
      const capture = await captureFixture(keys)
      const env = {
        ...bindings,
        CAPTURE_PER_SESSION: '1',
        READ_PER_SESSION: '1',
      }
      const path =
        route === 'capture'
          ? `/capture/${capture.captureToken}`
          : `/sessions/${capture.id}/events`
      const headers = { Authorization: `Bearer ${capture.readToken}` }
      expect((await app.request(path, { headers }, env)).status).toBe(
        route === 'capture' ? 204 : 200,
      )
      const response = await app.request(path, { headers }, env)
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'rate_limited' })
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
      expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(
        3600,
      )
      const head = await app.request(path, { method: 'HEAD', headers }, env)
      expect(head.status).toBe(429)
      expect(await head.text()).toBe('')
    },
  )

  it('does not create counters for unknown capabilities or charge wrong read credentials', async () => {
    const capture = await captureFixture(keys)
    const read = await app.request(
      `/sessions/${capture.id}/events`,
      { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } },
      bindings,
    )
    expect(read.status).toBe(404)
    const unknown = await app.request(
      `/capture/${'0'.repeat(64)}`,
      {},
      bindings,
    )
    expect(unknown.status).toBe(404)
    expect(await counters(capture.id)).toBeNull()
  })

  it.each(['0', '-1', '01', '1.5', '1000001', ' true ', ''])(
    'rejects invalid limit %j before Redis',
    async (value) => {
      expect(() => sessionLimits({ READ_PER_MINUTE: value })).toThrow()
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        `/capture/${'a'.repeat(64)}`,
        {},
        { ...bindings, CAPTURE_PER_MINUTE: value },
      )
      expect(response.status).toBe(503)
      expect(storage).not.toHaveBeenCalled()
    },
  )
})
