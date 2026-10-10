export const SESSION_ADMISSION_SCRIPT = `
local function integer(value, maximum)
  return type(value) == 'number' and value >= 0 and value <= maximum and
    value == math.floor(value)
end

local function admissionState(key, now)
  local hour, day = math.floor(now / 3600), math.floor(now / 86400)
  local raw = redis.call('GET', key)
  if raw and #raw > 131072 then error('Oversized admission state') end
  local state = { hour = hour, day = day, hourly = 0, daily = 0, slots = {} }
  if raw then state = cjson.decode(raw) end
  if type(state) ~= 'table' or not integer(state.hour, hour) or
     not integer(state.day, day) or not integer(state.hourly, 1000000) or
     not integer(state.daily, 1000000) or state.hourly > state.daily or
     math.floor(state.hour / 24) ~= state.day or type(state.slots) ~= 'table' then
    error('Invalid admission state')
  end
  if state.hour ~= hour then state.hour, state.hourly = hour, 0 end
  if state.day ~= day then state.day, state.daily = day, 0 end
  local count, expiry, earliest = 0, (day + 1) * 86400 + 60, now + 3600
  local visited = 0
  for id, slot in pairs(state.slots) do
    visited = visited + 1
    if visited > 1000 then error('Oversized admission state') end
    if type(id) ~= 'string' or #id ~= 32 or string.find(id, '[^a-f0-9]') or
       type(slot) ~= 'table' or not integer(slot.expiresAt, now + 3600) or
       (slot.phase ~= 'pending' and slot.phase ~= 'live') then error('Invalid admission slot') end
    if slot.expiresAt <= now then state.slots[id] = nil
    else
      count = count + 1
      expiry = math.max(expiry, slot.expiresAt)
      earliest = math.min(earliest, slot.expiresAt)
    end
  end
  if count > 1000 then error('Oversized admission state') end
  return state, count, expiry, earliest
end

local function saveAdmission(state, expiry)
  redis.call('SET', KEYS[3], cjson.encode(state), 'EXAT', expiry)
end

local now = tonumber(redis.call('TIME')[1])
local state, count, registryExpiry, earliest = admissionState(KEYS[3], now)
local reservation = ARGV[5]
local slot = state.slots[reservation]
if slot and slot.phase ~= 'pending' then error('Reservation already used') end
if not slot then
  local wait = 0
  if state.hourly >= tonumber(ARGV[6]) then wait = (state.hour + 1) * 3600 - now end
  if state.daily >= tonumber(ARGV[7]) then wait = math.max(wait, (state.day + 1) * 86400 - now) end
  if count >= tonumber(ARGV[8]) then wait = math.max(wait, earliest - now) end
  if wait > 0 then return { 'admission_denied', math.min(60, wait) } end
  slot = { phase = 'pending', expiresAt = now + 3600 }
  state.slots[reservation] = slot
  state.hourly, state.daily = state.hourly + 1, state.daily + 1
  registryExpiry = math.max(registryExpiry, slot.expiresAt)
  -- Attach value and expiry together before any metadata write. Never refund errors.
  saveAdmission(state, registryExpiry)
end
`
