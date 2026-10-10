import type { RedisConfig } from './config'
import { redisCommand } from './redis'
import { RESERVE_WORKLOAD_SCRIPT } from './workload-budget-script'

const MAXIMUM = 1_000_000_000_000
const DEFAULT_MONTHLY_UNITS = 200_000
const DEFAULT_MONTHLY_BYTES = 2 * 1024 ** 3

export type WorkloadBudget = {
  key: string
  unitsPerMonth: number
  bytesPerMonth: number
}

export type WorkloadReservation = { units: number; bytes: number }

export class WorkloadBudgetError extends Error {
  constructor(public readonly retryAfter: number) {
    super('service_unavailable')
  }
}

function positiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM)
    throw new Error('Invalid workload budget configuration')
}

export function workloadBudget(
  scope: string,
  unitsPerMonth = DEFAULT_MONTHLY_UNITS,
  bytesPerMonth = DEFAULT_MONTHLY_BYTES,
): WorkloadBudget {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope))
    throw new Error('Invalid workload budget scope')
  positiveInteger(unitsPerMonth)
  positiveInteger(bytesPerMonth)
  return { key: `play:budget:${scope}`, unitsPerMonth, bytesPerMonth }
}

function monthWindow(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 253402300799)
    throw new Error('Invalid workload clock')
  const date = new Date(seconds * 1000)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  return {
    start: Date.UTC(year, month, 1) / 1000,
    finish: Date.UTC(year, month + 1, 1) / 1000,
  }
}

export function workloadReservationCommand(
  budget: WorkloadBudget,
  reservation: WorkloadReservation,
  seconds = Math.floor(Date.now() / 1000),
): (string | number)[] {
  positiveInteger(budget.unitsPerMonth)
  positiveInteger(budget.bytesPerMonth)
  positiveInteger(reservation.units)
  positiveInteger(reservation.bytes)
  if (!/^play:budget:[a-z0-9][a-z0-9_-]{0,63}$/.test(budget.key))
    throw new Error('Invalid workload budget key')
  const { start, finish } = monthWindow(seconds)
  return [
    'EVAL',
    RESERVE_WORKLOAD_SCRIPT,
    1,
    budget.key,
    start,
    finish,
    budget.unitsPerMonth,
    budget.bytesPerMonth,
    reservation.units,
    reservation.bytes,
  ]
}

function parseReply(result: unknown) {
  if (!Array.isArray(result)) throw new Error('Invalid workload response')
  if (result.length === 1 && result[0] === 'reserved') return null
  const value: unknown = result[1]
  if (
    result.length !== 2 ||
    typeof value !== 'number' ||
    !Number.isSafeInteger(value)
  )
    throw new Error('Invalid workload response')
  if (result[0] === 'budget_denied' && value >= 1 && value <= 60)
    throw new WorkloadBudgetError(value)
  if (result[0] === 'window_changed' && value >= 1 && value <= 253402300799)
    return value
  throw new Error('Invalid workload response')
}

export async function reserveWorkload(
  config: RedisConfig,
  budget: WorkloadBudget,
  reservation: WorkloadReservation,
): Promise<void> {
  const clock = parseReply(
    await redisCommand(config, workloadReservationCommand(budget, reservation)),
  )
  if (clock === null) return
  // Only a confirmed, non-mutating window mismatch can be retried. Network and
  // storage errors remain uncertain and are never replayed or refunded.
  const corrected = parseReply(
    await redisCommand(
      config,
      workloadReservationCommand(budget, reservation, clock),
    ),
  )
  if (corrected !== null) throw new Error('Unstable workload clock')
}
