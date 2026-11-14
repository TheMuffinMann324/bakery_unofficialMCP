# FiveM Unofficial MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io/) server for FiveM resource development. Use it with Codex, Claude Code, or Claude Desktop to search framework docs, manage development resources, inspect logs, test NUI, and profile FXServer. This community project is unaffiliated with Cfx.re, Rockstar Games, Anthropic, and OpenAI.

## Quick start

### 1. Download and build

Download and extract the GitHub ZIP. Install [Node.js 22 or newer](https://nodejs.org/), then open PowerShell in the extracted folder that contains `package.json`.

```powershell
npm ci
npm run build
```

To download the offline knowledge base, also run `npm run knowledge:sync`. If you only want the documentation tools, skip to step 3.

### 2. Connect your FiveM development server

1. Drag the bundled [`bakery_ai_bridge`](resources/bakery_ai_bridge) folder into your server's `resources` folder. The result should be `resources/bakery_ai_bridge/fxmanifest.lua`. You can also use an existing category such as `[custom]`.
2. Generate a token in PowerShell or your terminal.

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Paste this block at the **top** of your development server's `server.cfg`. Replace the token placeholder and keep the quotation marks. Keep the CFG private and use plain `set` for the token.

   ```cfg
   set bakery_ai_enabled 1
   set bakery_ai_port 32124
   set bakery_ai_token "PASTE_YOUR_GENERATED_TOKEN_HERE"

   add_ace resource.bakery_ai_bridge command.status allow
   add_ace resource.bakery_ai_bridge command.refresh allow
   add_ace resource.bakery_ai_bridge command.profiler allow
   add_ace resource.bakery_ai_bridge command.record allow
   add_ace resource.bakery_ai_bridge command.saveJSON allow

   ensure bakery_ai_bridge
   ```

   If an existing `ensure` already starts the bridge, keep that line and omit the duplicate from the block.

4. Copy [`config.example.json`](config.example.json) to **`config.json`** in the downloaded MCP folder. Change `cwd` to the folder containing your `server.cfg` and `workspace` to that server's `resources` folder. Use forward slashes in Windows paths. The example reads the token from `server.cfg`.
5. Restart FXServer using txAdmin or your usual launcher.

### 3. Connect a client and check it works

Pick **one** client below. In its example, replace `C:/Projects/fivem-unofficialMCP/dist/index.js` with the full path to your downloaded folder's `dist/index.js`. The client launches the MCP automatically. For a manual startup check, run `npm start` in the project folder. It waits quietly for MCP messages. Press **Ctrl+C** when finished.

Once connected, ask the client to call `server_get_status`. When one server is configured, you can omit the server ID. **`state: "ready"`** means the MCP authenticated to the bridge. For documentation only, call `knowledge_sources` after syncing.

### Codex

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

### Claude Code

```powershell
claude mcp add --transport stdio --scope user fivem-unofficial -- node "C:/Projects/fivem-unofficialMCP/dist/index.js"
claude mcp list
```

Run `/mcp` in Claude Code to check the connection. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

### Claude Desktop

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

## Optional configuration

If you prefer to keep the bridge settings in a separate file, the [private CFG template](examples/fivem-mcp.local.cfg.example) still works. Point `tokenConfig` to that file and put its `exec` above the bridge's `ensure` in `server.cfg`.

For player tools, add `add_ace identifier.license:YOUR_TEST_ACCOUNT_LICENSE bakery_ai.test allow` above the bridge's `ensure`, replacing the placeholder with your test account's license identifier. Restart FXServer, join the server, and run `bakery_ai_test on` in F8. Check `testClients` in `server_get_status`. Run `bakery_ai_test off` to end the test session.

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
| `servers[].tokenConfig`, `tokenEnv` | Private CFG relative to `cwd`. Omit `tokenConfig` to use the named environment variable instead. |
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

| Symptom | What to check |
| --- | --- |
| Client cannot launch the MCP | Run `npm ci` and `npm run build`. Check the absolute entry path and Node executable. |
| Knowledge sources show as missing | Run `npm run knowledge:sync` and confirm that the client uses the same state directory. |
| Bridge authentication fails | Check that the private CFG loads before the bridge, and verify the port and token match. Restart FXServer and the MCP client. |
| `server_get_status` shows an empty server list | Create `config.json` beside `package.json` and restart the MCP client. |
| Bridge unreachable | Confirm FXServer started `bakery_ai_bridge`, the bridge port matches, and both processes run on the same machine. |
| No opted-in test client | Check the license ACE, join your dev server, and run `bakery_ai_test on` in F8. |
| NUI tools show no pages | Open the local FiveM client, join a server, and check the DevTools port. |

## Tests

```sh
npm test
```

Tests cover the MCP connection, source editing, scenario execution, local log parsing, Lua syntax, and knowledge searches. To include the optional live test, set `BAKERY_SMOKE_FXSERVER` to your FXServer executable and `BAKERY_SMOKE_LICENSE_CFG` to a local cfg containing a valid server license. It creates an isolated temporary instance on loopback ports 33124 and 33125.








