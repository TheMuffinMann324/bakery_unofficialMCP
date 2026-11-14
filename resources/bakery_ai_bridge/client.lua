local resource = GetCurrentResourceName()
local prefix = 'bakery_ai_bridge:'
local optedIn = false
local entities = {}
local environments = {}
local nextEntity = 0
local generation = 0
local busy = false

local function coords(position)
    return { x = position.x, y = position.y, z = position.z }
end

local function validNumber(value, limit)
    return type(value) == 'number' and value == value and math.abs(value) <= limit
end

local function position(args, fallback)
    if args.position == nil and fallback then return fallback end
    local p = args.position
    if type(p) ~= 'table' or not validNumber(p.x, 20000) or not validNumber(p.y, 20000)
        or not validNumber(p.z, 4000) then error('Invalid world coordinates') end
    -- JSON whole numbers arrive as Lua integers, and natives would read an integer's bits as a float
    -- (400 becomes ~0, negatives become NaN). Force floats before any native sees them.
    return { x = p.x + 0.0, y = p.y + 0.0, z = p.z + 0.0 }
end

local function inspect(entry)
    return { id = entry.id, kind = entry.kind, model = entry.model, position = coords(GetEntityCoords(entry.handle)) }
end

local function remove(entry)
    if DoesEntityExist(entry.handle) then
        SetEntityAsMissionEntity(entry.handle, true, true)
        DeleteEntity(entry.handle)
        if DoesEntityExist(entry.handle) then error('Could not delete test entity ' .. entry.id) end
    end
    entities[entry.id] = nil
end

local function resetEnvironment(scope)
    if not scope or environments.weather == scope then
        if environments.weather then
            ClearOverrideWeather()
            ClearWeatherTypePersist()
        end
        environments.weather = nil
    end
    if not scope or environments.time == scope then
        if environments.time then NetworkClearClockTimeOverride() end
        environments.time = nil
    end
end

local function cleanup(scope)
    local deleted, failures = 0, {}
    for _, entry in pairs(entities) do
        if not scope or entry.scope == scope then
            local ok, err = pcall(remove, entry)
            if ok then deleted = deleted + 1
            else failures[#failures + 1] = tostring(err) end
        end
    end
    resetEnvironment(scope)
    return { deleted = deleted, failures = failures }
end

local function spawn(kind, args, actionGeneration)
    local count = 0
    for id, entry in pairs(entities) do
        if DoesEntityExist(entry.handle) then count = count + 1
        else entities[id] = nil end
    end
    if count >= 24 then error('Test entity limit reached') end
    if type(args.model) ~= 'string' or not args.model:match('^[%w_]+$') or #args.model > 64 then error('Invalid model') end
    local model = joaat(args.model)
    if not IsModelInCdimage(model) or not IsModelValid(model)
        or (kind == 'vehicle' and not IsModelAVehicle(model))
        or (kind == 'ped' and not IsModelAPed(model))
        or (kind == 'object' and (IsModelAVehicle(model) or IsModelAPed(model))) then
        error('Model does not match entity kind')
    end
    local heading = (args.heading or GetEntityHeading(PlayerPedId())) + 0.0
    if not validNumber(heading, 360) then error('Invalid heading') end
    local p = position(args, GetOffsetFromEntityInWorldCoords(PlayerPedId(), 0.0, 4.0, 0.0))
    RequestModel(model)
    local deadline = GetGameTimer() + 2400
    while not HasModelLoaded(model) and GetGameTimer() < deadline and generation == actionGeneration do Wait(0) end
    if generation ~= actionGeneration or not HasModelLoaded(model) then
        SetModelAsNoLongerNeeded(model)
        error('Model load cancelled or timed out')
    end
    local handle
    if kind == 'vehicle' then
        handle = CreateVehicle(model, p.x, p.y, p.z, heading, false, false)
    elseif kind == 'ped' then
        handle = CreatePed(4, model, p.x, p.y, p.z, heading, false, false)
    else
        handle = CreateObjectNoOffset(model, p.x, p.y, p.z, false, false, false)
    end
    SetModelAsNoLongerNeeded(model)
    if handle == 0 or not DoesEntityExist(handle) then error('Entity creation failed') end
    SetEntityAsMissionEntity(handle, true, true)
    if kind == 'object' then SetEntityHeading(handle, heading) end
    if kind == 'vehicle' and args.warpIn then
        -- Test vehicles are client-local, so key systems never hand out keys for them.
        -- For qbx_vehiclekeys, grant a local key so the engine and accelerate control stay enabled.
        if GetResourceState('qbx_vehiclekeys') == 'started' then
            local key = 'bakery_test_' .. nextEntity + 1
            Entity(handle).state:set('sessionId', key, false)
            local keys = LocalPlayer.state.keysList or {}
            keys[key] = true
            LocalPlayer.state:set('keysList', keys, false)
        end
        TaskWarpPedIntoVehicle(PlayerPedId(), handle, -1)
        SetVehicleEngineOn(handle, true, true, false)
    end
    nextEntity = nextEntity + 1
    local entry = { id = nextEntity, handle = handle, kind = kind, model = args.model, scope = args.scope or 'manual' }
    entities[entry.id] = entry
    return inspect(entry)
end

local weather = {}
for _, value in ipairs({ 'CLEAR', 'EXTRASUNNY', 'CLOUDS', 'OVERCAST', 'RAIN', 'THUNDER', 'FOGGY',
    'SMOG', 'CLEARING', 'NEUTRAL', 'SNOW', 'BLIZZARD', 'SNOWLIGHT', 'XMAS', 'HALLOWEEN' }) do weather[value] = true end

local function run(op, args, actionGeneration)
    local ped = PlayerPedId()
    if op == 'state' then
        local width, height = GetActiveScreenResolution()
        return { position = coords(GetEntityCoords(ped)), heading = GetEntityHeading(ped), health = GetEntityHealth(ped),
            armor = GetPedArmour(ped), inVehicle = IsPedInAnyVehicle(ped, false), hour = GetClockHours(),
            minute = GetClockMinutes(), width = width, height = height, nuiFocused = IsNuiFocused() }
    elseif op == 'entities' then
        local result = {}
        for _, entry in pairs(entities) do
            if DoesEntityExist(entry.handle) and (not args.scope or entry.scope == args.scope) then result[#result + 1] = inspect(entry) end
        end
        table.sort(result, function(a, b) return a.id < b.id end)
        return { entities = result, count = #result }
    elseif op == 'spawn_vehicle' or op == 'spawn_ped' or op == 'spawn_object' then
        return spawn(op:sub(7), args, actionGeneration)
    elseif op == 'delete_entity' then
        local entry = entities[args.entityId]
        if not entry or (args.scope and entry.scope ~= args.scope) then error('Unknown bridge-owned test entity') end
        remove(entry)
        return { deleted = entry.id }
    elseif op == 'cleanup' then
        return cleanup(args.scope)
    elseif op == 'teleport' then
        if IsPedInAnyVehicle(ped, false) then error('Exit the vehicle before teleporting') end
        local p = position(args)
        local deadline = GetGameTimer() + 3000
        -- Stream the destination while the player is frozen in place, so the area loads before
        -- the player arrives instead of all at once. Always unfreeze, even on failure.
        FreezeEntityPosition(ped, true)
        local ok, result = pcall(function()
            NewLoadSceneStartSphere(p.x, p.y, p.z, 60.0, 0)
            while not IsNewLoadSceneLoaded() and GetGameTimer() < deadline and generation == actionGeneration do Wait(0) end
            local sceneLoaded = IsNewLoadSceneLoaded()
            NewLoadSceneStop()
            SetEntityCoordsNoOffset(ped, p.x, p.y, p.z, false, false, false)
            while not HasCollisionLoadedAroundEntity(ped) and GetGameTimer() < deadline + 1000 and generation == actionGeneration do
                RequestCollisionAtCoord(p.x, p.y, p.z)
                Wait(0)
            end
            -- Put the player on the ground (the requested z may be slightly above or below it).
            local found, groundZ = GetGroundZFor_3dCoord(p.x, p.y, p.z + 3.0, false)
            if found and math.abs(groundZ - p.z) <= 10.0 then SetEntityCoords(ped, p.x, p.y, groundZ, false, false, false, false) end
            local collision = HasCollisionLoadedAroundEntity(ped)
            return { sceneLoaded = sceneLoaded == true or sceneLoaded == 1, collisionLoaded = collision == true or collision == 1,
                groundZ = found and groundZ or nil }
        end)
        FreezeEntityPosition(ped, false)
        if not ok then error(result, 0) end
        result.position = coords(GetEntityCoords(ped))
        return result
    elseif op == 'weather' then
        if not weather[args.weather] then error('Invalid weather type') end
        SetWeatherTypeNowPersist(args.weather)
        environments.weather = args.scope or 'manual'
        return { weather = args.weather, scope = 'client' }
    elseif op == 'time' then
        if not validNumber(args.hour, 23) or args.hour < 0 or args.hour % 1 ~= 0
            or not validNumber(args.minute, 59) or args.minute < 0 or args.minute % 1 ~= 0 then error('Invalid time') end
        NetworkOverrideClockTime(args.hour, args.minute, 0)
        environments.time = args.scope or 'manual'
        return { hour = args.hour, minute = args.minute, scope = 'client' }
    elseif op == 'reset_environment' then
        resetEnvironment(args.scope)
        return { reset = true }
    elseif op == 'performance_client' then
        return { source = 'FiveM client natives', frameTimeMs = GetFrameTime() * 1000, bridgeLuaHeapKiB = collectgarbage('count') }
    elseif op == 'adapter' then
        if type(args.resource) ~= 'string' or GetResourceState(args.resource) ~= 'started' or args.resource == resource
            or type(args.action) ~= 'string' or not args.action:match('^[%w_]+$') then error('Invalid adapter target') end
        local result = exports[args.resource]:bakeryAiTest(args.action, args.data or {}, args.scope)
        if type(result) ~= 'table' then error('Adapter must return a result table') end
        if result.ok == false then error(tostring(result.error or 'Adapter rejected the action')) end
        return result
    elseif op == 'client_command' then
        local command = args.command
        if type(command) ~= 'string' or #command > 64 or not command:match('^[%+%-]?[%w_%.:]+$') then error('Invalid command name') end
        local parts = { command }
        local list = args.args or {}
        if type(list) ~= 'table' or #list > 16 then error('Invalid command arguments') end
        for i = 1, #list do
            local value = list[i]
            if type(value) ~= 'string' or #value < 1 or #value > 100 or not value:match('^[%w_%.,:%+%-/]+$') then
                error('Invalid command argument ' .. i)
            end
            parts[#parts + 1] = value
        end
        local line = table.concat(parts, ' ')
        ExecuteCommand(line)
        return { executed = line }
    elseif op == 'eval' then
        return BakeryEval(args.code)
    elseif op == 'input' then
        local controls, duration = args.controls, args.durationMs
        if type(controls) ~= 'table' or #controls < 1 or #controls > 8 then error('Provide 1 to 8 controls') end
        if math.type(duration) ~= 'integer' or duration < 16 or duration > 4000 then error('durationMs must be 16 to 4000') end
        for _, c in ipairs(controls) do
            if math.type(c.control) ~= 'integer' or c.control < 0 or c.control > 360 or not validNumber(c.value, 1) then
                error('Invalid control')
            end
        end
        local finish = GetGameTimer() + duration
        while GetGameTimer() < finish and generation == actionGeneration do
            for _, c in ipairs(controls) do
                SetControlNormal(0, c.control, c.value + 0.0)
            end
            Wait(0)
        end
        return { position = coords(GetEntityCoords(PlayerPedId())), inVehicle = IsPedInAnyVehicle(PlayerPedId(), false) }
    end
    error('Unknown client operation')
end

RegisterNetEvent(prefix .. 'consent', function(value)
    if source ~= 65535 then return end
    optedIn = value == true
    if not optedIn then
        generation = generation + 1
        cleanup()
    end
    print(optedIn and 'Bakery test bridge enabled for this client' or 'Bakery test bridge disabled for this client')
end)

RegisterNetEvent(prefix .. 'notice', function(message)
    if source == 65535 then print(message) end
end)

RegisterNetEvent(prefix .. 'run', function(key, op, args)
    if source ~= 65535 or not optedIn then return end
    if busy then
        TriggerServerEvent(prefix .. 'result', key, false, 'Client already executing an action')
        return
    end
    busy = true
    local actionGeneration = generation
    local ok, result = pcall(run, op, args, actionGeneration)
    busy = false
    if generation ~= actionGeneration then return end
    if ok then
        local serializable, encoded = pcall(json.encode, result)
        if not serializable or #encoded > 32000 then
            ok, result = false, 'Client result is not JSON-serializable or exceeds 32 KiB'
        end
    end
    TriggerServerEvent(prefix .. 'result', key, ok, result)
end)

CreateThread(function()
    TriggerServerEvent(prefix .. 'ready')
end)

exports('reportDiagnostic', function(level, message)
    local caller = GetInvokingResource()
    if optedIn and caller and type(message) == 'string' and (level == 'error' or level == 'warning' or level == 'info') then
        TriggerServerEvent(prefix .. 'diagnostic', level, '@' .. caller .. '/client:0 ' .. message:sub(1, 1000))
    end
end)

AddEventHandler('onResourceStop', function(stopped)
    if stopped == resource then
        generation = generation + 1
        cleanup()
    end
end)
