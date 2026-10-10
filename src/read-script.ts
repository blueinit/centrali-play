import { SESSION_LIMIT_SCRIPT } from './session-limit-script'

export const MAX_PAGE_EVENTS = 10
export const MAX_READ_RESPONSE_BYTES = 262_144
export const MAX_READ_REPLY_BYTES = 262_144
const REDIS_PAGE_BUDGET_BYTES = 196_608

// Keep integer components as strings: Lua numbers cannot represent every stream ID.
export const READ_EVENTS_SCRIPT = `${SESSION_LIMIT_SCRIPT}
local function componentCompare(left, right)
  if #left ~= #right then return #left < #right and -1 or 1 end
  if left == right then return 0 end
  return left < right and -1 or 1
end

local function cursorCompare(left, right)
  local leftTime, leftSequence = string.match(left, '^(%d+)%-(%d+)$')
  local rightTime, rightSequence = string.match(right, '^(%d+)%-(%d+)$')
  local timeOrder = componentCompare(leftTime, rightTime)
  if timeOrder ~= 0 then return timeOrder end
  return componentCompare(leftSequence, rightSequence)
end

local function encodedEntrySize(entry)
  local encoded = cjson.encode(entry)
  -- REST encoders may use six-byte Unicode escapes for HTML-sensitive characters.
  local _, htmlCharacters = string.gsub(encoded, '[<>&]', '')
  return #encoded + htmlCharacters * 5
end

local function pageEntries(after)
  local entries = {}
  local cursor = after
  local bytes = 0
  -- Include one look-ahead entry to distinguish a full page from the last page.
  for index = 1, ${MAX_PAGE_EVENTS + 1} do
    local candidate = redis.call('XRANGE', KEYS[2], '(' .. cursor, '+', 'COUNT', 1)
    if #candidate == 0 then return entries, false end
    local entry = candidate[1]
    local size = encodedEntrySize(entry)
    if size > ${REDIS_PAGE_BUDGET_BYTES} then error('Oversized stored event') end
    if index > ${MAX_PAGE_EVENTS} or bytes + size > ${REDIS_PAGE_BUDGET_BYTES} then
      return entries, true
    end
    entries[#entries + 1] = entry
    bytes = bytes + size
    cursor = entry[1]
  end
end

local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local session = cjson.decode(raw)
if session.id ~= ARGV[1] or session.readTokenHash ~= ARGV[2] then return nil end
if type(session.expiresAt) ~= 'number' or session.expiresAt ~= math.floor(session.expiresAt) then
  return redis.error_reply('Invalid session deadline')
end
local now = tonumber(redis.call('TIME')[1])
if session.expiresAt <= now then return nil end
local retry = sessionAllowance(KEYS[3], 'read', now, session.expiresAt,
  tonumber(ARGV[5]), tonumber(ARGV[6]))
if retry > 0 then return { 'rate_limited', retry } end

local after = ARGV[3]
local oldest = redis.call('XRANGE', KEYS[2], '-', '+', 'COUNT', 1)
local newest = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
if (#newest == 0 and after ~= '0-0') or
   (#newest > 0 and cursorCompare(after, newest[1][1]) > 0) then
  return { 'invalid_cursor' }
end
if ARGV[4] == 'head' then return { 'head', session.expiresAt } end

local behind = after ~= '0-0' and #oldest > 0 and cursorCompare(after, oldest[1][1]) < 0
local entries, more = pageEntries(after)
return { 'ok', session.expiresAt, behind and 1 or 0, more and 1 or 0, entries }
`
