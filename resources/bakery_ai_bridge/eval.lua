-- Shared by client and server: runs a Lua snippet for the MCP's lua_eval tool.
-- Only reachable when the server sets bakery_ai_eval 1 (checked in server.js).

local function sanitize(value, depth)
    local kind = type(value)
    if kind == 'nil' or kind == 'boolean' or kind == 'string' then return value end
    if kind == 'number' then
        if value ~= value or value == math.huge or value == -math.huge then return tostring(value) end
        return value
    end
    if kind == 'vector2' or kind == 'vector3' or kind == 'vector4' then
        return { x = value.x, y = value.y, z = kind ~= 'vector2' and value.z or nil, w = kind == 'vector4' and value.w or nil }
    end
    if kind ~= 'table' then return '<' .. kind .. '>' end
    if depth >= 6 then return '<table>' end
    local count, array = 0, true
    for key in pairs(value) do
        count = count + 1
        if math.type(key) ~= 'integer' or key < 1 then array = false end
    end
    array = array and count == #value
    local out, seen = {}, 0
    for key, item in pairs(value) do
        seen = seen + 1
        if seen > 200 then out[array and seen or '_truncated'] = (count - 200) .. ' more entries'; break end
        out[array and key or tostring(key)] = sanitize(item, depth + 1)
    end
    return out
end

function BakeryEval(code)
    if type(code) ~= 'string' or #code == 0 or #code > 16000 then error('Code must be 1 to 16000 characters', 0) end
    local output = {}
    local env = setmetatable({
        print = function(...)
            local parts = {}
            for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
            if #output < 100 then output[#output + 1] = table.concat(parts, ' '):sub(1, 500) end
        end,
    }, { __index = _G })
    -- Try the snippet as an expression first so `GetEntityCoords(PlayerPedId())` returns its value.
    local chunk = load('return ' .. code, '=lua_eval', 't', env)
    if not chunk then
        local err
        chunk, err = load(code, '=lua_eval', 't', env)
        if not chunk then error(err, 0) end
    end
    local results = table.pack(pcall(chunk))
    if not results[1] then error(tostring(results[2]), 0) end
    local values = {}
    for i = 2, results.n do values[#values + 1] = sanitize(results[i], 0) end
    local result = values[1]
    if results.n > 2 then result = values end
    return { result = result, output = output }
end
