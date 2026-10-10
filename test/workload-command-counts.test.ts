import { afterEach, expect, it, vi } from 'vitest'
import app from '../src/index'
import { appendCapture } from '../src/capture-store'
import { sessionKeys } from '../src/session-store'
import { tokenDigest } from '../src/tokens'
import { redisCommand } from '../src/redis'
import { WORKLOAD_COSTS, workloadConfig } from '../src/workload-controls'
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

// Count EVAL itself and every real redis.call/pcall, including script internals.
function measuredStorage(collisions = 0) {
  const original = globalThis.fetch.bind(globalThis)
  let calls = 0
  const storage = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      calls++
      const command = JSON.parse(init?.body as string)
      if (command[0] !== 'EVAL') return original(url, init)
      if (
        command[2] === 3 &&
        String(command[3]).startsWith('play:session:') &&
        collisions > 0
      ) {
        collisions--
        command[1] = String(command[1]).replace('KEYS[2]) > 0', 'KEYS[2]) >= 0')
      }
      command[1] = `
local native = redis
local count = 0
local redis = {
  call = function(...) count = count + 1; return native.call(...) end,
  pcall = function(...) count = count + 1; return native.pcall(...) end,
  error_reply = native.error_reply
}
local function operation()
${command[1]}
end
local result = operation()
return { cjson.encode(result), count }
`
      const response = await original(url, {
        ...init,
        body: JSON.stringify(command),
      })
      const data = await response.json<{ result: [string, number] }>()
      calls += data.result[1]
      return Response.json({ result: JSON.parse(data.result[0]) })
    })
  return { storage, count: () => calls }
}

it('covers three creation attempts, including the pending reservation and promotion', async () => {
  const env = {
    ...bindings,
    SESSION_ADMISSION_SCOPE: `test-${crypto.randomUUID()}`,
  }
  keys.push(
    workloadConfig(env).key,
    `play:admission:${env.SESSION_ADMISSION_SCOPE}`,
  )
  const meter = measuredStorage(2)
  const response = await app.request('/sessions', { method: 'POST' }, env)
  expect(response.status).toBe(201)
  expect(meter.count()).toBeGreaterThan(10)
  expect(meter.count() + 2).toBeLessThanOrEqual(WORKLOAD_COSTS.creation.units)
  meter.storage.mockRestore()
  const session = await response.json<{ id: string; captureUrl: string }>()
  keys.push(
    ...sessionKeys(
      session.id,
      await tokenDigest(session.captureUrl.split('/').at(-1)!),
    ),
  )
})

it.each(['capture', 'read', 'head'] as const)(
  'covers worst-case %s script work and clock-correction overhead',
  async (operation) => {
    const env = {
      ...bindings,
      SESSION_ADMISSION_SCOPE: `test-${crypto.randomUUID()}`,
    }
    keys.push(workloadConfig(env).key)
    const session = await captureFixture(keys)
    for (let index = 0; index < 11; index++)
      await appendCapture(
        config,
        { id: session.id, captureHash: session.captureHash },
        emptyCapture,
      )
    const meter = measuredStorage()
    const response = await app.request(
      operation === 'capture'
        ? `/capture/${session.captureToken}`
        : `/sessions/${session.id}/events`,
      {
        method:
          operation === 'capture'
            ? 'POST'
            : operation === 'head'
              ? 'HEAD'
              : 'GET',
        headers: { Authorization: `Bearer ${session.readToken}` },
      },
      env,
    )
    expect(response.status).toBe(operation === 'capture' ? 204 : 200)
    expect(meter.count()).toBeGreaterThan(5)
    // A confirmed month mismatch executes EVAL + TIME, then the normal reservation.
    expect(meter.count() + 2).toBeLessThanOrEqual(
      WORKLOAD_COSTS[operation === 'head' ? 'read' : operation].units,
    )
  },
)
