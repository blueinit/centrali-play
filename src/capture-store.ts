import type { RedisConfig } from './config'
import type { CaptureInput } from './capture-input'
import { redisCommand } from './redis'
import { sessionKeys } from './session-store'

export const MAX_EVENTS = 50
export type CaptureSession = { id: string; captureHash: string }

// Shared checks are evaluated inside both scripts, using Redis time rather than an edge clock.
const LIVE_SESSION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return nil end
local raw = redis.call('GET', KEYS[2])
if not raw then return nil end
local session = cjson.decode(raw)
local now = redis.call('TIME')
if session.id ~= ARGV[1] or session.captureTokenHash ~= ARGV[2] then return nil end
if type(session.expiresAt) ~= 'number' or session.expiresAt ~= math.floor(session.expiresAt) then
  return redis.error_reply('Invalid session deadline')
end
if session.expiresAt <= tonumber(now[1]) then return nil end
`

const CHECK_SESSION_SCRIPT = `${LIVE_SESSION_SCRIPT}\nreturn 1`

export const APPEND_CAPTURE_SCRIPT = `${LIVE_SESSION_SCRIPT}
local event = cjson.decode(ARGV[3])
if type(event) ~= 'table' or event.version ~= 1 then return redis.error_reply('Invalid event') end
local receivedAt = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
-- Keep the original JSON intact: cjson re-encodes empty arrays as objects.
local id = redis.call('XADD', KEYS[3], 'MAXLEN', '=', ${MAX_EVENTS}, '*',
  'event', ARGV[3], 'receivedAt', string.format('%.0f', receivedAt))
local expiry = redis.pcall('EXPIREAT', KEYS[3], session.expiresAt)
if type(expiry) == 'table' or expiry ~= 1 then
  -- Scripts do not roll back: fail closed rather than leave permanent captures.
  redis.call('DEL', KEYS[3])
  return redis.error_reply('Capture expiry failed')
end
return id
`

export function eventKey(id: string): string {
  return `play:events:${id}`
}

function captureKeys(session: CaptureSession) {
  const [metadata, lookup] = sessionKeys(session.id, session.captureHash)
  return [lookup, metadata, eventKey(session.id)]
}

export async function findCaptureSession(
  config: RedisConfig,
  captureHash: string,
): Promise<CaptureSession | null> {
  const id = await redisCommand(config, ['GET', `play:capture:${captureHash}`])
  if (id === null) return null
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
    throw new Error('Invalid capture lookup')
  const session = { id, captureHash }
  const result = await redisCommand(config, [
    'EVAL',
    CHECK_SESSION_SCRIPT,
    2,
    ...captureKeys(session).slice(0, 2),
    id,
    captureHash,
  ])
  if (result === null) return null
  if (result !== 1) throw new Error('Invalid session check result')
  return session
}

export function appendCaptureCommand(
  session: CaptureSession,
  input: CaptureInput,
): (string | number)[] {
  return [
    'EVAL',
    APPEND_CAPTURE_SCRIPT,
    3,
    ...captureKeys(session),
    session.id,
    session.captureHash,
    JSON.stringify(input),
  ]
}

export async function appendCapture(
  config: RedisConfig,
  session: CaptureSession,
  input: CaptureInput,
): Promise<boolean> {
  const result = await redisCommand(
    config,
    appendCaptureCommand(session, input),
  )
  if (result === null) return false
  if (typeof result !== 'string' || !/^\d+-\d+$/.test(result))
    throw new Error('Invalid capture append result')
  return true
}
