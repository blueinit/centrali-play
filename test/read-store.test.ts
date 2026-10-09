import { afterEach, describe, expect, it } from 'vitest'
import { authorizeRead } from '../src/read-auth'
import { readEventPage } from '../src/read-store'
import { appendCapture } from '../src/capture-store'
import { redisCommand } from '../src/redis'
import { captureFixture, config, emptyCapture } from './capture-fixture'

const keys: string[] = []
afterEach(async () => {
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

async function fixture(lifetime = 3_600) {
  const capture = await captureFixture(keys, lifetime)
  const session = await authorizeRead(config, capture.id, capture.readToken)
  return { capture, session }
}

describe('read pages against real Redis', () => {
  it('compares Redis cursor IDs precisely above the JavaScript safe-integer range', async () => {
    const { capture, session } = await fixture()
    const first = '9007199254740992-0'
    const second = '9007199254740993-0'
    const fields = [
      'event',
      JSON.stringify(emptyCapture),
      'receivedAt',
      '1700000000000',
    ]
    await redisCommand(config, ['XADD', capture.eventsKey, first, ...fields])
    await redisCommand(config, [
      'EXPIREAT',
      capture.eventsKey,
      Number(capture.expiresAt),
    ])
    await expect(readEventPage(config, session, second)).rejects.toMatchObject({
      status: 400,
    })
    await redisCommand(config, ['XADD', capture.eventsKey, second, ...fields])
    const page = (await readEventPage(config, session, first))!
    expect(page.events.map((event) => event.id)).toEqual([second])
    expect(page.nextCursor).toBe(second)
  })

  it('returns empty pages without creating a stream or refreshing the deadline', async () => {
    const { capture, session } = await fixture()
    const page = await readEventPage(config, session, '0-0')
    expect(page).toEqual({
      events: [],
      nextCursor: '0-0',
      hasMore: false,
      cursorBehindRetention: false,
      expiresAt: new Date(Number(capture.expiresAt) * 1000).toISOString(),
    })
    expect(await redisCommand(config, ['EXISTS', capture.eventsKey])).toBe(0)
    expect(
      await redisCommand(config, ['EXPIRETIME', capture.metadataKey]),
    ).toBe(capture.expiresAt)
  })

  it('paginates exclusively and preserves the cursor when caught up', async () => {
    const { capture, session } = await fixture()
    for (let i = 0; i < 12; i++)
      await appendCapture(config, capture, {
        ...emptyCapture,
        query: `?n=${i}`,
      })
    const first = (await readEventPage(config, session, '0-0'))!
    expect(first.events).toHaveLength(10)
    expect(first.hasMore).toBe(true)
    const second = (await readEventPage(config, session, first.nextCursor))!
    expect(second.events.map((event) => event.query)).toEqual([
      '?n=10',
      '?n=11',
    ])
    expect(second.hasMore).toBe(false)
    const empty = (await readEventPage(config, session, second.nextCursor))!
    expect(empty.events).toEqual([])
    expect(empty.nextCursor).toBe(second.nextCursor)
    expect(await redisCommand(config, ['EXPIRETIME', capture.eventsKey])).toBe(
      capture.expiresAt,
    )
  })

  it('warns when a nonzero cursor falls behind retained events', async () => {
    const { capture, session } = await fixture()
    await appendCapture(config, capture, emptyCapture)
    const first = (await readEventPage(config, session, '0-0'))!
    for (let i = 0; i < 51; i++)
      await appendCapture(config, capture, emptyCapture)
    expect(
      (await readEventPage(config, session, first.nextCursor))!
        .cursorBehindRetention,
    ).toBe(true)
    expect(
      (await readEventPage(config, session, '0-0'))!.cursorBehindRetention,
    ).toBe(false)
  })

  it('rechecks expiry after authorization before returning captures', async () => {
    const { capture, session } = await fixture(2)
    await appendCapture(config, capture, emptyCapture)
    await expect
      .poll(() => redisCommand(config, ['EXISTS', capture.metadataKey]), {
        timeout: 4_000,
        interval: 100,
      })
      .toBe(0)
    await expect(readEventPage(config, session, '0-0')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('denies logically expired metadata before physical cleanup', async () => {
    const { capture, session } = await fixture()
    await appendCapture(config, capture, emptyCapture)
    const raw = await redisCommand(config, ['GET', capture.metadataKey])
    await redisCommand(config, [
      'SET',
      capture.metadataKey,
      JSON.stringify({ ...JSON.parse(raw as string), expiresAt: 1 }),
      'KEEPTTL',
    ])
    await expect(readEventPage(config, session, '0-0')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('rechecks the authorized digest if metadata changes before selection', async () => {
    const { capture, session } = await fixture()
    const raw = await redisCommand(config, ['GET', capture.metadataKey])
    await redisCommand(config, [
      'SET',
      capture.metadataKey,
      JSON.stringify({
        ...JSON.parse(raw as string),
        readTokenHash: '0'.repeat(64),
      }),
      'KEEPTTL',
    ])
    await expect(readEventPage(config, session, '0-0')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('reads a consistent ordered page during concurrent appends', async () => {
    const { capture, session } = await fixture()
    await appendCapture(config, capture, emptyCapture)
    const [page] = await Promise.all([
      readEventPage(config, session, '0-0'),
      Promise.all(
        Array.from({ length: 30 }, () =>
          appendCapture(config, capture, emptyCapture),
        ),
      ),
    ])
    expect(page!.events.length).toBeGreaterThan(0)
    expect(page!.events.length).toBeLessThanOrEqual(10)
    if (page!.hasMore) expect(page!.events).toHaveLength(10)
    expect(page!.nextCursor).toBe(page!.events.at(-1)!.id)
    expect(new Set(page!.events.map((event) => event.id)).size).toBe(
      page!.events.length,
    )
  })

  it('rejects future cursors including unsigned 64-bit values beyond floating-point precision', async () => {
    const { capture, session } = await fixture()
    await expect(readEventPage(config, session, '1-0')).rejects.toMatchObject({
      status: 400,
    })
    await appendCapture(config, capture, emptyCapture)
    await expect(
      readEventPage(config, session, '18446744073709551615-0'),
    ).rejects.toMatchObject({ status: 400 })
  })
})
