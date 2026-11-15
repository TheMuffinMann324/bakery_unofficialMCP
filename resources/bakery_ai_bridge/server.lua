-- Server-side Lua evaluation for server.js (same resource, different runtime).
-- The snippet runs on its own Lua thread so it may call Wait(); the result is reported through `done`.
exports('bakeryEval', function(code, done)
    if GetInvokingResource() ~= GetCurrentResourceName() or GetConvar('bakery_ai_eval', '0') ~= '1' then
        return done({ ok = false, error = 'Server Lua evaluation is disabled or caller is not authorized' })
    end
    CreateThread(function()
        local ok, result = pcall(BakeryEval, code)
        local reply
        if not ok then
            reply = { ok = false, error = tostring(result) }
        else
            local encodable, encoded = pcall(json.encode, result)
            if not encodable or #encoded > 32000 then
                reply = { ok = false, error = 'Result is not JSON-serializable or exceeds 32 KiB' }
            else
                reply = { ok = true, result = result }
            end
        end
        done(reply)
    end)
end)

