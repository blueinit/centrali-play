import type { Bindings } from './config'
import { generateSessionTokens } from './tokens'

export type SessionAdmission = {
  key: string
  reservationId: string
  perHour: number
  perDay: number
  maxSessions: number
}

function limit(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > maximum)
    throw new Error('Invalid session admission configuration')
  return Number(value)
}

export function sessionAdmissionConfig(env: Bindings) {
  const scope = env.SESSION_ADMISSION_SCOPE ?? 'default'
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope))
    throw new Error('Invalid admission scope')
  return {
    key: `play:admission:${scope}`,
    perHour: limit(env.SESSIONS_PER_HOUR, 20, 1_000_000),
    perDay: limit(env.SESSIONS_PER_DAY, 100, 1_000_000),
    maxSessions: limit(env.MAX_ACTIVE_SESSIONS, 20, 1_000),
  }
}

export function newSessionAdmission(
  config: ReturnType<typeof sessionAdmissionConfig>,
): SessionAdmission {
  return { ...config, reservationId: generateSessionTokens().id }
}

export class SessionAdmissionError extends Error {
  constructor(public readonly retryAfter: number) {
    super('service_unavailable')
  }
}

export function checkAdmissionResult(result: unknown) {
  if (!Array.isArray(result) || result[0] !== 'admission_denied') return
  const retry = result[1]
  if (
    result.length !== 2 ||
    typeof retry !== 'number' ||
    !Number.isInteger(retry) ||
    retry < 1 ||
    retry > 60
  )
    throw new Error('Invalid admission response')
  throw new SessionAdmissionError(retry)
}
