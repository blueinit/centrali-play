// Used only after capability and fixed-deadline validation inside an atomic script.
export const SESSION_LIMIT_SCRIPT = `
local function validCount(value)
  return type(value) == 'number' and value >= 0 and
    value <= 1000000 and value == math.floor(value)
end

local function validCounter(counter, window)
  return type(counter) == 'table' and validCount(counter.minute) and
    validCount(counter.total) and counter.minute <= counter.total and
    type(counter.window) == 'number' and
    counter.window >= -1 and counter.window <= window and
    counter.window == math.floor(counter.window)
end

local function sessionAllowance(key, route, now, expiresAt, minuteLimit, totalLimit)
  local window = math.floor(now / 60)
  local raw = redis.call('GET', key)
  local counters = {
    capture = { window = -1, minute = 0, total = 0 },
    read = { window = -1, minute = 0, total = 0 }
  }
  if raw then counters = cjson.decode(raw) end
  if type(counters) ~= 'table' or not validCounter(counters.capture, window) or
     not validCounter(counters.read, window) then error('Invalid session counters') end
  local counter = counters[route]
  if counter.total >= totalLimit then return expiresAt - now end
  if counter.window ~= window then
    counter.window = window
    counter.minute = 0
  end
  if counter.minute >= minuteLimit then
    return math.min((window + 1) * 60, expiresAt) - now
  end
  counter.minute = counter.minute + 1
  counter.total = counter.total + 1
  -- SET EXAT attaches expiry in the same command; errors cannot strand a new key.
  -- Later operation failures keep the reservation: uncertain work is never refunded.
  redis.call('SET', key, cjson.encode(counters), 'EXAT', expiresAt)
  return 0
end
`
