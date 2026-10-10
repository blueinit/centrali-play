import type { Bindings, RedisConfig } from './config'
import {
  reserveWorkload,
  workloadBudget,
  WorkloadBudgetError,
} from './workload-budget'

// Include bounded clock correction, collision retries, scripts and replies.
export const WORKLOAD_COSTS = {
  creation: { units: 64, bytes: 1024 ** 2 },
  capture: { units: 64, bytes: 384 * 1024 },
  read: { units: 64, bytes: 384 * 1024 },
} as const

function configuredLimit(value: string | undefined) {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]{0,12}$/.test(value))
    throw new Error('Invalid workload configuration')
  return Number(value)
}

export function workloadConfig(env: Bindings) {
  return workloadBudget(
    env.SESSION_ADMISSION_SCOPE ?? 'default',
    configuredLimit(env.MONTHLY_WORK_UNITS),
    configuredLimit(env.MONTHLY_REDIS_BYTES),
  )
}

// Cache only denials, with bounded cardinality and a monotonic local deadline.
const denials = new Map<string, number>()
const MAX_CACHED_DENIALS = 64

function checkCachedDenial(key: string, now: number) {
  const until = denials.get(key)
  if (until === undefined) return
  if (until > now)
    throw new WorkloadBudgetError(Math.ceil((until - now) / 1000))
  denials.delete(key)
}

function cacheDenial(key: string, started: number, retryAfter: number) {
  // Subtract Redis TIME's fractional second and transport delay. A one-second
  // denial is never cached, so the cache cannot outlive the month boundary.
  const expires = started + Math.max(0, retryAfter - 1) * 1000
  if (expires <= performance.now()) return
  if (denials.size >= MAX_CACHED_DENIALS)
    denials.delete(denials.keys().next().value!)
  denials.set(key, expires)
}

export async function admitWorkload(
  config: RedisConfig,
  env: Bindings,
  operation: keyof typeof WORKLOAD_COSTS,
) {
  const budget = workloadConfig(env)
  const cost = WORKLOAD_COSTS[operation]
  // Separate backends, credential rotations, limits and weights. No caller input.
  const key = JSON.stringify([config, budget, cost])
  const started = performance.now()
  checkCachedDenial(key, started)
  try {
    await reserveWorkload(config, budget, cost)
  } catch (error) {
    if (error instanceof WorkloadBudgetError)
      cacheDenial(key, started, error.retryAfter)
    throw error
  }
}
