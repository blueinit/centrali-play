import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { redisCommand } from '../src/redis'
import {
  admitWorkload,
  workloadConfig,
  WORKLOAD_COSTS,
} from '../src/workload-controls'
import { WorkloadBudgetError } from '../src/workload-budget'
import { tokenDigest } from '../src/tokens'
import { sessionKeys } from '../src/session-store'
import { bindings, captureFixture, config } from './capture-fixture'

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
  keys.push(
    workloadConfig(env).key,
    `play:admission:${env.SESSION_ADMISSION_SCOPE}`,
  )
  return env
}

async function totals(env: ReturnType<typeof policy>) {
  const raw = await redisCommand(config, ['GET', workloadConfig(env).key])
  return raw === null ? null : JSON.parse(raw as string)
}

describe('global workload HTTP admission', () => {
  it('shares one strict budget across concurrent HTTP requests', async () => {
    const env = policy({ MONTHLY_WORK_UNITS: '192' })
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.request(`/capture/${'a'.repeat(64)}`, { method: 'POST' }, env),
      ),
    )
    expect(responses.filter((r) => r.status === 404)).toHaveLength(3)
    expect(responses.filter((r) => r.status === 503)).toHaveLength(17)
    expect(await totals(env)).toMatchObject({
      units: 192,
      bytes: WORKLOAD_COSTS.capture.bytes * 3,
    })
  })
  it.each(['creation', 'capture', 'read', 'head'] as const)(
    'reserves %s attempts before capability lookup',
    async (route) => {
      const env = policy()
      const path =
        route === 'creation'
          ? '/sessions'
          : route === 'capture'
            ? `/capture/${'a'.repeat(64)}`
            : `/sessions/${'a'.repeat(32)}/events`
      const response = await app.request(
        path,
        {
          method: route === 'head' ? 'HEAD' : route === 'read' ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
        },
        env,
      )
      expect(response.status).toBe(route === 'creation' ? 201 : 404)
      const cost = WORKLOAD_COSTS[route === 'head' ? 'read' : route]
      expect(await totals(env)).toMatchObject(cost)
      if (route === 'creation') {
        const session = await response.json<{
          id: string
          captureUrl: string
        }>()
        keys.push(
          ...sessionKeys(
            session.id,
            await tokenDigest(session.captureUrl.split('/').at(-1)!),
          ),
        )
      }
    },
  )

  it('charges well-formed wrong credentials without touching session quotas', async () => {
    const env = policy()
    const session = await captureFixture(keys)
    const response = await app.request(
      `/sessions/${session.id}/events`,
      {
        headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
      },
      env,
    )
    expect(response.status).toBe(404)
    expect(await totals(env)).toMatchObject(WORKLOAD_COSTS.read)
    expect(
      await redisCommand(config, ['EXISTS', `play:limits:${session.id}`]),
    ).toBe(0)
  })

  it.each(['creation', 'capture', 'read', 'head'] as const)(
    'denies exhausted %s without lookup, append or page retrieval',
    async (route) => {
      const env = policy({ MONTHLY_WORK_UNITS: '1' })
      const session = await captureFixture(keys)
      const storage = vi.spyOn(globalThis, 'fetch')
      const path =
        route === 'creation'
          ? '/sessions'
          : route === 'capture'
            ? `/capture/${session.captureToken}`
            : `/sessions/${session.id}/events`
      const response = await app.request(
        path,
        {
          method: route === 'head' ? 'HEAD' : route === 'read' ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${session.readToken}` },
        },
        env,
      )
      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe('60')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.text()).toBe(
        route === 'head' ? '' : '{"error":"service_unavailable"}',
      )
      expect(storage).toHaveBeenCalledTimes(1)
      const command = JSON.parse(storage.mock.calls[0]![1]!.body as string)
      expect(command[3]).toBe(workloadConfig(env).key)
      expect(await totals(env)).toBeNull()
    },
  )

  it('denies capture before consuming a streaming body', async () => {
    const env = policy({ MONTHLY_WORK_UNITS: '1' })
    const body = new ReadableStream<Uint8Array>()
    const response = await app.request(
      `/capture/${'a'.repeat(64)}`,
      { method: 'POST', body },
      env,
    )
    expect(response.status).toBe(503)
    expect(body.locked).toBe(false)
  })

  it.each([
    ['/health', 'GET', {}],
    ['/unknown', 'GET', {}],
    ['/capture/bad', 'POST', {}],
    [`/capture/${'a'.repeat(64)}`, 'TRACE', {}],
    [`/sessions/${'a'.repeat(32)}/events`, 'GET', {}],
    ['/sessions', 'POST', { DISABLE_SESSION_CREATION: 'true' }],
    [`/capture/${'a'.repeat(64)}`, 'POST', { DISABLE_STORAGE_ROUTES: 'true' }],
  ] as const)(
    'rejects or serves %s without reservation work',
    async (path, method, overrides) => {
      const env = policy(overrides)
      const storage = vi.spyOn(globalThis, 'fetch')
      await app.request(path, { method }, env)
      expect(storage).not.toHaveBeenCalled()
      expect(await totals(env)).toBeNull()
    },
  )

  it('keeps a spent reservation after a lost budget response without session creation', async () => {
    const env = policy()
    const original = globalThis.fetch.bind(globalThis)
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        await original(url, init)
        throw new Error('Lost budget response')
      })
    const response = await app.request('/sessions', { method: 'POST' }, env)
    expect(response.status).toBe(503)
    expect(storage).toHaveBeenCalledTimes(1)
    storage.mockRestore()
    expect(await totals(env)).toMatchObject(WORKLOAD_COSTS.creation)
    expect(
      await redisCommand(config, [
        'EXISTS',
        `play:admission:${env.SESSION_ADMISSION_SCOPE}`,
      ]),
    ).toBe(0)
  })

  it.each(['0', '01', '-1', '1.5', '1000000000001', ''])(
    'rejects invalid limits %j before Redis',
    async (value) => {
      const storage = vi.spyOn(globalThis, 'fetch')
      const response = await app.request(
        '/sessions',
        { method: 'POST' },
        { ...bindings, MONTHLY_REDIS_BYTES: value },
      )
      expect(response.status).toBe(503)
      expect(storage).not.toHaveBeenCalled()
    },
  )
})

describe('bounded denial caching', () => {
  it('caches denials, expires them early, and never caches permits', async () => {
    const env = policy({ MONTHLY_WORK_UNITS: '1' })
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const storage = vi.spyOn(globalThis, 'fetch')
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    expect(storage).toHaveBeenCalledTimes(1)
    now += 59_000
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    expect(storage).toHaveBeenCalledTimes(2)
    const raised = { ...env, MONTHLY_WORK_UNITS: '128' }
    await admitWorkload(config, raised, 'read')
    await admitWorkload(config, raised, 'read')
    expect(storage).toHaveBeenCalledTimes(4)
  })

  it('separates weights so a denied creation cannot block smaller read reservations', async () => {
    const env = policy({
      MONTHLY_REDIS_BYTES: String(WORKLOAD_COSTS.read.bytes),
    })
    await expect(admitWorkload(config, env, 'creation')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    await admitWorkload(config, env, 'read')
    expect(await totals(env)).toMatchObject(WORKLOAD_COSTS.read)
  })

  it('separates database credentials and scopes', async () => {
    const env = policy({ MONTHLY_WORK_UNITS: '1' })
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ result: ['reserved'] }))
    await admitWorkload({ ...config, redisToken: 'rotated' }, env, 'read')
    await admitWorkload(
      { ...config, redisOrigin: 'https://other.example' },
      env,
      'read',
    )
    await admitWorkload(config, policy(), 'read')
    expect(storage).toHaveBeenCalledTimes(3)
  })

  it('does not cache a denial one second from reset', async () => {
    const env = policy()
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ result: ['budget_denied', 1] }),
      )
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    expect(storage).toHaveBeenCalledTimes(2)
  })

  it('does not cache backend failures as exhaustion', async () => {
    const env = policy()
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Backend unavailable'))
    await expect(admitWorkload(config, env, 'read')).rejects.toThrow()
    await expect(admitWorkload(config, env, 'read')).rejects.toThrow()
    expect(storage).toHaveBeenCalledTimes(2)
  })

  it('bounds cache cardinality and evicts older denials', async () => {
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ result: ['budget_denied', 60] }),
      )
    const envs = Array.from({ length: 65 }, () => policy())
    for (const env of envs)
      await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
        WorkloadBudgetError,
      )
    await expect(
      admitWorkload(config, envs[0]!, 'read'),
    ).rejects.toBeInstanceOf(WorkloadBudgetError)
    expect(storage).toHaveBeenCalledTimes(66)
  })

  it('subtracts transport time instead of extending a cached denial', async () => {
    const env = policy()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const storage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        now += 60_000
        return Response.json({ result: ['budget_denied', 60] })
      })
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    await expect(admitWorkload(config, env, 'read')).rejects.toBeInstanceOf(
      WorkloadBudgetError,
    )
    expect(storage).toHaveBeenCalledTimes(2)
  })
})
