// One bounded record per operator scope, independent of submitted capabilities.
export const RESERVE_WORKLOAD_SCRIPT = `
local maximum = 1000000000000
local function integer(value, minimum, maximumValue)
  return type(value) == 'number' and value >= minimum
    and value <= maximumValue and value == math.floor(value)
end

local start = tonumber(ARGV[1])
local finish = tonumber(ARGV[2])
local unitLimit = tonumber(ARGV[3])
local byteLimit = tonumber(ARGV[4])
local units = tonumber(ARGV[5])
local bytes = tonumber(ARGV[6])
if not integer(start, 1, 253402300799)
  or not integer(finish, start + 28 * 86400, start + 31 * 86400)
  or not integer(unitLimit, 1, maximum)
  or not integer(byteLimit, 1, maximum)
  or not integer(units, 1, maximum)
  or not integer(bytes, 1, maximum) then
  return redis.error_reply('Invalid workload reservation')
end

local now = tonumber(redis.call('TIME')[1])
-- The application proposes UTC month boundaries; Redis time decides the window.
-- This reply confirms that nothing was reserved and allows one clock correction.
if now < start or now >= finish then return { 'window_changed', now } end

local state = { start = start, units = 0, bytes = 0 }
local raw = redis.call('GET', KEYS[1])
if raw then
  if #raw > 256 then return redis.error_reply('Invalid workload state') end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table'
    or not integer(decoded.start, 1, start)
    or not integer(decoded.units, 0, maximum)
    or not integer(decoded.bytes, 0, maximum) then
    return redis.error_reply('Invalid workload state')
  end
  if decoded.start == start then state = decoded end
end

-- Check both caps before the single mutation: denial cannot spend one allowance.
if units > unitLimit - state.units or bytes > byteLimit - state.bytes then
  return { 'budget_denied', math.min(60, finish - now) }
end
state.units = state.units + units
state.bytes = state.bytes + bytes
redis.call('SET', KEYS[1], cjson.encode(state), 'EXAT', finish + 60)
return { 'reserved' }
`
