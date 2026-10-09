import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bindings } from '../src/config'
import { sessionConfig } from '../src/config'
import { redisCommand } from '../src/redis'
import { createSessionCommand, sessionKeys } from '../src/session-store'

const config = sessionConfig(env as Bindings)
const keys: string[] = []

function command(lifetime = 3_600) {
  const id = crypto.randomUUID()
  const captureHash = crypto.randomUUID()
  const readHash = crypto.randomUUID()
  keys.push(...sessionKeys(id, captureHash))
  return createSessionCommand(id, captureHash, readHash, lifetime)
}

afterEach(async () => {
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

describe('atomic creation against real Redis', () => {
  it('allows only one winner when concurrent requests use the same keys', async () => {
    const create = command()
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => redisCommand(config, create)),
    )
    expect(outcomes.filter((value) => value === 0)).toHaveLength(19)
    expect(
      outcomes.filter((value) => typeof value === 'number' && value > 0),
    ).toHaveLength(1)
    expect(
      await redisCommand(config, [
        'EXISTS',
        String(create[3]),
        String(create[4]),
      ]),
    ).toBe(2)
  })

  it.each([3, 4])(
    'does not overwrite an existing key at position %s',
    async (position) => {
      const create = command()
      const occupied = String(create[position])
      const other = String(create[position === 3 ? 4 : 3])
      await redisCommand(config, ['SET', occupied, 'existing', 'EX', 60])
      const before = await redisCommand(config, ['EXPIRETIME', occupied])
      expect(await redisCommand(config, create)).toBe(0)
      expect(await redisCommand(config, ['GET', occupied])).toBe('existing')
      expect(await redisCommand(config, ['EXPIRETIME', occupied])).toBe(before)
      expect(await redisCommand(config, ['EXISTS', other])).toBe(0)
    },
  )

  it('expires metadata and capture lookup without an event or cleanup job', async () => {
    const create = command(2)
    const expiresAt = await redisCommand(config, create)
    const sessionKey = String(create[3])
    const lookupKey = String(create[4])
    expect(await redisCommand(config, ['EXPIRETIME', sessionKey])).toBe(
      expiresAt,
    )
    expect(await redisCommand(config, ['EXPIRETIME', lookupKey])).toBe(
      expiresAt,
    )

    await expect
      .poll(
        async () => redisCommand(config, ['EXISTS', sessionKey, lookupKey]),
        {
          timeout: 4_000,
          interval: 100,
        },
      )
      .toBe(0)
  })

  it('rejects invalid lifetime before writing any key', async () => {
    const create = command(-1)
    await expect(redisCommand(config, create)).rejects.toThrow()
    expect(
      await redisCommand(config, [
        'EXISTS',
        String(create[3]),
        String(create[4]),
      ]),
    ).toBe(0)
  })
})
