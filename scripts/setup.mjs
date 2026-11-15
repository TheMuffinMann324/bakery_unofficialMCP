// Guided setup and health check for FiveM Unofficial MCP.
//
//   npm run setup                      ask a few questions, then configure everything
//   npm run setup -- --server <folder> [--resources <folder>] [--port 32124]
//                    [--license <license:...>] [--extras] [--yes] [--register]
//   --yes accepts every default without asking. It never registers with Claude Code unless --register is also given.
//   npm run check                      explain what is (or is not) working
//
// Setup installs the bridge resource, adds a managed block to server.cfg (backing it up first),
// writes config.json, and prints the line to connect your MCP client. Re-running it is safe.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const bundledBridge = join(project, "resources", "bakery_ai_bridge");
const bridgeFiles = ["fxmanifest.lua", "client.lua", "server.js", "server.lua", "eval.lua"];
const entry = join(project, "dist", "index.js").replaceAll("\\", "/");
const configFile = resolve(process.env.BAKERY_FIVEM_CONFIG ?? join(project, "config.json"));
const BEGIN = "# BEGIN fivem-unofficial-mcp (managed by npm run setup; edits inside are replaced)";
const END = "# END fivem-unofficial-mcp";

const args = parseArgs(process.argv.slice(2));
const color = (code, text) => process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const ok = text => console.log(color(32, "  ✓ ") + text);
const warn = text => console.log(color(33, "  ! ") + text);
const fail = text => console.log(color(31, "  ✗ ") + text);
const slash = path => path.replaceAll("\\", "/");

function parseArgs(list) {
  const out = { yes: false, extras: false, check: false, register: false };
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, "");
    if (["yes", "extras", "check", "register"].includes(key)) out[key] = true;
    else if (["server", "resources", "port", "license"].includes(key) && list[i + 1] !== undefined) out[key] = list[++i];
    else throw new Error("Unknown option " + list[i] + ". See the top of scripts/setup.mjs for usage");
  }
  return out;
}

async function ask(rl, question, fallback = "") {
  if (args.yes || !rl) return fallback;
  const answer = (await rl.question(question + (fallback ? ` [${fallback}]` : "") + ": ")).trim().replace(/^["']|["']$/g, "");
  return answer || fallback;
}

const yesNo = async (rl, question, fallback) =>
  /^y/i.test(await ask(rl, question + (fallback ? " (Y/n)" : " (y/N)"), fallback ? "y" : "n"));

const tokenFromCfg = text => /^[ \t]*set[ \t]+bakery_ai_token[ \t]+"?([A-Za-z0-9_-]{32,128})"?[ \t]*(?:#.*)?$/m.exec(text)?.[1];
const portFromCfg = text => Number(/^[ \t]*set[ \t]+bakery_ai_port[ \t]+"?(\d+)"?/m.exec(text)?.[1]) || undefined;
const versionOf = text => /^\s*version\s+'([^']+)'/m.exec(text)?.[1];

/** Finds an installed bakery_ai_bridge (directly in resources or one [category] deep). */
async function findBridge(resources) {
  const direct = join(resources, "bakery_ai_bridge");
  if (existsSync(join(direct, "fxmanifest.lua"))) return direct;
  for (const item of await readdir(resources, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory() || !item.name.startsWith("[")) continue;
    const nested = join(resources, item.name, "bakery_ai_bridge");
    if (existsSync(join(nested, "fxmanifest.lua"))) return nested;
  }
}

function managedBlock({ port, token, license, extras, ensure }) {
  return [
    BEGIN,
    "set bakery_ai_enabled 1",
    `set bakery_ai_port ${port}`,
    `set bakery_ai_token "${token}"`,
    ...["status", "refresh", "profiler", "record", "saveJSON"].map(c => `add_ace resource.bakery_ai_bridge command.${c} allow`),
    ...(license ? [`add_ace identifier.${license} bakery_ai.test allow`] : []),
    ...(extras ? ["set bakery_ai_auto_optin 1", "set bakery_ai_eval 1", "set bakery_ai_sql 1"] : []),
    ...(ensure ? ["ensure bakery_ai_bridge"] : []),
    END,
  ];
}

async function setup() {
  console.log("\nFiveM Unofficial MCP setup\n");
  if (!existsSync(join(project, "dist", "index.js"))) throw new Error("dist/index.js is missing. Run npm ci, then npm run setup again");
  const rl = args.yes ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 1. Server folder
    let server;
    for (;;) {
      server = resolve(await ask(rl, "Folder that contains your development server.cfg", args.server ?? ""));
      if (existsSync(join(server, "server.cfg"))) break;
      if (args.yes || !rl) throw new Error("No server.cfg found in " + server);
      fail("No server.cfg in " + server + ". Try again.");
    }
    ok("Found " + join(server, "server.cfg"));

    // 2. Resources folder
    const resources = resolve(server, await ask(rl, "Resources folder", args.resources ?? "resources"));
    if (!(await stat(resources).catch(() => undefined))?.isDirectory()) throw new Error("Resources folder not found: " + resources);

    // 3. Bridge resource: install or update in place.
    const installed = await findBridge(resources);
    const target = installed ?? join(resources, "bakery_ai_bridge");
    const bundledVersion = versionOf(await readFile(join(bundledBridge, "fxmanifest.lua"), "utf8"));
    const installedVersion = installed ? versionOf(await readFile(join(installed, "fxmanifest.lua"), "utf8")) : undefined;
    await mkdir(target, { recursive: true });
    for (const file of bridgeFiles) await copyFile(join(bundledBridge, file), join(target, file));
    ok(installed ? `Updated bridge ${installedVersion ?? "?"} -> ${bundledVersion} in ${target}` : `Installed bridge ${bundledVersion} to ${target}`);

    // 4. server.cfg
    const cfgPath = join(server, "server.cfg");
    const original = await readFile(cfgPath, "utf8");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const start = lines.findIndex(line => line.startsWith("# BEGIN fivem-unofficial-mcp"));
    const end = lines.findIndex(line => line.startsWith(END));
    const outside = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
    const manual = outside.filter(line => /^\s*set[rs]?\s+bakery_ai_(enabled|port|token)\b/.test(line));
    const existingToken = tokenFromCfg(original);
    let port = Number(args.port) || portFromCfg(original) || 32124;
    if (manual.length) {
      // The user already set the bridge up by hand: keep their lines and adopt the token and port.
      if (!existingToken) throw new Error("server.cfg has bakery_ai settings but no valid token line. Fix it or remove those lines and rerun setup");
      warn("server.cfg already has your own bakery_ai settings, so setup leaves server.cfg unchanged and uses them");
    } else {
      const licenseInput = args.license ?? await ask(rl, "Your FiveM license for in-game test tools (license:xxxx, Enter to skip)", "");
      const license = licenseInput ? normalizeIdentifier(licenseInput) : undefined;
      const extras = args.extras || await yesNo(rl, "Enable developer extras (auto opt-in, lua_eval, read-only db_query)?", false);
      const relativeBridge = slash(relative(resources, target));
      const startedElsewhere = outside.some(line => {
        const match = /^\s*(?:ensure|start)\s+(\S+)/.exec(line);
        return match && (match[1] === "bakery_ai_bridge" || relativeBridge.startsWith(match[1] + "/"));
      });
      const block = managedBlock({ port, token: existingToken ?? randomBytes(32).toString("hex"), license, extras, ensure: !startedElsewhere });
      // The block goes at the very top so the settings exist before anything starts the bridge.
      const rest = [...outside];
      while (rest.length > 1 && rest[0].trim() === "") rest.shift();
      const updated = [...block, "", ...rest].join(newline);
      if (updated !== original) {
        const backup = cfgPath + ".before-fivem-mcp";
        if (!existsSync(backup)) await writeFile(backup, original);
        await writeFile(cfgPath, updated);
        ok("Updated server.cfg (original saved as server.cfg.before-fivem-mcp)");
      } else ok("server.cfg already up to date");
      if (!license) warn("No license given: server and docs tools work; in-game tools need one (rerun setup to add it)");
    }

    // 5. config.json
    let config = {};
    if (existsSync(configFile)) {
      try { config = JSON.parse(await readFile(configFile, "utf8")); }
      catch { warn("Existing config.json was not valid JSON; saved it as config.json.bak and replaced it"); await copyFile(configFile, configFile + ".bak"); }
    }
    const id = basename(server).toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[-]/, "_").slice(0, 48) || "dev";
    // Drop entries whose folder has no server.cfg, such as the untouched example from config.example.json.
    const servers = (Array.isArray(config.servers) ? config.servers : []).filter(item => {
      const keep = typeof item?.cwd === "string" && existsSync(join(resolve(dirname(configFile), item.cwd), "server.cfg"));
      if (!keep) warn("Removed config.json server " + (item?.id ?? "?") + ": no server.cfg in " + item?.cwd);
      return keep;
    });
    const index = servers.findIndex(item => typeof item?.cwd === "string" && resolve(dirname(configFile), item.cwd) === server);
    const previous = index >= 0 ? servers[index] : {};
    const { tokenEnv: _dropped, ...kept } = previous;
    const next = { ...kept, id: previous.id ?? id, environment: "development", cwd: slash(server), resources: slash(relative(server, resources)) || ".",
      bridgePort: port, tokenConfig: "server.cfg" };
    if (index >= 0) servers[index] = next;
    else {
      if (servers.some(item => item?.id === next.id)) next.id = next.id + "_" + (servers.length + 1);
      if (servers.some(item => item?.bridgePort === port)) throw new Error("Another server in config.json already uses bridge port " + port + ". Rerun with --port <other>");
      servers.push(next);
    }
    config = { ...config, workspace: config.workspace ?? slash(resources), servers };
    await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
    ok("Wrote " + configFile);

    // 6. Client registration
    console.log("\nConnect your MCP client (pick one):");
    console.log(color(36, "  Claude Code:    ") + `claude mcp add --transport stdio --scope user fivem-unofficial -- node "${entry}"`);
    console.log(color(36, "  Codex:          ") + `codex mcp add fivem-unofficial -- node "${entry}"`);
    console.log(color(36, "  Claude Desktop: ") + `add to claude_desktop_config.json -> "mcpServers": { "fivem-unofficial": { "command": "node", "args": ["${entry}"] } }`);
    // Registering changes the user's Claude Code config, so it needs an explicit yes (or --register).
    // --yes alone never registers. The claude CLI is only probed when registration could happen.
    const wantsRegister = args.register || (!args.yes && Boolean(rl));
    const claude = wantsRegister && spawnSync("claude", ["--version"], { shell: process.platform === "win32", stdio: "ignore" }).status === 0;
    if (claude && (args.register || await yesNo(rl, "\nClaude Code is installed. Register the MCP with it now?", false))) {
      const quoted = process.platform === "win32" ? `"${entry}"` : entry;
      const result = spawnSync("claude", ["mcp", "add", "--transport", "stdio", "--scope", "user", "fivem-unofficial", "--", "node", quoted],
        { shell: process.platform === "win32", encoding: "utf8" });
      if (result.status === 0) ok("Registered fivem-unofficial with Claude Code");
      else warn("Claude Code said: " + (result.stderr || result.stdout).trim().split(/\r?\n/)[0] + " (already registered is fine)");
    }

    console.log("\nNext: restart FXServer so it loads the bridge, then restart your MCP client.");
    console.log("Then run " + color(36, "npm run check") + " to confirm everything is connected.\n");
  } finally { rl?.close(); }
}

function normalizeIdentifier(value) {
  const text = value.trim().toLowerCase().replace(/^identifier\./, "");
  if (/^license:[0-9a-f]{40}$/.test(text)) return text;
  if (/^[0-9a-f]{40}$/.test(text)) return "license:" + text;
  if (/^fivem:\d+$/.test(text)) return text;
  throw new Error("Expected a license like license:0123...(40 hex characters) or fivem:12345, got " + value);
}

async function check() {
  console.log("\nFiveM Unofficial MCP check\n");
  let problems = 0;
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok("Node.js " + process.versions.node);
  else { fail("Node.js " + process.versions.node + " is too old. Install Node.js 22 or newer"); problems++; }
  if (existsSync(join(project, "dist", "index.js"))) ok("Built (dist/index.js)");
  else { fail("Not built. Run npm ci"); return process.exitCode = 1; }

  const { loadConfig } = await import(new URL("../dist/config.js", import.meta.url).href);
  const { serverToken } = await import(new URL("../dist/runtime.js", import.meta.url).href);
  let loaded;
  try { loaded = await loadConfig(); }
  catch (error) {
    fail(String(error.message ?? error).replaceAll("\n", "\n    "));
    return process.exitCode = 1;
  }
  if (!existsSync(configFile)) { warn("No config.json yet: only the documentation tools work. Run npm run setup"); return; }
  ok("config.json is valid (" + loaded.servers.length + " server" + (loaded.servers.length === 1 ? "" : "s") + ")");

  for (const server of loaded.servers) {
    console.log("\nServer " + color(36, server.id) + " (" + server.cwd + ")");
    const installed = await findBridge(server.resources);
    const bundled = versionOf(await readFile(join(bundledBridge, "fxmanifest.lua"), "utf8"));
    if (!installed) { fail("bakery_ai_bridge is not in " + server.resources + ". Run npm run setup"); problems++; }
    else {
      const version = versionOf(await readFile(join(installed, "fxmanifest.lua"), "utf8"));
      if (version === bundled) ok("Bridge " + version + " installed");
      else { warn(`Bridge ${version ?? "?"} installed, ${bundled} bundled. Run npm run setup to update, then restart FXServer`); }
    }
    const token = serverToken(server);
    if (!token) { fail("No bridge token. Run npm run setup"); problems++; continue; }
    ok("Token found (" + (server.tokenConfig ? server.tokenConfig : "environment variable " + server.tokenEnv) + ")");
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${server.bridgePort}/v1`, {
        method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ op: "status", args: {} }), signal: AbortSignal.timeout(2000),
      });
    } catch {
      fail(`Nothing answers on port ${server.bridgePort}. Is FXServer running, and did you restart it after setup? `
        + "Check the server console for bakery_ai_bridge errors");
      problems++; continue;
    }
    if (response.status === 401) {
      fail("The bridge rejected the token. The token in server.cfg changed since FXServer started: restart FXServer");
      problems++; continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!body.ok) { fail("Bridge error: " + (body.error ?? response.status)); problems++; continue; }
    const status = body.result;
    ok(`Bridge connected: ${status.playerCount} player(s), ${status.resourceCount} resources`);
    const features = Object.entries(status.features ?? {}).filter(([, on]) => on).map(([key]) => key);
    if (features.length) ok("Developer extras on: " + features.join(", "));
    if (status.testClients?.length) ok("Test clients: " + status.testClients.map(c => `${c.name} (id ${c.id})`).join(", "));
    else warn("No in-game test client yet. Join the server and run bakery_ai_test on in F8 (needs the license from setup)");
  }
  console.log(problems ? color(31, `\n${problems} problem(s) found.\n`) : color(32, "\nEverything needed is working. Restart your MCP client if you changed anything.\n"));
  if (problems) process.exitCode = 1;
}

try {
  if (args.check) await check();
  else await setup();
} catch (error) {
  fail(String(error?.message ?? error));
  process.exitCode = 1;
}
