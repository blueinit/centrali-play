import type { SessionConfig } from './config'
import { redisCommand } from './redis'

export const SESSION_LIFETIME_SECONDS = 3_600

type SessionRecord = {
  id: string
  captureTokenHash: string
  readTokenHash: string
}

// One script prevents another request from observing half-created credentials.
// Each SET attaches expiry immediately; a failed second SET removes the first.
export const CREATE_SESSION_SCRIPT = `
if redis.call('EXISTS', KEYS[1], KEYS[2]) > 0 then
  return 0
end

local lifetime = tonumber(ARGV[4])
if not lifetime or lifetime < 1 or lifetime ~= math.floor(lifetime) then
  return redis.error_reply('Invalid lifetime')
end
local expiresAt = tonumber(redis.call('TIME')[1]) + lifetime
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

export function sessionKeys(id: string, captureHash: string) {
  return [`play:session:${id}`, `play:capture:${captureHash}`] as const
}

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
): Promise<number | null> {
  const result = await redisCommand(config, createSessionCommand(record))
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new Error('Invalid session creation result')
  }
  return result === 0 ? null : result
}
