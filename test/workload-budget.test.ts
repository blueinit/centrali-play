import { afterEach, describe, expect, it, vi } from 'vitest'
import { redisCommand } from '../src/redis'
import {
  reserveWorkload,
  workloadBudget,
  WorkloadBudgetError,
  workloadReservationCommand,
} from '../src/workload-budget'
import { config } from './capture-fixture'

const keys: string[] = []
const cost = { units: 64, bytes: 384 * 1024 }
afterEach(async () => {
  vi.restoreAllMocks()
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

function policy(units = 200_000, bytes = 2 * 1024 ** 3) {
  const budget = workloadBudget(`test-${crypto.randomUUID()}`, units, bytes)
  keys.push(budget.key)
  return budget
}

function frozen(command: (string | number)[], now: number) {
  command[1] = String(command[1]).replace(
    "redis.call('TIME')",
    `({ '${now}', '0' })`,
  )
  return command
}

async function raw(key: string) {
  return redisCommand(config, ['GET', key])
}

describe('monthly workload reservations against real Redis', () => {
  it.each(['units', 'bytes'] as const)(
    'atomically enforces the %s cap across independent instances',
    async (guard) => {
      const budget = policy(
        guard === 'units' ? cost.units * 3 : 200_000,
        guard === 'bytes' ? cost.bytes * 3 : 2 * 1024 ** 3,
      )
      const replies = await Promise.all(
        Array.from({ length: 20 }, () =>
          redisCommand(config, workloadReservationCommand(budget, cost)),
        ),
      )
      expect(
        replies.filter((r) => Array.isArray(r) && r[0] === 'reserved'),
      ).toHaveLength(3)
      expect(
        replies.filter((r) => Array.isArray(r) && r[0] === 'budget_denied'),
      ).toHaveLength(17)
      expect(JSON.parse((await raw(budget.key)) as string)).toMatchObject({
        units: cost.units * 3,
        bytes: cost.bytes * 3,
      })
      const command = workloadReservationCommand(budget, cost)
      expect(await redisCommand(config, ['EXPIRETIME', budget.key])).toBe(
        Number(command[5]) + 60,
      )
    },
  )

  it('denies without partially reserving either allowance or creating a record', async () => {
    const budget = policy(cost.units, cost.bytes - 1)
    expect(
      await redisCommand(config, workloadReservationCommand(budget, cost)),
    ).toEqual(['budget_denied', 60])
    expect(await raw(budget.key)).toBeNull()
    await reserveWorkload(config, budget, { ...cost, bytes: 1 })
    const before = await raw(budget.key)
    expect(
      await redisCommand(config, workloadReservationCommand(budget, cost)),
    ).toEqual(['budget_denied', 60])
    expect(await raw(budget.key)).toBe(before)
  })

  it.each([
    ['2030-03-01T00:00:00Z', 28],
    ['2032-03-01T00:00:00Z', 29],
    ['2030-05-01T00:00:00Z', 30],
    ['2031-01-01T00:00:00Z', 31],
  ])('rolls over at %s, after a %i-day month', async (date, days) => {
    const boundary = Date.parse(date) / 1000
    const budget = policy(cost.units, cost.bytes)
    const before = workloadReservationCommand(budget, cost, boundary - 1)
    expect(Number(before[5]) - Number(before[4])).toBe(Number(days) * 86400)
    expect(await redisCommand(config, frozen(before, boundary - 1))).toEqual([
      'reserved',
    ])
    expect(
      await redisCommand(
        config,
        frozen(
          workloadReservationCommand(budget, cost, boundary - 1),
          boundary - 1,
        ),
      ),
    ).toEqual(['budget_denied', 1])
    expect(
      await redisCommand(
        config,
        frozen(workloadReservationCommand(budget, cost, boundary), boundary),
      ),
    ).toEqual(['reserved'])
    expect(JSON.parse((await raw(budget.key)) as string)).toEqual({
      start: boundary,
      units: cost.units,
      bytes: cost.bytes,
    })
    const next = workloadReservationCommand(budget, cost, boundary)
    expect(await redisCommand(config, ['EXPIRETIME', budget.key])).toBe(
      Number(next[5]) + 60,
    )
  })

  it('makes no mutation when the proposed month disagrees with Redis time', async () => {
    const budget = policy()
    const time = (await redisCommand(config, ['TIME'])) as string[]
    const result = await redisCommand(
      config,
      workloadReservationCommand(
        budget,
        cost,
        Date.parse('2030-01-01T00:00:00Z') / 1000,
      ),
    )
    expect(result).toEqual(['window_changed', expect.any(Number)])
    expect((result as number[])[1]).toBeGreaterThanOrEqual(Number(time[0]))
    expect(await raw(budget.key)).toBeNull()
  })

  it('corrects a skewed application clock only after confirmed non-mutation', async () => {
    const budget = policy()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    await reserveWorkload(config, budget, cost)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await raw(budget.key)) as string)).toMatchObject(cost)
  })

  it.each([
    'false',
    'null',
    '{}',
    '{"start":1,"units":-1,"bytes":0}',
    'x'.repeat(257),
  ])(
    'fails closed on corrupt state without overwriting it: %s',
    async (value) => {
      const budget = policy()
      await redisCommand(config, ['SET', budget.key, value, 'EX', 60])
      await expect(reserveWorkload(config, budget, cost)).rejects.toThrow()
      expect(await raw(budget.key)).toBe(value)
    },
  )

  it('fails closed on future counter windows', async () => {
    const budget = policy()
    const command = workloadReservationCommand(budget, cost)
    const value = JSON.stringify({
      start: Number(command[5]),
      units: 0,
      bytes: 0,
    })
    await redisCommand(config, ['SET', budget.key, value, 'EX', 60])
    await expect(reserveWorkload(config, budget, cost)).rejects.toThrow()
    expect(await raw(budget.key)).toBe(value)
  })

  it('leaves the old record and expiry intact when atomic SET fails', async () => {
    const budget = policy()
    await reserveWorkload(config, budget, cost)
    const before = await raw(budget.key)
    const expiry = await redisCommand(config, ['EXPIRETIME', budget.key])
    const command = workloadReservationCommand(budget, cost)
    command[1] = String(command[1]).replace(
      "redis.call('SET'",
      "redis.call('INVALID_COMMAND'",
    )
    await expect(redisCommand(config, command)).rejects.toThrow()
    expect(await raw(budget.key)).toBe(before)
    expect(await redisCommand(config, ['EXPIRETIME', budget.key])).toBe(expiry)
  })

  it('retains the reservation after a lost response without replaying', async () => {
    const budget = policy()
    const original = globalThis.fetch.bind(globalThis)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        await original(url, init)
        throw new Error('Synthetic lost response')
      })
    await expect(reserveWorkload(config, budget, cost)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockRestore()
    expect(JSON.parse((await raw(budget.key)) as string)).toMatchObject(cost)
  })

  it('returns a safe bounded retry delay on exhaustion', async () => {
    const budget = policy(cost.units, cost.bytes)
    await reserveWorkload(config, budget, cost)
    await expect(reserveWorkload(config, budget, cost)).rejects.toMatchObject({
      message: 'service_unavailable',
      retryAfter: 60,
    })
    await expect(reserveWorkload(config, budget, cost)).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
  })
})

describe('operator budget changes', () => {
  it('retains spent totals when operators raise or lower limits', async () => {
    const budget = policy(cost.units, cost.bytes)
    await reserveWorkload(config, budget, cost)
    await reserveWorkload(
      config,
      {
        ...budget,
        unitsPerMonth: cost.units * 2,
        bytesPerMonth: cost.bytes * 2,
      },
      cost,
    )
    const before = await raw(budget.key)
    await expect(reserveWorkload(config, budget, cost)).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    expect(await raw(budget.key)).toBe(before)
    expect(JSON.parse(before as string)).toMatchObject({
      units: cost.units * 2,
      bytes: cost.bytes * 2,
    })
  })
})

describe('workload protocol validation', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 1_000_000_000_001])(
    'rejects invalid limits and weights: %s',
    (value) => {
      expect(() => workloadBudget('test', value)).toThrow()
      expect(() => workloadBudget('test', 1, value)).toThrow()
      expect(() =>
        workloadReservationCommand(workloadBudget('test'), {
          units: value,
          bytes: 1,
        }),
      ).toThrow()
      expect(() =>
        workloadReservationCommand(workloadBudget('test'), {
          units: 1,
          bytes: value,
        }),
      ).toThrow()
    },
  )

  it.each(['', 'UPPER', 'a:b', 'x'.repeat(65)])(
    'rejects invalid scopes: %j',
    (scope) => {
      expect(() => workloadBudget(scope)).toThrow()
    },
  )

  it.each([
    [null],
    [[]],
    [['reserved', 1]],
    [['budget_denied', 0]],
    [['budget_denied', 61]],
    [['window_changed', -1]],
    [['unknown', 1]],
  ])('fails closed on invalid replies: %j', async (reply) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ result: reply })))
    await expect(reserveWorkload(config, policy(), cost)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops after a second confirmed window mismatch', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ result: ['window_changed', 1900000000] }),
          ),
      )
    await expect(reserveWorkload(config, policy(), cost)).rejects.toThrow(
      'Unstable workload clock',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
