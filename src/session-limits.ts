import type { Bindings } from './config'

export const DEFAULT_SESSION_LIMITS = {
  capturePerMinute: 60,
  capturePerSession: 200,
  readPerMinute: 30,
  readPerSession: 1_000,
}
export type SessionLimits = typeof DEFAULT_SESSION_LIMITS

function positiveLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > 1_000_000)
    throw new Error('Invalid session limit configuration')
  return Number(value)
}

export function sessionLimits(env: Bindings): SessionLimits {
  return {
    capturePerMinute: positiveLimit(
      env.CAPTURE_PER_MINUTE,
      DEFAULT_SESSION_LIMITS.capturePerMinute,
    ),
    capturePerSession: positiveLimit(
      env.CAPTURE_PER_SESSION,
      DEFAULT_SESSION_LIMITS.capturePerSession,
    ),
    readPerMinute: positiveLimit(
      env.READ_PER_MINUTE,
      DEFAULT_SESSION_LIMITS.readPerMinute,
    ),
    readPerSession: positiveLimit(
      env.READ_PER_SESSION,
      DEFAULT_SESSION_LIMITS.readPerSession,
    ),
  }
}

export function sessionLimitKey(id: string): string {
  return `play:limits:${id}`
}

export class SessionRateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super('rate_limited')
  }
}

export function checkRateLimit(result: unknown): void {
  if (!Array.isArray(result) || result[0] !== 'rate_limited') return
  const retry = result[1]
  if (
    result.length !== 2 ||
    typeof retry !== 'number' ||
    !Number.isSafeInteger(retry) ||
    retry < 1 ||
    retry > 3_600
  )
    throw new Error('Invalid rate limit result')
  throw new SessionRateLimitError(retry)
}
