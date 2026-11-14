import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import luaparse from "luaparse";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const bridge = new URL("../resources/bakery_ai_bridge/", import.meta.url);
const uuid = "00000000-0000-4000-8000-000000000001";

async function setup(t, extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "bakery-fivem-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const resources = join(cwd, "resources");
  await mkdir(resources);
  const config = join(cwd, "config.json");
  const token = randomBytes(32).toString("hex");
  const connect = async (servers, extra = {}) => {
    await writeFile(config, JSON.stringify({ workspace: resources, servers, ...extra }));
    const env = { BAKERY_FIVEM_CONFIG: config, BAKERY_FIVEM_STATE_DIR: join(cwd, "state"), BAKERY_TEST_TOKEN: token };
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
    const client = new Client({ name: "bakery-test", version: "0.1.0" });
    await client.connect(transport);
    return { client, close: () => client.close(), call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
      assert.ok(result.structuredContent, JSON.stringify(result.content));
      return result.structuredContent;
    } };
  };
  const server = { id: "dev", environment: "development", cwd, resources, tokenEnv: "BAKERY_TEST_TOKEN", ...extra };
  return { cwd, resources, token, connect, server };
}

test("MCP workspace tools create, edit, page and enforce revision and deletion boundaries", async t => {
  const fixture = await setup(t);
  const { client, call, close } = await fixture.connect([]);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    for (const expected of ["dev_cycle", "nui_snapshot", "nui_act", "client_get_logs", "wait_for", "game_input", "lua_eval", "db_query", "game_screenshot"]) {
      assert.ok(names.includes(expected), expected);
    }
    for (const description of tools.map(tool => tool.description)) assert.ok(description.length <= 400, description);
    assert.ok((await call("resource_create", { resource: "example" })).success);
    assert.deepEqual((await call("resource_list")).resources, ["example"]);
    const current = await call("resource_read", { resource: "example", file: "client.lua" });
    assert.match(current.content, /Client-side/);
    assert.ok((await call("resource_edit", { resource: "example", file: "client.lua", content: "print('hello')", expectedSha256: current.sha256 })).success);
    assert.equal((await call("resource_edit", { resource: "example", file: "client.lua", content: "stale", expectedSha256: current.sha256 })).success, false);
    assert.ok((await call("resource_edit", { resource: "example", file: "web/index.html", content: "<p>Hello</p>", expectedSha256: null })).success);
    assert.equal((await call("resource_read", { resource: "example", file: "web/index.html" })).content, "<p>Hello</p>");
    assert.equal((await call("resource_read", { resource: "example", file: "../config.json" })).success, false);
    const request = await call("resource_delete", { resource: "example" });
    assert.ok(request.approvalRequired);
    assert.equal((await call("resource_delete", { resource: "example", approvalId: request.requestId })).success, false);
    assert.deepEqual((await call("resource_list")).resources, ["example"]);
  } finally { await close(); }
});

test("scenario RPC runs ordered actions, captures assertion failures and cleans up", async t => {
  const fixture = await setup(t);
  const seen = [];
  const fake = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + fixture.token);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { op, args } = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(op);
    const result = op === "status" ? { testClients: [{ id: 1, session: uuid }] } :
      op === "logs" ? { epoch: uuid, latest: 0, entries: [] } :
      op === "state" ? { health: 200, hour: 12 } : {};
    if (op === "state" || op === "cleanup") assert.equal(args.session, uuid);
    if (op === "time") assert.equal(args.hour, 12);
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
  const { call, close } = await fixture.connect([{ ...fixture.server, bridgePort: fake.address().port }]);
  try {
    const created = await call("test_create_scenario", { scenario: { name: "health", steps: [
      { type: "action", action: "state", saveAs: "before" },
      { type: "action", action: "time", bind: { hour: { from: "before", path: "hour" } } },
      { type: "assert", check: { from: "before", path: "health", value: 201 } },
    ] } });
    assert.ok(created.success);
    const run = await call("test_execute_scenario", { server: "dev", scenario: "health", participants: { default: 1 } });
    assert.equal(run.state, "failed");
    assert.equal(run.passed, 2);
    assert.equal(run.failed[0].step, 3);
    assert.deepEqual(seen, ["status", "logs", "state", "time", "cleanup", "logs"]);
    assert.equal((await call("test_get_results", { id: run.id })).state, "failed");
  } finally {
    await close();
    await new Promise(resolve => fake.close(resolve));
  }
});

test("client tools resolve the only test client, map named controls and enforce the command allowlist", async t => {
  const fixture = await setup(t);
  const seen = [];
  const fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { op, args } = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ op, args });
    const result = op === "status" ? { testClients: [{ id: 7, session: uuid }] } : { ok: true };
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
  const { call, close } = await fixture.connect([{ ...fixture.server, bridgePort: fake.address().port, allowClientCommands: ["racing"] }]);
  try {
    assert.ok((await call("game_input", { controls: [{ control: "accelerate" }, { control: "steer", value: -0.5 }, { control: "forward" }, { control: "left", value: 0.5 }], durationMs: 500 })).success);
    const input = seen.find(entry => entry.op === "input").args;
    assert.deepEqual(input.controls, [{ control: 71, value: 1 }, { control: 59, value: -0.5 }, { control: 31, value: -1 }, { control: 30, value: -0.5 }]);
    assert.equal(input.player, 7);
    assert.equal(input.session, uuid);
    assert.ok((await call("game_execute_command", { command: "racing" })).success);
    const denied = await call("game_execute_command", { command: "quit" });
    assert.equal(denied.success, false);
    assert.match(denied.error, /allowClientCommands/);
    assert.equal(seen.filter(entry => entry.op === "client_command").length, 1);
    assert.equal((await call("wait_for", { timeoutMs: 100 })).success, false);
  } finally {
    await close();
    await new Promise(resolve => fake.close(resolve));
  }
});

test("client_get_logs filters by level and resource and pages with a cursor", async t => {
  const fixture = await setup(t);
  const logs = join(fixture.cwd, "client-logs");
  await mkdir(logs);
  const path = join(logs, "CitizenFX_log_2026-11-13T000000.log");
  const line = (t, thread, message) => `[${String(t).padStart(10)}] [FiveM_b3407_GT] ${thread.padStart(20)}/ ${message}\r\n`;
  await writeFile(path, line(1, "MainThrd", "Started resource bakery_racing")
    + line(2, "MainThrd", "SCRIPT ERROR: @bakery_racing/client/main.lua:10: attempt to index a nil value")
    + "  stack traceback line\r\n"
    + line(3, "CrBrowserMain", "Uncaught TypeError: x is undefined (@bakery_racing/web/dist/index.js:1)")
    + line(4, "CrBrowserMain", "Uncaught TypeError: other (@npwd/dist/index.js:1)"));
  const { call, close } = await fixture.connect([], { clientLogDir: logs });
  try {
    const errors = await call("client_get_logs", { level: "error", resource: "bakery_racing" });
    assert.equal(errors.entries.length, 2);
    assert.match(errors.entries[0], /stack traceback line/);
    const first = await call("client_get_logs", { after: "CitizenFX_log_2026-11-13T000000.log:0", limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.ok(first.more);
    const rest = await call("client_get_logs", { after: first.next, limit: 10 });
    assert.equal(rest.entries.length, 2);
    assert.match(rest.entries[1], /npwd/);
    await writeFile(path, line(5, "MainThrd", "Bakery ready"), { flag: "a" });
    const waited = await call("wait_for", { clientLog: "bakery ready", timeoutMs: 1000 });
    assert.equal(waited.met, false, "only lines written after the call count");
    const tail = await call("client_get_logs", { after: rest.next });
    assert.deepEqual(tail.entries, ["[5 MainThrd] Bakery ready"]);
  } finally { await close(); }
});

test("Lua bridge and manifest parse", async () => {
  for (const file of ["client.lua", "server.lua", "eval.lua", "fxmanifest.lua"]) {
    luaparse.parse(await readFile(new URL(file, bridge), "utf8"), { luaVersion: "5.3" });
  }
});

test("MCP knowledge tools search cached sources offline and return bounded line ranges", async t => {
  const fixture = await setup(t);
  const cache = join(fixture.cwd, "state", "knowledge");
  await mkdir(cache, { recursive: true });
  const save = async (source, documents) => writeFile(join(cache, source + ".json"), JSON.stringify({
    version: 1, updated: "2026-11-13T00:00:00.000Z", documents,
  }));
  await save("fivem", [
    { id: "native/CFX/0xDD75460A", title: "CREATE_VEHICLE", kind: "native", apiSet: "server",
      url: "https://docs.fivem.net/natives/?0xDD75460A", keywords: "0xDD75460A", text: "# CREATE_VEHICLE\nServer signature\nParameters" },
    { id: "native/VEHICLE/0xAF35D0D2583051B0", title: "CREATE_VEHICLE", kind: "native", apiSet: "client",
      text: "# CREATE_VEHICLE\nClient signature" },
  ]);
  await save("qbx", [{ id: "docs/qbx.mdx", title: "Qbox exports", kind: "guide", text: "## GetPlayer\nThe qbx_core player export." }]);
  await save("qbcore", [{ id: "docs/qb.md", title: "QBCore exports", kind: "guide", text: "## GetPlayer\nThe QBCore player function." }]);
  const { call, close } = await fixture.connect([]);
  try {
    const { sources } = await call("knowledge_sources");
    assert.equal(sources.length, 7);
    assert.equal(sources.find(source => source.source === "fivem").counts.native, 2);
    assert.equal(sources.find(source => source.source === "oxmysql").ready, false);
    const native = await call("knowledge_search", { query: "CreateVehicle", kind: "native", apiSet: "server" });
    assert.equal(native.results.length, 1);
    assert.equal(native.results[0].id, "native/CFX/0xDD75460A");
    assert.equal((await call("knowledge_search", { query: "0xDD75460A" })).results[0].id, native.results[0].id);
    const qbox = await call("knowledge_search", { query: "qbx_core GetPlayer" });
    assert.deepEqual(qbox.results.map(result => result.source), ["qbx"]);
    const page = await call("knowledge_read", { source: "fivem", id: native.results[0].id, from: 2, lines: 1 });
    assert.equal(page.content, "Server signature");
    assert.equal(page.next, 3);
    assert.equal(page.url, native.results[0].url);
    assert.equal((await call("knowledge_read", { source: "fivem", id: "../../config.json" })).success, false);
  } finally { await close(); }
});

test("isolated FXServer runs the bridge, deploys and profiles a resource", {
  skip: !process.env.BAKERY_SMOKE_FXSERVER || !process.env.BAKERY_SMOKE_LICENSE_CFG,
  timeout: 60000,
}, async t => {
  const fixture = await setup(t, { executable: process.env.BAKERY_SMOKE_FXSERVER, bridgePort: 33124 });
  const config = await readFile(process.env.BAKERY_SMOKE_LICENSE_CFG, "utf8");
  const license = /^\s*sv_licenseKey\s+[^\r\n]+/mi.exec(config)?.[0].trim();
  assert.ok(license, "Expected a license directive for this local smoke test");
  await cp(bridge, join(fixture.resources, "bakery_ai_bridge"), { recursive: true });
  await writeFile(join(fixture.cwd, "server.cfg"), [
    "endpoint_add_tcp \"127.0.0.1:33125\"", "endpoint_add_udp \"127.0.0.1:33125\"",
    "sv_master1 \"\"", "sv_maxclients 2", "sv_hostname \"Bakery smoke test\"", license,
    "set bakery_ai_enabled 1", "set bakery_ai_port 33124", "set bakery_ai_token " + fixture.token,
    ...["refresh", "status", "profiler", "record", "saveJSON"].map(command => "add_ace resource.bakery_ai_bridge command." + command + " allow"),
    "ensure bakery_ai_bridge",
  ].join("\n"));
  const { call, close } = await fixture.connect([fixture.server]);
  const scoped = { server: "dev" };
  try {
    const started = await call("server_lifecycle", { ...scoped, action: "start" });
    if (started.state !== "ready") {
      const logs = await call("server_get_logs", { ...scoped, limit: 12 });
      const detail = JSON.stringify({ started, logs }).replaceAll(license, "[license directive]").replace(/cfxk_[\w-]+/g, "[redacted]");
      assert.fail(detail);
    }
    assert.equal(started.playerCount, 0);
    assert.equal((await fetch("http://127.0.0.1:33124/v1")).status, 401);
    const create = await call("resource_create", { resource: "bakery_smoke" });
    assert.ok(create.success, JSON.stringify(create));
    const script = await call("resource_read", { resource: "bakery_smoke", file: "server.lua" });
    const edit = await call("resource_edit", { resource: "bakery_smoke", file: "server.lua",
      expectedSha256: script.sha256, content: [
        "exports.bakery_ai_bridge:reportDiagnostic('warning', 'Bakery test warning')",
        "CreateThread(function() while true do Wait(0) end end)",
      ].join("\n") });
    assert.ok(edit.success, JSON.stringify(edit));
    const deploy = await call("resource_deploy", { ...scoped, resource: "bakery_smoke" });
    assert.equal(deploy.live?.state, "started", JSON.stringify(deploy));
    const restart = await call("resource_control", { ...scoped, resource: "bakery_smoke", action: "restart" });
    assert.equal(restart.state, "started", JSON.stringify(restart));
    const warnings = await call("server_get_logs", { ...scoped, resource: "bakery_smoke", level: "warning" });
    assert.equal(warnings.entries.filter(entry => entry.includes("Bakery test warning")).length, 1);
    const metrics = await call("performance_get", { ...scoped, target: "server" });
    assert.ok(metrics.processRssBytes > 0, JSON.stringify(metrics));
    const record = await call("performance_profile", { ...scoped, action: "start", frames: 20 });
    assert.ok(record.success, JSON.stringify(record));
    let profile;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(250);
      profile = await call("performance_profile", { ...scoped, action: "stop" });
      if (profile.state !== "recording") break;
    }
    assert.equal(profile?.state, "saved", JSON.stringify(profile));
    const ticks = await call("performance_get_resource", { ...scoped, resource: "bakery_smoke", profileId: profile.id });
    if (!ticks.tickMs?.samples) {
      const trace = JSON.parse(await readFile(profile.path, "utf8"));
      const sample = [...new Set(trace.traceEvents.map(event => event.name))].slice(0, 35);
      assert.fail(JSON.stringify({ ticks, sample }));
    }
    const stopped = await call("resource_control", { ...scoped, resource: "bakery_smoke", action: "stop" });
    assert.equal(stopped.state, "stopped", JSON.stringify(stopped));
    assert.equal((await call("server_lifecycle", { ...scoped, action: "stop" })).state, "stopped");
    assert.equal((await call("server_get_status", scoped)).managed, false);
  } finally { await close(); }
});

