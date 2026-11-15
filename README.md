# FiveM Unofficial MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io/) server for FiveM resource development. Use it with Codex, Claude Code, or Claude Desktop to search framework docs, manage development resources, inspect logs, test NUI, and profile FXServer. This community project is unaffiliated with Cfx.re, Rockstar Games, Anthropic, and OpenAI.

## Quick start

Use a **development** server, not your live one.

### 1. Install

Install [Node.js 22 or newer](https://nodejs.org/). Download and extract the GitHub ZIP (or `git clone` it), open PowerShell in the folder that contains `package.json`, and run:

```powershell
npm ci
```

This installs and builds everything.

### 2. Run the setup

```powershell
npm run setup
```

It asks for the folder that contains your `server.cfg`, then:

- copies the `bakery_ai_bridge` resource into your server's `resources` folder (or updates it in place),
- adds a marked block to the top of `server.cfg` with a freshly generated token (the original is saved as `server.cfg.before-fivem-mcp`),
- writes `config.json`,
- prints the exact command to connect Claude Code, Codex or Claude Desktop, and offers to register it with Claude Code for you.

Optional answers: your FiveM `license:` identifier (enables the in-game test tools; find it in txAdmin's player info) and developer extras (auto opt-in, `lua_eval`, read-only `db_query`). Running setup again is safe: it keeps your token and replaces only its own block.

### 3. Restart and check

Restart FXServer, then restart your MCP client, and run:

```powershell
npm run check
```

It explains in plain words what works and what to fix. When it says **Everything needed is working**, ask your client to call `server_get_status`.

For the in-game tools, join the server and run `bakery_ai_test on` in F8 (automatic if you enabled developer extras).

To also download the offline documentation, run `npm run knowledge:sync`.

### Connecting a client by hand

`npm run setup` prints these commands with your real path filled in. Replace `C:/Projects/fivem-unofficialMCP/dist/index.js` with the full path to your folder's `dist/index.js` if you set it up yourself.

#### Codex

```powershell
codex mcp add fivem-unofficial -- node "C:/Projects/fivem-unofficialMCP/dist/index.js"
codex mcp list
```

Or add this entry to `~/.codex/config.toml`. The longer timeout accommodates scenario runs.

```toml
[mcp_servers.fivem-unofficial]
command = "node"
args = ["C:/Projects/fivem-unofficialMCP/dist/index.js"]
tool_timeout_sec = 180
```

Reload Codex and check `/mcp` in the CLI. [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

#### Claude Code

```powershell
claude mcp add --transport stdio --scope user fivem-unofficial -- node "C:/Projects/fivem-unofficialMCP/dist/index.js"
claude mcp list
```

Run `/mcp` in Claude Code to check the connection. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

#### Claude Desktop

Open **Settings → Developer → Edit Config**. Merge this entry into the existing `mcpServers` object, then quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "fivem-unofficial": {
      "command": "node",
      "args": ["C:/Projects/fivem-unofficialMCP/dist/index.js"]
    }
  }
}
```

On Windows the configuration file is normally `%APPDATA%\Claude\claude_desktop_config.json`. [Local MCP server setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

## FiveM on a VPS

The MCP and FXServer run on the same machine because the bridge listens on `127.0.0.1`. For a VPS, build and run the MCP on the VPS alongside FXServer. A Codex or Claude client on your PC can use it if the client launches that remote process over SSH stdio. The local client examples above assume a same-machine install. Your FiveM game can join the server from your PC. Local client logs, NUI DevTools, and Windows window capture require the game client on the MCP host.

## Manual setup

`npm run setup` does all of this for you. To do it by hand instead:

1. Copy [`resources/bakery_ai_bridge`](resources/bakery_ai_bridge) into your server's `resources` folder, so `resources/bakery_ai_bridge/fxmanifest.lua` exists. A category such as `[custom]` also works.
2. Generate a token: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
3. Add this at the **top** of `server.cfg`. Use plain `set` (not `setr`/`sets`) so the token stays on the server.

   ```cfg
   set bakery_ai_enabled 1
   set bakery_ai_port 32124
   set bakery_ai_token "PASTE_YOUR_GENERATED_TOKEN_HERE"

   add_ace resource.bakery_ai_bridge command.status allow
   add_ace resource.bakery_ai_bridge command.refresh allow
   add_ace resource.bakery_ai_bridge command.profiler allow
   add_ace resource.bakery_ai_bridge command.record allow
   add_ace resource.bakery_ai_bridge command.saveJSON allow
   # For in-game test tools:
   # add_ace identifier.license:YOUR_LICENSE bakery_ai.test allow

   ensure bakery_ai_bridge
   ```

   Leave out `ensure bakery_ai_bridge` if something else (such as `ensure [custom]`) already starts it.
4. Copy [`config.example.json`](config.example.json) to `config.json` and change `cwd` to the folder containing `server.cfg` and `workspace` to its `resources` folder (forward slashes on Windows). `"tokenConfig": "server.cfg"` reads the token from that file, so you do not need an environment variable.
5. Restart FXServer and your MCP client, then run `npm run check`.

To keep the bridge settings out of `server.cfg`, use the [private CFG template](examples/fivem-mcp.local.cfg.example), point `tokenConfig` at it, and `exec` it above the bridge's `ensure`.

## Optional configuration

For the in-game tools, the test account needs `add_ace identifier.license:YOUR_LICENSE bakery_ai.test allow` (setup adds it when you give your license). Join the server and run `bakery_ai_test on` in F8, then check `testClients` in `server_get_status`. Run `bakery_ai_test off` to end the test session.

Developer extras, all off by default: `set bakery_ai_auto_optin 1` opts the test account in automatically after joins and bridge restarts, `set bakery_ai_eval 1` enables `lua_eval`, and `set bakery_ai_sql 1` enables read-only `db_query` through oxmysql. List the F8 commands the MCP may run in `allowClientCommands`, for example `["racing"]`, or `["*"]` for any.

If the resources you want to manage live in a category like `[custom]`, point `workspace` and `servers[].resources` to the folder that directly contains them.

### Configuration reference

| Field | Meaning |
| --- | --- |
| `workspace` | Source resource directory, relative to `config.json`. Defaults to the package's empty `workspace/` folder. |
| `servers[].id`, `environment` | Unique target ID and the value `development`. Pass the ID as `server` when choosing among targets. |
| `servers[].cwd` | FXServer working directory, relative to `config.json`. |
| `servers[].resources` | Installed resource directory, relative to `cwd`. This can point to the same directory as `workspace`. |
| `servers[].executable`, `args` | Optional local executable relative to `cwd`, plus its launch arguments. |
| `servers[].bridgePort` | Loopback port matching `bakery_ai_port`. Use a unique port and token for each target. |
| `servers[].tokenConfig` | The cfg file (relative to `cwd`) containing `set bakery_ai_token "..."`, usually `server.cfg`. Recommended. |
| `servers[].tokenEnv` | Alternative to `tokenConfig`: the **name** of an environment variable that holds the token, such as `BAKERY_FIVEM_TOKEN`. Never the token itself. |
| `servers[].allowCommands` | Server allowlist, selected from `status`, `refresh`, and `say`. The bridge also checks its convar and ACE allowlists. |
| `servers[].allowClientCommands` | Allowlisted F8 commands for testing. Empty by default. |
| `nuiDevtoolsPort`, `clientLogDir` | Local FiveM client settings. Defaults to port `13172` and `%LOCALAPPDATA%/FiveM/FiveM.app/logs` on Windows. |

Set `BAKERY_FIVEM_CONFIG` to use an alternate config file. Set `BAKERY_FIVEM_STATE_DIR` to relocate audits, scenarios, screenshots, and the knowledge cache. Use the same state directory for the MCP host and knowledge sync. Normal MCP shutdown stops FXServer processes it owns. Start FXServer independently if it needs to outlive the MCP client.

## Knowledge base

| Source | Content |
| --- | --- |
| `fivem` | Cfx.re guides and the client, server, and shared native reference |
| `qbx` | Qbox guides and API reference |
| `qbcore` | QBCore framework and resource docs |
| `esx` | English ESX Legacy core and add-on docs |
| `ox_lib` | Overextended library docs |
| `oxmysql` | Overextended database API docs |
| `kq_link` | Public KuzQuality KQ Link docs and optional local indexing of an installed `kq_link` resource in `workspace` |

Use `knowledge_sources` for counts and sync dates, `knowledge_search` to find an API, and `knowledge_read` for a line range and the original source reference. Search can filter by `source`, `kind`, and native `apiSet`.

```sh
npm run knowledge:sync
npm run knowledge:sync -- fivem ox_lib
```

Git ignores the generated cache in `.bakery-data/knowledge/`. Sync preserves the previous snapshot when a download fails. Documentation and installed resource code retain their original ownership and terms. [Source catalog](src/knowledge-sources.ts)


## Tool catalog

| Area | Tools |
| --- | --- |
| Docs | `knowledge_sources`, `knowledge_search`, `knowledge_read` |
| Server | `server_get_status`, `server_lifecycle`, `server_execute_command`, `server_get_logs`, `server_get_diagnostics` |
| Resources | `resource_list`, `resource_read`, `resource_create`, `resource_edit`, `resource_delete`, `resource_deploy`, `resource_control`, `resource_get_diagnostics`, `resource_test_adapter`, `dev_cycle` |
| Player and game | `game_get_state`, `game_spawn`, `game_get_entities`, `game_delete_entity`, `game_teleport`, `game_set_environment`, `game_execute_command`, `game_input`, `game_screenshot` |
| Client and NUI | `client_get_logs`, `nui_list`, `nui_snapshot`, `nui_act`, `nui_eval`, `wait_for` |
| Lua and database | `lua_eval`, `db_query` |
| Scenario tests | `test_create_scenario`, `test_execute_scenario`, `test_run_regression`, `test_get_results`, `test_cleanup` |
| Profiling | `performance_get`, `performance_profile`, `performance_get_resource` |

- Read a source file before editing it. Pass the returned `sha256` as `expectedSha256`, or `null` for a new file. `dev_cycle` can build and restart the resource and gather fresh errors.
- Deletion requires one-time local approval. Call `resource_delete` to get a request ID, run `node dist/index.js approve-delete REQUEST_ID "ABSOLUTE_RESOURCE_PATH"`, then call `resource_delete` with the approval ID. The resource moves to recoverable storage under `.bakery-data/trash/`.
- For NUI, use `nui_snapshot` to find a control, `nui_act` to interact, and `wait_for` to wait on UI state or a log condition. `game_screenshot` supports local Windows window capture with NUI and game-only capture with `screencapture` or `screenshot-basic`.
- To run a scenario, pass [the vehicle smoke example](examples/vehicle-smoke.json) to `test_create_scenario`. Call `test_execute_scenario` with `{"scenario":"vehicle_smoke","participants":{"default":1}}`, using your opted-in player ID in place of `1`.
- Resources can expose a development-only `bakeryAiTest(action, data, scope)` client export or `bakeryAiTest(action, data, scope, playerId)` server export. Validate the caller and make scenario cleanup idempotent.

## Troubleshooting

Start with `npm run check`. It tests the config, the installed bridge, the token and the connection, and says what to fix.

| Symptom | What to check |
| --- | --- |
| Tools reply `config.json is invalid` | The message names the field and the fix. Running `npm run setup` again rewrites `config.json` correctly. |
| `tokenEnv` "must match pattern" (older versions) | The token was pasted into `tokenEnv`. Delete `tokenEnv` and use `"tokenConfig": "server.cfg"`, or update and run `npm run setup`. |
| Client cannot launch the MCP | Run `npm ci`. Check the absolute entry path and Node executable. |
| Knowledge sources show as missing | Run `npm run knowledge:sync` and confirm that the client uses the same state directory. |
| Bridge authentication fails | The token changed after FXServer started. Restart FXServer, then the MCP client. |
| `server_get_status` shows an empty server list | No `config.json` yet. Run `npm run setup` and restart the MCP client. |
| Bridge unreachable | Confirm FXServer started `bakery_ai_bridge`, the bridge port matches, and both processes run on the same machine. |
| No opted-in test client | Check the license ACE, join your dev server, and run `bakery_ai_test on` in F8. |
| NUI tools show no pages | Open the local FiveM client, join a server, and check the DevTools port. |

## Tests

```sh
npm test
```

Tests cover the MCP connection, source editing, scenario execution, local log parsing, Lua syntax, knowledge searches, config error messages, and the setup and check scripts (against temporary folders). To include the optional live test, set `BAKERY_SMOKE_FXSERVER` to your FXServer executable and `BAKERY_SMOKE_LICENSE_CFG` to a local cfg containing a valid server license. It creates an isolated temporary instance on loopback ports 33124 and 33125.
