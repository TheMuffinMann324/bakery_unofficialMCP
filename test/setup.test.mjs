// Setup script, config validation messages and token sources.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const setupScript = fileURLToPath(new URL("../scripts/setup.mjs", import.meta.url));
const bridge = new URL("../resources/bakery_ai_bridge/", import.meta.url);
const run = promisify(execFile);

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

// Starts the MCP over stdio with the given config object and returns a tool caller.
async function mcp(t, dir, config) {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify(config));
  const client = new Client({ name: "setup-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { BAKERY_FIVEM_CONFIG: file, BAKERY_FIVEM_STATE_DIR: join(dir, "state") }, stderr: "pipe" }));
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
}

test("a broken config.json keeps the MCP running and explains the mistake", async t => {
  const dir = await temp(t, "bakery-config-");
  await mkdir(join(dir, "resources"));
  // The real-world mistake: the token pasted into tokenEnv instead of an environment variable name.
  const call = await mcp(t, dir, { workspace: join(dir, "resources"), servers: [{ id: "dev", environment: "development", cwd: dir,
    resources: "resources", bridgePort: 32124, tokenEnv: randomBytes(32).toString("hex") }] });
  const status = await call("server_get_status");
  assert.equal(status.success, false);
  assert.match(status.error, /servers\[0\]\.tokenEnv: tokenEnv is the NAME of an environment variable/);
  assert.match(status.error, /npm run setup/);
  assert.equal((await call("knowledge_sources")).success, true, "documentation tools still work");
});

test("tokenConfig alone is enough and accepts unquoted token lines", async t => {
  const dir = await temp(t, "bakery-config-");
  await mkdir(join(dir, "resources"));
  const token = randomBytes(32).toString("hex");
  await writeFile(join(dir, "server.cfg"), "  set bakery_ai_token " + token + "  # dev only\n");
  const seen = [];
  const fake = await listen((req, res) => {
    seen.push(req.headers.authorization);
    res.end(JSON.stringify({ ok: true, result: { testClients: [] } }));
  });
  t.after(fake.close);
  const call = await mcp(t, dir, { workspace: join(dir, "resources"), servers: [{ id: "dev", environment: "development", cwd: dir,
    resources: "resources", bridgePort: fake.port, tokenConfig: "server.cfg" }] });
  assert.equal((await call("server_get_status")).success, true);
  assert.deepEqual(seen, ["Bearer " + token]);
});

test("setup installs the bridge, manages server.cfg and config.json, and is safe to rerun", async t => {
  const root = await temp(t, "bakery-setup-");
  const server = join(root, "server data");
  await mkdir(join(server, "resources", "[custom]"), { recursive: true });
  const originalCfg = "endpoint_add_tcp \"0.0.0.0:30120\"\r\nensure [custom]\r\n";
  await writeFile(join(server, "server.cfg"), originalCfg);
  const config = join(root, "config.json");
  // An untouched example entry pointing at a missing folder is dropped instead of clashing on the port.
  await writeFile(config, JSON.stringify({ servers: [{ id: "dev", environment: "development", cwd: "C:/FiveM/server-data",
    resources: "resources", bridgePort: 32124, tokenEnv: "X" }] }));
  const env = { ...process.env, BAKERY_FIVEM_CONFIG: config };
  // --yes never registers with Claude Code (no --register here), so this cannot touch the real client config.
  const setup = (...extra) => run(process.execPath, [setupScript, "--server", server, "--yes", ...extra], { env });

  await setup("--license", "0123456789abcdef0123456789abcdef01234567", "--extras");
  const cfg = await readFile(join(server, "server.cfg"), "utf8");
  assert.match(cfg, /^# BEGIN fivem-unofficial-mcp/);
  assert.match(cfg, /\r\nset bakery_ai_port 32124\r\n/, "keeps CRLF line endings");
  assert.match(cfg, /add_ace identifier\.license:0123456789abcdef0123456789abcdef01234567 bakery_ai\.test allow/);
  assert.match(cfg, /set bakery_ai_eval 1/);
  assert.match(cfg, /ensure bakery_ai_bridge/, "the bridge is outside [custom], so the block starts it");
  const token = /bakery_ai_token "([0-9a-f]{64})"/.exec(cfg)[1];
  assert.equal(await readFile(join(server, "server.cfg.before-fivem-mcp"), "utf8"), originalCfg);
  for (const file of ["fxmanifest.lua", "client.lua", "server.js", "server.lua", "eval.lua"]) {
    assert.equal(await readFile(join(server, "resources", "bakery_ai_bridge", file), "utf8"), await readFile(new URL(file, bridge), "utf8"));
  }
  const written = JSON.parse(await readFile(config, "utf8"));
  assert.equal(written.servers.length, 1);
  const { cwd: _cwd, ...entryFields } = written.servers[0];
  assert.deepEqual(entryFields, { id: "server_data", environment: "development", resources: "resources", bridgePort: 32124, tokenConfig: "server.cfg" });

  await setup();
  const again = await readFile(join(server, "server.cfg"), "utf8");
  assert.equal(again.match(/# BEGIN fivem-unofficial-mcp/g).length, 1);
  assert.equal(/bakery_ai_token "([0-9a-f]{64})"/.exec(again)[1], token, "rerun keeps the token");
  assert.doesNotMatch(again, /bakery_ai_eval/, "rerun without --extras turns extras off");
  assert.doesNotMatch(again, /\r\n\r\n\r\n/, "blank lines do not pile up");
  assert.equal(JSON.parse(await readFile(config, "utf8")).servers.length, 1);

  const fake = await listen((req, res) => {
    const authorized = req.headers.authorization === "Bearer " + token;
    res.writeHead(authorized ? 200 : 401);
    res.end(JSON.stringify(authorized ? { ok: true, result: { playerCount: 0, resourceCount: 3, testClients: [], features: {} } } : { ok: false }));
  });
  t.after(fake.close);
  const saved = JSON.parse(await readFile(config, "utf8"));
  saved.servers[0].bridgePort = fake.port;
  await writeFile(config, JSON.stringify(saved));
  const { stdout } = await run(process.execPath, [setupScript, "--check"], { env });
  assert.match(stdout, /Bridge connected: 0 player\(s\), 3 resources/);
  assert.match(stdout, /Everything needed is working/);
});

test("setup adopts bridge settings that were added to server.cfg by hand", async t => {
  const root = await temp(t, "bakery-setup-");
  const token = randomBytes(32).toString("hex");
  const original = "set bakery_ai_enabled 1\nset bakery_ai_port 32150\nset bakery_ai_token \"" + token + "\"\nensure bakery_ai_bridge\n";
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "server.cfg"), original);
  const config = join(root, "config.json");
  await run(process.execPath, [setupScript, "--server", root, "--yes"], { env: { ...process.env, BAKERY_FIVEM_CONFIG: config } });
  assert.equal(await readFile(join(root, "server.cfg"), "utf8"), original, "server.cfg is left alone");
  assert.equal(JSON.parse(await readFile(config, "utf8")).servers[0].bridgePort, 32150);
});

test("check explains an unreachable bridge in plain words", async t => {
  const root = await temp(t, "bakery-check-");
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "server.cfg"), "set bakery_ai_token \"" + randomBytes(32).toString("hex") + "\"\n");
  const config = join(root, "config.json");
  // Nothing listens on port 1024 in the test environment.
  await writeFile(config, JSON.stringify({ workspace: join(root, "resources"), servers: [{ id: "dev", environment: "development", cwd: root,
    resources: "resources", bridgePort: 1024, tokenConfig: "server.cfg" }] }));
  const result = await run(process.execPath, [setupScript, "--check"], { env: { ...process.env, BAKERY_FIVEM_CONFIG: config } })
    .then(() => assert.fail("check should report a problem"), error => error);
  assert.match(result.stdout, /bakery_ai_bridge is not in/);
  assert.match(result.stdout, /Nothing answers on port 1024/);
});
