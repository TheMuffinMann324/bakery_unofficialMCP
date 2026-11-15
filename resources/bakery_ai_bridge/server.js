const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const resource = GetCurrentResourceName();
const token = GetConvar('bakery_ai_token', '');
const port = Number(GetConvar('bakery_ai_port', '32124'));
const enabled = GetConvar('bakery_ai_enabled', '0') === '1'
    && /^[A-Za-z0-9_-]{32,128}$/.test(token)
    && Number.isInteger(port) && port >= 1024 && port <= 65535;
// Development-only switches. All default to off.
const autoOptIn = GetConvar('bakery_ai_auto_optin', '0') === '1';
const evalEnabled = GetConvar('bakery_ai_eval', '0') === '1';
const sqlEnabled = GetConvar('bakery_ai_sql', '0') === '1';

if (enabled) startBridge();
else console.log('Bakery bridge disabled. Configure the local development convars to enable it.');

function startBridge() {
    const auth = Buffer.from('Bearer ' + token);
    const players = new Map();
    const pending = new Map();
    const reports = [];
    const epoch = randomUUID();
    const started = Date.now();
    let seq = 0;
    let requests = 0;
    let profile;
    let recordingUntil;

    function report(channel, message) {
        reports.push({ seq: ++seq, at: Date.now(), channel: String(channel).slice(0, 100),
            message: String(message).replaceAll(token, '[redacted]').slice(0, 1200) });
        if (reports.length > 1000) reports.shift();
    }

    if (typeof RegisterConsoleListener === 'function') RegisterConsoleListener(report);
    on('onResourceStart', name => report('lifecycle', 'Started resource ' + name));
    on('onResourceStop', name => report('lifecycle', 'Stopped resource ' + name));
    global.exports('reportDiagnostic', (level, message) => {
        const caller = GetInvokingResource();
        if (caller && ['error', 'warning', 'info'].includes(level)) report('script:' + caller, level + ': ' + message);
    });

    function optOut(id) {
        players.delete(id);
        for (const [key, job] of pending) {
            if (job.player === id) finish(key, 'Test client opted out or disconnected');
        }
    }

    function finish(key, error, result) {
        const job = pending.get(key);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(key);
        if (error) job.reject(new Error(error));
        else job.resolve(result);
    }

    function optIn(id, how) {
        players.set(id, { session: players.get(id)?.session ?? randomUUID(), lastReport: 0 });
        emitNet('bakery_ai_bridge:consent', id, true);
        report('client', 'Test client ' + id + ' opted in' + how);
    }

    RegisterCommand('bakery_ai_test', (source, args) => {
        const id = Number(source);
        if (!id) return;
        if (args[0] === 'off') {
            emitNet('bakery_ai_bridge:consent', id, false);
            optOut(id);
            report('client', 'Test client ' + id + ' opted out');
        } else if (args[0] === 'on' && IsPlayerAceAllowed(String(id), 'bakery_ai.test')) optIn(id, '');
        else emitNet('bakery_ai_bridge:notice', id, 'Use bakery_ai_test on|off. Opt-in requires the bakery_ai.test ACE.');
    }, false);

    // The client script announces itself on every start (join or bridge restart).
    onNet('bakery_ai_bridge:ready', () => {
        const id = Number(global.source);
        if (autoOptIn && !players.has(id) && IsPlayerAceAllowed(String(id), 'bakery_ai.test')) optIn(id, ' automatically');
    });

    on('playerDropped', () => optOut(Number(global.source)));
    onNet('bakery_ai_bridge:result', (key, ok, result) => {
        const id = Number(global.source);
        const job = pending.get(key);
        if (!job || job.player !== id || players.get(id)?.session !== job.session || !IsPlayerAceAllowed(String(id), 'bakery_ai.test')) return;
        if (!ok) return finish(key, typeof result === 'string' ? result.slice(0, 500) : 'Client action failed');
        if (!result || typeof result !== 'object') return finish(key, 'Malformed client result');
        let size;
        try { size = Buffer.byteLength(JSON.stringify(result)); } catch { size = Infinity; }
        if (size > 32768) return finish(key, 'Client result exceeds 32 KiB');
        finish(key, null, result);
    });
    onNet('bakery_ai_bridge:diagnostic', (level, message) => {
        const id = Number(global.source);
        const entry = players.get(id);
        if (!entry || !IsPlayerAceAllowed(String(id), 'bakery_ai.test') || Date.now() - entry.lastReport < 200 || !['error', 'warning', 'info'].includes(level)
            || typeof message !== 'string') return;
        entry.lastReport = Date.now();
        report('client:' + id, level + ': ' + message.slice(0, 1200));
    });

    function client(args) {
        const id = args.player;
        const entry = players.get(id);
        if (!Number.isInteger(id) || !entry || args.session !== entry.session || !IsPlayerAceAllowed(String(id), 'bakery_ai.test')) {
            throw new Error('Test player is unavailable or has not opted in');
        }
        if ([...pending.values()].some(job => job.player === id)) throw new Error('Test player is already executing an action');
        return id;
    }

    function clientAction(op, args) {
        const player = client(args);
        return new Promise((resolve, reject) => {
            const key = randomUUID();
            const timer = setTimeout(() => finish(key, 'Client action timed out. Inspect state before retrying'), 4800);
            pending.set(key, { player, session: args.session, resolve, reject, timer });
            emitNet('bakery_ai_bridge:run', player, key, op, args);
        });
    }

    function screenshot(args) {
        const player = client(args);
        const modern = GetResourceState('screencapture') === 'started';
        if (!modern && GetResourceState('screenshot-basic') !== 'started') throw new Error('Start screencapture or screenshot-basic');
        return new Promise((resolve, reject) => {
            const key = randomUUID();
            const timer = setTimeout(() => finish(key, 'Screenshot timed out'), 4800);
            pending.set(key, { player, session: args.session, resolve, reject, timer });
            const accept = (err, data) => {
                    if (players.get(player)?.session !== args.session || !IsPlayerAceAllowed(String(player), 'bakery_ai.test')) {
                        return finish(key, 'Test player withdrew consent');
                    }
                    if (err || typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,') || data.length > 2800000) {
                        finish(key, 'Screenshot failed or exceeded size limit');
                    } else finish(key, null, { mimeType: 'image/jpeg', data: data.split(',')[1] });
            };
            try {
                if (modern) global.exports.screencapture.serverCapture(player, { encoding: 'jpg', maxWidth: 1280, maxHeight: 720 }, data => accept(null, data));
                else global.exports['screenshot-basic'].requestClientScreenshot(player, { encoding: 'jpg', quality: 0.55 }, accept);
            } catch (error) { finish(key, String(error)); }
        });
    }

    function resourceInfo(name) {
        if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid resource');
        return { resource: name, state: GetResourceState(name), path: GetResourcePath(name) || null };
    }

    function serverAdapter(args) {
        const player = client(args);
        const target = resourceInfo(args.resource);
        if (args.resource === resource || target.state !== 'started' || typeof args.action !== 'string'
            || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(args.action)) throw new Error('Invalid server adapter target');
        const result = global.exports[args.resource].bakeryAiTest(args.action, args.data ?? {}, args.scope ?? 'manual', player);
        if (!result || typeof result !== 'object' || typeof result.then === 'function') throw new Error('Server adapter must return a synchronous result object');
        if (result.ok === false) throw new Error(result.error ?? 'Server adapter rejected the action');
        if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new Error('Server adapter result exceeds 32 KiB');
        return result;
    }

    async function lifecycle(op, args) {
        const info = resourceInfo(args.resource);
        if (args.resource === resource || !info.path || info.path !== args.path) throw new Error('Resource path mismatch');
        if (op !== 'start' && info.state === 'started' && !StopResource(args.resource)) throw new Error('Resource stop failed');
        if (op === 'restart' && info.state === 'started') await waitState(args.resource, 'stopped');
        if (op !== 'stop' && (op === 'restart' || info.state !== 'started') && !StartResource(args.resource)) throw new Error('Resource start failed');
        return waitState(args.resource, op === 'stop' ? 'stopped' : 'started');
    }

    async function waitState(name, state) {
        for (let attempt = 0; attempt < 25; attempt++) {
            const result = resourceInfo(name);
            if (result.state === state || (state === 'stopped' && result.state === 'uninitialized')) return result;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Resource did not reach state ' + state);
    }

    // Lua runs the snippet on its own thread (so Wait() works) and calls back with the outcome.
    function serverEval(code) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Server Lua evaluation timed out after 4.8 s')), 4800);
            try {
                global.exports[resource].bakeryEval(code, reply => {
                    clearTimeout(timer);
                    if (reply && reply.ok === true) resolve(reply.result ?? {});
                    else reject(new Error(String(reply?.error ?? 'Server Lua evaluation returned no result')));
                });
            } catch (error) {
                clearTimeout(timer);
                reject(new Error('Server Lua evaluation failed to start: ' + String(error?.message ?? error)));
            }
        });
    }

    const readOnlySql = /^(select|show|describe|desc|explain|with)\b/i;
    const writeSql = /\b(?:insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|rename|call|handler|lock|unlock|set|load)\b|into\s+(?:out|dump)file|\bfor\s+(?:update|share)\b|\b(?:sleep|benchmark|load_file|get_lock|release_lock|release_all_locks)\s*\(/i;
    function sql(args) {
        if (!sqlEnabled) throw new Error('Database queries are disabled. Set bakery_ai_sql 1 in the development server.cfg');
        if (GetResourceState('oxmysql') !== 'started') throw new Error('oxmysql is not started');
        const query = String(args.query ?? '').trim().replace(/;\s*$/, '');
        if (!query || query.length > 4000 || /;|\/\*|--|#/.test(query) || !readOnlySql.test(query) || writeSql.test(query)) {
            throw new Error('Only a single read-only SELECT, SHOW, DESCRIBE, EXPLAIN or WITH query is allowed');
        }
        const params = Array.isArray(args.params) ? args.params.slice(0, 32) : [];
        const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Query timed out')), 5000);
            global.exports.oxmysql.query(query, params, rows => {
                clearTimeout(timer);
                if (!Array.isArray(rows)) return reject(new Error('Query failed. Check server_get_logs for the oxmysql error'));
                let shown = rows.slice(0, limit);
                while (shown.length > 0 && Buffer.byteLength(JSON.stringify(shown)) > 30000) shown = shown.slice(0, Math.floor(shown.length / 2));
                resolve({ rows: shown, rowCount: rows.length, truncated: shown.length < rows.length });
            });
        });
    }

    const clientOps = new Set(['state', 'spawn_vehicle', 'spawn_ped', 'spawn_object', 'delete_entity', 'entities', 'teleport',
        'weather', 'time', 'reset_environment', 'performance_client', 'adapter', 'cleanup', 'client_command', 'input', 'eval']);
    const changing = new Set();
    async function dispatch(op, args) {
        if ((op === 'eval' || op === 'server_eval') && !evalEnabled) {
            throw new Error('Lua evaluation is disabled. Set bakery_ai_eval 1 in the development server.cfg');
        }
        if (op === 'adapter' && args.side === 'server') return serverAdapter(args);
        if (op === 'server_eval') return serverEval(args.code);
        if (op === 'sql') return sql(args);
        if (clientOps.has(op)) return clientAction(op, args);
        switch (op) {
            case 'status':
                return { epoch, uptimeMs: Date.now() - started, playerCount: GetNumPlayerIndices(), resourceCount: GetNumResources(),
                    features: { autoOptIn, eval: evalEnabled, sql: sqlEnabled },
                    testClients: [...players].filter(([id]) => IsPlayerAceAllowed(String(id), 'bakery_ai.test'))
                        .map(([id, entry]) => ({ id, session: entry.session, name: GetPlayerName(String(id)), pingMs: GetPlayerPing(String(id)) })) };
            case 'resource_info':
                return resourceInfo(args.resource);
            case 'resource_start':
            case 'resource_stop':
            case 'resource_restart': {
                const name = resourceInfo(args.resource).resource;
                if (changing.has(name)) throw new Error('Resource is already changing state');
                changing.add(name);
                try { return await lifecycle(op.slice(9), args); }
                finally { changing.delete(name); }
            }
            case 'logs': {
                const count = Math.max(1, Math.min(120, Number(args.limit) || 30));
                const after = Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
                const available = reports.filter(log => log.seq > after);
                const entries = after ? available.slice(0, count) : available.slice(-count);
                return { epoch, latest: seq, next: entries.at(-1)?.seq ?? after, entries };
            }
            case 'command': {
                const { command, text } = args;
                const allowed = GetConvar('bakery_ai_commands', 'status,refresh').split(',');
                if (!allowed.includes(command) || !['status', 'refresh', 'say'].includes(command)) throw new Error('Command denied');
                if (!IsPrincipalAceAllowed('resource.' + resource, 'command.' + command)) throw new Error('Command ACE denied');
                if (command === 'say' && (typeof text !== 'string' || !/^[A-Za-z0-9 .,!?_-]{1,120}$/.test(text))) throw new Error('Invalid message');
                ExecuteCommand(command === 'say' ? 'say ' + text : command);
                return { command, dispatched: true };
            }
            case 'performance_server':
                return { source: 'FXServer Node runtime', uptimeMs: Date.now() - started, processRssBytes: process.memoryUsage.rss(),
                    bridgeHeapUsedBytes: process.memoryUsage().heapUsed, playerCount: GetNumPlayerIndices() };
            case 'profile_start':
                if (profile || ProfilerIsRecording()) throw new Error('A server profile is already active');
                if (!Number.isInteger(args.frames) || args.frames < 20 || args.frames > 2000) throw new Error('Invalid frame count');
                if (!['profiler', 'record', 'saveJSON'].every(command =>
                    IsPrincipalAceAllowed('resource.' + resource, 'command.' + command))) throw new Error('Profiler ACE denied');
                ExecuteCommand('profiler record ' + args.frames);
                profile = { id: randomUUID(), frames: args.frames };
                recordingUntil = Date.now() + 500;
                return profile;
            case 'profile_stop': {
                if (!profile) throw new Error('No bridge profile has been started');
                if (Date.now() < recordingUntil || ProfilerIsRecording()) return { ...profile, state: 'recording' };
                const filename = 'bakery-profile-' + profile.id + '.json';
                ExecuteCommand('profiler saveJSON ' + filename);
                const result = { ...profile, state: 'save_requested', filename };
                profile = undefined;
                return result;
            }
            case 'screenshot':
                return screenshot(args);
            default:
                throw new Error('Unknown bridge operation');
        }
    }

    const server = http.createServer({ requestTimeout: 8000, headersTimeout: 4000, maxHeaderSize: 8192 }, (req, res) => {
        const reply = (status, body) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        const provided = Buffer.from(req.headers.authorization ?? '');
        if (req.socket.remoteAddress !== '127.0.0.1' || provided.length !== auth.length || !timingSafeEqual(provided, auth)) {
            return reply(401, { ok: false, error: 'Unauthorized' });
        }
        if (req.headers.origin !== undefined) return reply(403, { ok: false, error: 'Browser requests are not allowed' });
        if (req.url !== '/v1' || req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
            return reply(404, { ok: false, error: 'Unknown route' });
        }
        if (Number(req.headers['content-length']) > 32768) return reply(413, { ok: false, error: 'Request is too large' });
        if (requests >= 32) return reply(429, { ok: false, error: 'Bridge is busy' });
        requests++;
        res.once('close', () => { requests--; });
        let bytes = 0;
        const chunks = [];
        req.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 32768) { req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            let input;
            try { input = JSON.parse(Buffer.concat(chunks).toString()); }
            catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
            if (!input || typeof input.op !== 'string' || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
                return reply(400, { ok: false, error: 'Expected op and args' });
            }
            setImmediate(async () => {
                if (res.destroyed) return;
                try { reply(200, { ok: true, result: await dispatch(input.op, input.args) }); }
                catch (error) { reply(400, { ok: false, error: String(error.message ?? error).replaceAll(token, '[redacted]').slice(0, 500) }); }
            });
        });
    });
    server.maxConnections = 64;
    server.setTimeout(10000, socket => socket.destroy());
    server.on('error', error => console.error('Bakery bridge listener:', error.code));
    server.listen(port, '127.0.0.1');
    on('onResourceStop', stopped => {
        if (stopped !== resource) return;
        for (const key of pending.keys()) finish(key, 'Bridge is stopping');
        server.close();
        server.closeAllConnections();
    });
}

