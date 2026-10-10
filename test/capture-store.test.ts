import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCapture,
  appendCaptureCommand,
  findCaptureSession,
} from '../src/capture-store'
import { redisCommand } from '../src/redis'
import { DEFAULT_SESSION_LIMITS, sessionLimitKey } from '../src/session-limits'
import {
  captureFixture,
  config,
  emptyCapture,
  storedCaptures,
} from './capture-fixture'

const keys: string[] = []
afterEach(async () => {
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

describe('atomic capture storage against real Redis', () => {
  it('expires captured events together with both session keys', async () => {
    const session = await captureFixture(keys, 2)
    expect(await appendCapture(config, session, emptyCapture)).toBe(true)
    await expect
      .poll(
        () =>
          redisCommand(config, [
            'EXISTS',
            session.eventsKey,
            session.metadataKey,
            session.lookupKey,
            sessionLimitKey(session.id),
          ]),
        { timeout: 4_000, interval: 100 },
      )
      .toBe(0)
  })

  it('keeps exactly 50 events after concurrent appends, all with the original deadline', async () => {
    const session = await captureFixture(keys)
    const results = await Promise.all(
      Array.from({ length: 70 }, () =>
        appendCapture(config, session, emptyCapture, {
          ...DEFAULT_SESSION_LIMITS,
          capturePerMinute: 100,
        }),
      ),
    )
    expect(results.every(Boolean)).toBe(true)
    expect(await redisCommand(config, ['XLEN', session.eventsKey])).toBe(50)
    expect(await redisCommand(config, ['EXPIRETIME', session.eventsKey])).toBe(
      session.expiresAt,
    )
    expect(
      await redisCommand(config, ['EXPIRETIME', session.metadataKey]),
    ).toBe(session.expiresAt)
    const events = await storedCaptures(session.eventsKey)
    expect(new Set(events.map((event) => event.id)).size).toBe(50)
  })

  it('retains the latest events in append order rather than approximate trimming', async () => {
    const session = await captureFixture(keys)
    for (let i = 0; i < 52; i++)
      await appendCapture(config, session, {
        ...emptyCapture,
        query: `?n=${i}`,
      })
    const events = await storedCaptures(session.eventsKey)
    expect(events).toHaveLength(50)
    expect(events[0].query).toBe('?n=2')
    expect(events.at(-1).query).toBe('?n=51')
  })

  it('does not recreate storage when expiry occurs after the initial lookup', async () => {
    const fixture = await captureFixture(keys, 2)
    const session = await findCaptureSession(config, fixture.captureHash)
    expect(session).not.toBeNull()
    await expect
      .poll(() => redisCommand(config, ['EXISTS', fixture.metadataKey]), {
        timeout: 4_000,
        interval: 100,
      })
      .toBe(0)
    expect(await appendCapture(config, session!, emptyCapture)).toBe(false)
    expect(await redisCommand(config, ['EXISTS', fixture.eventsKey])).toBe(0)
  })

  it('denies a logically expired session even if metadata remains physically present', async () => {
    const session = await captureFixture(keys)
    const raw = await redisCommand(config, ['GET', session.metadataKey])
    const metadata = { ...JSON.parse(raw as string), expiresAt: 1 }
    await redisCommand(config, [
      'SET',
      session.metadataKey,
      JSON.stringify(metadata),
      'KEEPTTL',
    ])
    expect(await findCaptureSession(config, session.captureHash)).toBeNull()
    expect(await appendCapture(config, session, emptyCapture)).toBe(false)
    expect(await redisCommand(config, ['EXISTS', session.eventsKey])).toBe(0)
  })

  it('fails safely on an incompatible event key without disturbing its expiry', async () => {
    const session = await captureFixture(keys)
    await redisCommand(config, ['SET', session.eventsKey, 'existing', 'EX', 60])
    const expiry = await redisCommand(config, ['EXPIRETIME', session.eventsKey])
    await expect(appendCapture(config, session, emptyCapture)).rejects.toThrow()
    expect(await redisCommand(config, ['GET', session.eventsKey])).toBe(
      'existing',
    )
    expect(await redisCommand(config, ['EXPIRETIME', session.eventsKey])).toBe(
      expiry,
    )
  })

  it('removes partial capture storage when expiry attachment fails', async () => {
    const session = await captureFixture(keys)
    const command = appendCaptureCommand(session, emptyCapture)
    // Inject a Redis command error after XADD, exercising the real script cleanup path.
    command[1] = String(command[1]).replace(
      "redis.pcall('EXPIREAT'",
      "redis.pcall('INVALID_EXPIRY_COMMAND'",
    )
    await expect(redisCommand(config, command)).rejects.toThrow()
    expect(await redisCommand(config, ['EXISTS', session.eventsKey])).toBe(0)
    expect(
      await redisCommand(config, [
        'EXISTS',
        session.metadataKey,
        session.lookupKey,
      ]),
    ).toBe(2)
  })
})
