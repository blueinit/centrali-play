import type { SessionConfig } from './config'
import { redisCommand } from './redis'
import { SESSION_ADMISSION_SCRIPT } from './session-admission-script'
import { checkAdmissionResult } from './session-admission'
import type { SessionAdmission } from './session-admission'

export const SESSION_LIFETIME_SECONDS = 3_600

type SessionRecord = {
  id: string
  captureTokenHash: string
  readTokenHash: string
}

// One script prevents another request from observing half-created credentials.
// Each SET attaches expiry immediately; a failed second SET removes the first.
function creationScript(deadlineExpression: string): string {
  return `
if redis.call('EXISTS', KEYS[1], KEYS[2]) > 0 then
  return 0
end

local lifetime = tonumber(ARGV[4])
if not lifetime or lifetime < 1 or lifetime ~= math.floor(lifetime) then
  return redis.error_reply('Invalid lifetime')
end
local expiresAt = ${deadlineExpression}
local metadata = cjson.encode({
  id = ARGV[1],
  captureTokenHash = ARGV[2],
  readTokenHash = ARGV[3],
  expiresAt = expiresAt
})

redis.call('SET', KEYS[1], metadata, 'EXAT', expiresAt)
local lookup = redis.pcall('SET', KEYS[2], ARGV[1], 'EXAT', expiresAt)
if type(lookup) == 'table' and lookup.err then
  redis.call('DEL', KEYS[1])
  return redis.error_reply('Creation failed')
end
return expiresAt
`
}

// These expressions are fixed source code, never request or environment input.
export const CREATE_SESSION_SCRIPT = creationScript(
  "tonumber(redis.call('TIME')[1]) + lifetime",
)

const ADMITTED_CREATE_SESSION_SCRIPT = `${SESSION_ADMISSION_SCRIPT}
local function createSession()
${creationScript('math.min(now + lifetime, slot.expiresAt)')}
end
local result = createSession()
if type(result) ~= 'number' or result == 0 then return result end
slot.phase, slot.expiresAt = 'live', result
local promotion = redis.pcall('SET', KEYS[3], cjson.encode(state), 'EXAT', registryExpiry)
if type(promotion) == 'table' and promotion.err then
  redis.call('DEL', KEYS[1], KEYS[2])
  return redis.error_reply('Admission promotion failed')
end
return result
`

export function sessionKeys(id: string, captureHash: string) {
  return [`play:session:${id}`, `play:capture:${captureHash}`] as const
}

// Raw storage primitive for fixtures; application creation uses storeSession with admission.
export function createSessionCommand(
  record: SessionRecord,
  lifetimeSeconds = SESSION_LIFETIME_SECONDS,
): (string | number)[] {
  return [
    'EVAL',
    CREATE_SESSION_SCRIPT,
    2,
    ...sessionKeys(record.id, record.captureTokenHash),
    record.id,
    record.captureTokenHash,
    record.readTokenHash,
    lifetimeSeconds,
  ]
}

export async function storeSession(
  config: SessionConfig,
  record: SessionRecord,
  admission: SessionAdmission,
): Promise<number | null> {
  const result = await redisCommand(
    config,
    admittedSessionCommand(record, admission),
  )
  checkAdmissionResult(result)
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new Error('Invalid session creation result')
  }
  return result === 0 ? null : result
}

export function admittedSessionCommand(
  record: SessionRecord,
  admission: SessionAdmission,
  lifetime = SESSION_LIFETIME_SECONDS,
): (string | number)[] {
  return [
    'EVAL',
    ADMITTED_CREATE_SESSION_SCRIPT,
    3,
    ...sessionKeys(record.id, record.captureTokenHash),
    admission.key,
    record.id,
    record.captureTokenHash,
    record.readTokenHash,
    lifetime,
    admission.reservationId,
    admission.perHour,
    admission.perDay,
    admission.maxSessions,
  ]
}
