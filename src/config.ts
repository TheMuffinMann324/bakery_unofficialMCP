import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const project = fileURLToPath(new URL("../", import.meta.url));
export const stateDir = resolve(process.env.BAKERY_FIVEM_STATE_DIR ?? resolve(project, ".bakery-data"));
export const name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);
export const clientCommand = z.string().regex(/^[+-]?[A-Za-z0-9_.:]{1,63}$/);
const serverConfig = z.strictObject({
  id: name,
  environment: z.literal("development"),
  cwd: z.string().min(1),
  executable: z.string().min(1).optional(),
  args: z.array(z.string()).max(64).default(["+exec", "server.cfg"]),
  resources: z.string().min(1),
  bridgePort: z.number().int().min(1024).max(65535),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  tokenConfig: z.string().min(1).optional(),
  allowCommands: z.array(z.enum(["status", "refresh", "say"])).default(["status", "refresh"]),
  allowClientCommands: z.array(z.union([z.literal("*"), clientCommand])).max(64).default([]),
});
const configSchema = z.strictObject({
  workspace: z.string().min(1).default("workspace"),
  servers: z.array(serverConfig).max(16).default([]),
  // Local FiveM client: NUI DevTools port and the folder holding CitizenFX_log_*.log.
  nuiDevtoolsPort: z.number().int().min(1024).max(65535).default(13172),
  clientLogDir: z.string().min(1).optional(),
});
export type ServerConfig = z.infer<typeof serverConfig> & { setupToken?: string };

export async function loadConfig() {
  const path = resolve(process.env.BAKERY_FIVEM_CONFIG ?? resolve(project, "config.json"));
  let input: unknown = {};
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.BAKERY_FIVEM_CONFIG) throw error;
  }
  const config = configSchema.parse(input);
  if (new Set(config.servers.map(s => s.id)).size !== config.servers.length) throw new Error("Duplicate server IDs");
  if (new Set(config.servers.map(s => s.bridgePort)).size !== config.servers.length) throw new Error("Duplicate bridge ports");
  const workspace = await realpath(resolve(dirname(path), config.workspace));
  const servers = await Promise.all(config.servers.map(async server => {
    const cwd = resolve(dirname(path), server.cwd);
    let setupToken: string | undefined;
    if (server.tokenConfig) {
      const configPath = resolve(cwd, server.tokenConfig);
      const text = await readFile(configPath, "utf8");
      setupToken = /^set bakery_ai_token "([A-Za-z0-9_-]{32,128})"\s*$/m.exec(text)?.[1];
      if (!setupToken) throw new Error("Invalid Bakery token configuration for server " + server.id);
    }
    return {
      ...server,
      cwd,
      setupToken,
      resources: resolve(cwd, server.resources),
      executable: server.executable ? resolve(cwd, server.executable) : undefined,
    };
  }));
  const clientLogDir = config.clientLogDir ? resolve(dirname(path), config.clientLogDir)
    : resolve(process.env.LOCALAPPDATA ?? "", "FiveM", "FiveM.app", "logs");
  return { workspace, servers, nuiDevtoolsPort: config.nuiDevtoolsPort, clientLogDir };
}

