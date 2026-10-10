import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import {
  admittedSessionCommand,
  sessionKeys,
  storeSession,
} from '../src/session-store'
import {
  newSessionAdmission,
  sessionAdmissionConfig,
} from '../src/session-admission'
import { generateSessionTokens, tokenDigest } from '../src/tokens'
import { redisCommand } from '../src/redis'
import { bindings, config } from './capture-fixture'

const keys: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  if (keys.length) await redisCommand(config, ['DEL', ...keys.splice(0)])
})

function policy(overrides = {}) {
  const env = {
    ...bindings,
    SESSION_ADMISSION_SCOPE: `test-${crypto.randomUUID()}`,
    ...overrides,
  }
  const admission = sessionAdmissionConfig(env)
  keys.push(admission.key)
  return { env, admission }
}

async function record() {
  const tokens = generateSessionTokens()
  const value = {
    id: tokens.id,
    captureTokenHash: await tokenDigest(tokens.captureToken),
    readTokenHash: await tokenDigest(tokens.readToken),
  }
  keys.push(...sessionKeys(value.id, value.captureTokenHash))
  return value
}

async function state(key: string) {
  const raw = await redisCommand(config, ['GET', key])
  return raw === null ? null : JSON.parse(raw as string)
}

function atTime(command: (string | number)[], now: number) {
  command[1] = String(command[1]).replace(
    "redis.call('TIME')",
    `({ '${now}', '0' })`,
  )
  return command
}

describe('global session admission against real Redis', () => {
  it.each(['SESSIONS_PER_HOUR', 'SESSIONS_PER_DAY', 'MAX_ACTIVE_SESSIONS'])(
    'enforces %s across concurrent instances',
    async (setting) => {
      const { admission } = policy({ [setting]: '3' })
      const records = await Promise.all(
        Array.from({ length: 20 }, () => record()),
      )
      const time = (await redisCommand(config, ['TIME'])) as string[]
      const commands = records.map((value) =>
        atTime(
          admittedSessionCommand(value, newSessionAdmission(admission)),
          Number(time[0]),
        ),
      )
      const replies = await Promise.all(
        commands.map((command) => redisCommand(config, command)),
      )
      expect(
        replies.filter((reply) => typeof reply === 'number' && reply > 0),
      ).toHaveLength(3)
      expect(
        replies.filter(
          (reply) => Array.isArray(reply) && reply[0] === 'admission_denied',
        ),
      ).toHaveLength(17)
      const current = await state(admission.key)
      expect(current.hourly).toBe(3)
      expect(current.daily).toBe(3)
      expect(Object.values(current.slots)).toHaveLength(3)
      const existing = await redisCommand(config, [
        'EXISTS',
        ...records.flatMap((value) => [
          ...sessionKeys(value.id, value.captureTokenHash),
        ]),
      ])
      expect(existing).toBe(6)
    },
  )

  it('reuses one pending slot and creation allowance after a confirmed collision', async () => {
    const { admission } = policy({ MAX_ACTIVE_SESSIONS: '1' })
    const permit = newSessionAdmission(admission)
    const occupied = await record()
    await redisCommand(config, [
      'SET',
      sessionKeys(occupied.id, occupied.captureTokenHash)[0],
      'existing',
      'EX',
      60,
    ])
    expect(await storeSession(config, occupied, permit)).toBeNull()
    expect((await state(admission.key)).slots[permit.reservationId].phase).toBe(
      'pending',
    )
    const value = await record()
    const expiry = await storeSession(config, value, permit)
    const current = await state(admission.key)
    expect(current.hourly).toBe(1)
    expect(current.daily).toBe(1)
    expect(current.slots[permit.reservationId]).toEqual({
      phase: 'live',
      expiresAt: expiry,
    })
    expect(
      await redisCommand(config, [
        'EXPIRETIME',
        sessionKeys(value.id, value.captureTokenHash)[0],
      ]),
    ).toBe(expiry)
    await expect(storeSession(config, await record(), permit)).rejects.toThrow()
  })

  it('resets hour/day windows with Redis time and prunes expired slots', async () => {
    const { admission } = policy({
      SESSIONS_PER_HOUR: '1',
      SESSIONS_PER_DAY: '1',
      MAX_ACTIVE_SESSIONS: '2',
    })
    const time = (await redisCommand(config, ['TIME'])) as string[]
    const midnight = (Math.floor(Number(time[0]) / 86400) + 1) * 86400
    const create = async (now: number) =>
      redisCommand(
        config,
        atTime(
          admittedSessionCommand(
            await record(),
            newSessionAdmission(admission),
          ),
          now,
        ),
      )
    expect(typeof (await create(midnight - 1))).toBe('number')
    expect(await create(midnight - 1)).toEqual(['admission_denied', 1])
    expect(typeof (await create(midnight))).toBe('number')
    expect((await state(admission.key)).daily).toBe(1)
    expect(typeof (await create(midnight + 86400))).toBe('number')
    expect(Object.values((await state(admission.key)).slots)).toHaveLength(1)
  })

  it('reclaims live capacity after fixed expiry without a cleanup job', async () => {
    const { admission } = policy({ MAX_ACTIVE_SESSIONS: '1' })
    const value = await record()
    const expiry = await redisCommand(
      config,
      admittedSessionCommand(value, newSessionAdmission(admission), 2),
    )
    expect(Object.values((await state(admission.key)).slots)).toEqual([
      { phase: 'live', expiresAt: expiry },
    ])
    await expect
      .poll(
        () =>
          redisCommand(config, [
            'EXISTS',
            ...sessionKeys(value.id, value.captureTokenHash),
          ]),
        { timeout: 4000, interval: 100 },
      )
      .toBe(0)
    expect(
      typeof (await storeSession(
        config,
        await record(),
        newSessionAdmission(admission),
      )),
    ).toBe('number')
    expect(Object.values((await state(admission.key)).slots)).toHaveLength(1)
  })

  it.each([
    ["redis.call('SET', KEYS[1]", "redis.call('INVALID_COMMAND', KEYS[1]"],
    ["redis.pcall('SET', KEYS[2]", "redis.pcall('INVALID_COMMAND', KEYS[2]"],
    ["redis.pcall('SET', KEYS[3]", "redis.pcall('INVALID_COMMAND', KEYS[3]"],
  ])(
    'holds pending capacity on injected creation failure: %s',
    async (before, after) => {
      const { admission } = policy({ MAX_ACTIVE_SESSIONS: '1' })
      const permit = newSessionAdmission(admission)
      const value = await record()
      const command = admittedSessionCommand(value, permit)
      command[1] = String(command[1]).replace(before, after)
      await expect(redisCommand(config, command)).rejects.toThrow()
      const current = await state(admission.key)
      expect(current.hourly).toBe(1)
      expect(current.slots[permit.reservationId].phase).toBe('pending')
      expect(
        await redisCommand(config, [
          'EXISTS',
          ...sessionKeys(value.id, value.captureTokenHash),
        ]),
      ).toBe(0)
      const denied = await redisCommand(
        config,
        admittedSessionCommand(await record(), newSessionAdmission(admission)),
      )
      expect(denied).toEqual(['admission_denied', 60])
      expect((await state(admission.key)).hourly).toBe(1)
      expect(
        await redisCommand(config, ['TTL', admission.key]),
      ).toBeGreaterThan(0)
    },
  )

  it('does not create metadata when atomic reservation storage fails', async () => {
    const { admission } = policy()
    const value = await record()
    const command = admittedSessionCommand(
      value,
      newSessionAdmission(admission),
    )
    command[1] = String(command[1]).replace(
      "redis.call('SET', KEYS[3]",
      "redis.call('INVALID_COMMAND', KEYS[3]",
    )
    await expect(redisCommand(config, command)).rejects.toThrow()
    expect(await state(admission.key)).toBeNull()
    expect(
      await redisCommand(config, [
        'EXISTS',
        ...sessionKeys(value.id, value.captureTokenHash),
      ]),
    ).toBe(0)
  })

  it('fails closed on corrupt admission state without replacing it', async () => {
    const { admission } = policy()
    await redisCommand(config, ['SET', admission.key, 'false', 'EX', 60])
    await expect(
      storeSession(config, await record(), newSessionAdmission(admission)),
    ).rejects.toThrow()
    expect(await redisCommand(config, ['GET', admission.key])).toBe('false')
  })

  it('reclaims an expired pending slot while retaining bounded ledger history', async () => {
    const { admission } = policy({ MAX_ACTIVE_SESSIONS: '1' })
    const permit = newSessionAdmission(admission)
    const value = await record()
    await redisCommand(config, [
      'SET',
      sessionKeys(value.id, value.captureTokenHash)[0],
      'occupied',
      'EX',
      60,
    ])
    expect(await storeSession(config, value, permit)).toBeNull()
    const expiresAt = (await state(admission.key)).slots[permit.reservationId]
      .expiresAt
    const command = atTime(
      admittedSessionCommand(await record(), newSessionAdmission(admission)),
      expiresAt + 1,
    )
    expect(typeof (await redisCommand(config, command))).toBe('number')
    const current = await state(admission.key)
    expect(current.slots[permit.reservationId]).toBeUndefined()
    expect(Object.values(current.slots)).toHaveLength(1)
  })
})

describe('session admission HTTP behavior', () => {
  it('returns safe 503 with a bounded retry delay when capacity is exhausted', async () => {
    const { env, admission } = policy({ MAX_ACTIVE_SESSIONS: '1' })
    await storeSession(config, await record(), newSessionAdmission(admission))
    const response = await app.request(
      '/sessions?SESSION_ADMISSION_SCOPE=other',
      {
        method: 'POST',
        headers: { SESSION_ADMISSION_SCOPE: 'other' },
      },
      env,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('keeps a live slot after an uncertain creation response without retrying', async () => {
    const { env, admission } = policy()
    const original = globalThis.fetch.bind(globalThis)
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        const command = JSON.parse(init?.body as string)
        keys.push(command[3], command[4])
        await original(url, init)
        throw new Error('Synthetic lost response')
      })
    const response = await app.request('/sessions', { method: 'POST' }, env)
    expect(response.status).toBe(503)
    expect(storage).toHaveBeenCalledTimes(1)
    storage.mockRestore()
    const current = await state(admission.key)
    expect(current.daily).toBe(1)
    expect(Object.values(current.slots)).toHaveLength(1)
    expect(Object.values(current.slots)[0]).toMatchObject({ phase: 'live' })
  })

  it.each(['0', '01', '-1', '1000001', ''])(
    'rejects invalid admission limit %j before Redis',
    async (value) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        '/sessions',
        { method: 'POST' },
        { ...bindings, SESSIONS_PER_HOUR: value },
      )
      expect(response.status).toBe(503)
      expect(storage).not.toHaveBeenCalled()
    },
  )
})
