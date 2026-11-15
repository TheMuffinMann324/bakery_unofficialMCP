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
  // Where the bridge token comes from: a cfg file containing `set bakery_ai_token "..."` (usually server.cfg),
  // or the NAME of an environment variable holding it. At least one is required.
  tokenConfig: z.string().min(1).optional(),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  allowCommands: z.array(z.enum(["status", "refresh", "say"])).default(["status", "refresh"]),
  allowClientCommands: z.array(z.union([z.literal("*"), clientCommand])).max(64).default([]),
}).refine(server => server.tokenConfig || server.tokenEnv, {
  message: "Set tokenConfig to the cfg file holding set bakery_ai_token (usually \"server.cfg\")", path: ["tokenConfig"],
});
const configSchema = z.strictObject({
  workspace: z.string().min(1).default("workspace"),
  servers: z.array(serverConfig).max(16).default([]),
  // Local FiveM client: NUI DevTools port and the folder holding CitizenFX_log_*.log.
  nuiDevtoolsPort: z.number().int().min(1024).max(65535).default(13172),
  clientLogDir: z.string().min(1).optional(),
});
export type ServerConfig = z.infer<typeof serverConfig> & { setupToken?: string };

export const configPath = () => resolve(process.env.BAKERY_FIVEM_CONFIG ?? resolve(project, "config.json"));

// Plain-language hints for the config mistakes people actually make.
const hints: Record<string, string> = {
  tokenEnv: "tokenEnv is the NAME of an environment variable (for example BAKERY_FIVEM_TOKEN), not the token itself. "
    + "Simplest fix: delete tokenEnv and set \"tokenConfig\": \"server.cfg\" so the token is read from server.cfg.",
  bridgePort: "bridgePort must be the same number as set bakery_ai_port in server.cfg (default 32124).",
  environment: "environment must be \"development\". This MCP only targets development servers.",
  cwd: "cwd is the folder that contains server.cfg.",
  resources: "resources is the folder (relative to cwd) where the server's resources live, usually \"resources\".",
};

/** Turns schema errors into one readable message per problem. */
function describe(error: z.ZodError, file: string) {
  const lines = error.issues.map(issue => {
    const where = issue.path.map(part => typeof part === "number" ? "[" + part + "]" : "." + String(part)).join("").replace(/^\./, "") || "(top level)";
    const field = String(issue.path.at(-1) ?? "");
    return "- " + where + ": " + (hints[field] ?? issue.message);
  });
  return "config.json is invalid (" + file + "):\n" + lines.join("\n") + "\nRun npm run setup to regenerate it, or npm run check for details.";
}

/** Reads `set bakery_ai_token "..."` (quotes optional) from a cfg file. */
export function tokenFromCfg(text: string) {
  return /^[ \t]*set[ \t]+bakery_ai_token[ \t]+"?([A-Za-z0-9_-]{32,128})"?[ \t]*(?:#.*)?$/m.exec(text)?.[1];
}

export async function loadConfig() {
  const path = configPath();
  let input: unknown = {};
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("config.json is not valid JSON (" + path + "): " + error.message);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.BAKERY_FIVEM_CONFIG) throw error;
  }
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new Error(describe(parsed.error, path));
  const config = parsed.data;
  if (new Set(config.servers.map(s => s.id)).size !== config.servers.length) throw new Error("config.json: two servers share the same id");
  if (new Set(config.servers.map(s => s.bridgePort)).size !== config.servers.length) throw new Error("config.json: two servers share the same bridgePort");
  const workspace = await realpath(resolve(dirname(path), config.workspace)).catch(() => {
    throw new Error("config.json: workspace folder not found: " + resolve(dirname(path), config.workspace));
  });
  const servers = await Promise.all(config.servers.map(async server => {
    const cwd = resolve(dirname(path), server.cwd);
    let setupToken: string | undefined;
    if (server.tokenConfig) {
      const cfg = resolve(cwd, server.tokenConfig);
      const text = await readFile(cfg, "utf8").catch(() => {
        throw new Error("config.json: server " + server.id + " tokenConfig file not found: " + cfg);
      });
      setupToken = tokenFromCfg(text);
      if (!setupToken) throw new Error("config.json: no bakery_ai_token line in " + cfg
        + ". Add: set bakery_ai_token \"<32-128 letters, digits, _ or ->\" (or run npm run setup)");
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

