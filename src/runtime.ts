import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import type { ServerConfig } from "./config.js";

export type Fields = Record<string, unknown>;
export type Log = { seq: number; at: number; channel: string; message: string; resource?: string; file?: string; line?: number };
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function logLevel(log: Log) {
  if (/\berror\b|unhandled|uncaught|exception|failed to (?:start|load)|fatal/i.test(log.channel + " " + log.message)) return "error";
  if (/\bwarn(?:ing)?\b|hitch/i.test(log.channel + " " + log.message)) return "warning";
  return "info";
}

export function enrichLog(log: Log) {
  const location = /@([\w-]+)\/([^:\r\n]+):(\d+)/.exec(log.message);
  if (location) return { ...log, resource: location[1], file: location[2], line: Number(location[3]) };
  const resource = /^script:\s*([\w-]+)$/.exec(log.channel)?.[1] ?? /\[\s*script:([\w-]+)\s*\]/.exec(log.message)?.[1];
  return resource ? { ...log, resource } : log;
}

type Managed = {
  child: ChildProcess;
  exit: Promise<void>;
  lastExit?: { code: number | null; signal: string | null; at: number; error?: string };
};

export class Runtime {
  readonly consoleEpoch = randomUUID();
  private managed = new Map<string, Managed>();
  private locks = new Set<string>();
  private stopping = false;

  constructor(readonly servers: ServerConfig[]) {}

  /** Resolves a server by ID, or the only configured server when the ID is omitted. */
  get(id?: string) {
    if (id === undefined) {
      if (this.servers.length === 1) return this.servers[0];
      throw new Error(this.servers.length ? "Pass server: one of " + this.servers.map(s => s.id).join(", ") : "No servers in config.json");
    }
    const server = this.servers.find(item => item.id === id);
    if (!server) throw new Error("Unknown server " + id + ". Configured: " + this.servers.map(s => s.id).join(", "));
    return server;
  }

  private active(id: string) {
    const record = this.managed.get(id);
    return record && !record.lastExit ? record : undefined;
  }

  async bridge(server: ServerConfig, op: string, args: Fields = {}, timeout = 6500, signal?: AbortSignal): Promise<Fields> {
    const token = server.setupToken ?? process.env[server.tokenEnv];
    if (!token || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error("Configure " + server.tokenEnv + " with a random token");
    let response: Response;
    try {
      response = await fetch("http://127.0.0.1:" + server.bridgePort + "/v1", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ op, args }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as Error).name === "TimeoutError") throw new Error("Bridge request timed out. Inspect state before retrying");
      throw new Error("Bridge unreachable on loopback port " + server.bridgePort);
    }
    if (response.status === 401) throw new Error("Bridge authentication failed");
    const result = await response.json() as { ok: boolean; result: Fields; error: string };
    if (!result.ok) throw new Error(result.error ?? "Bridge rejected the request");
    return result.result;
  }

  async status(server: ServerConfig) {
    const process = this.active(server.id);
    const previous = this.managed.get(server.id)?.lastExit;
    try {
      return { server: server.id, managed: Boolean(process), pid: process?.child.pid, state: "ready",
        ...(await this.bridge(server, "status", {}, 900)), lastExit: previous };
    } catch (error) {
      return { server: server.id, managed: Boolean(process), pid: process?.child.pid,
        state: process ? "process_running" : "unverified", bridgeError: errorText(error), lastExit: previous };
    }
  }

  async lifecycle(server: ServerConfig, action: "start" | "stop" | "restart") {
    if (this.stopping || this.locks.has(server.id)) throw new Error("Server lifecycle operation already in progress");
    this.locks.add(server.id);
    try {
      if (action !== "start") await this.stop(server);
      if (action === "stop") return { server: server.id, state: "stopped", lastExit: this.managed.get(server.id)?.lastExit };
      await this.start(server);
      return await this.status(server);
    } finally { this.locks.delete(server.id); }
  }

  private logs = new Map<string, { seq: number; entries: Log[] }>();
  consoleLogs(id: string) { return this.logs.get(id) ?? { seq: 0, entries: [] }; }

  private capture(server: ServerConfig, channel: string, stream: NodeJS.ReadableStream) {
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let overflow = false;
    const record = this.logs.get(server.id) ?? { seq: 0, entries: [] };
    this.logs.set(server.id, record);
    const line = (text: string) => {
      const token = server.setupToken ?? process.env[server.tokenEnv];
      const sanitized = token ? text.replaceAll(token, "[redacted]") : text;
      const message = sanitized.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
      if (!message) return;
      record.entries.push(enrichLog({ seq: ++record.seq, at: Date.now(), channel, message }));
      if (record.entries.length > 1200) record.entries.shift();
    };
    stream.on("data", (chunk: Buffer) => {
      const parts = decoder.write(chunk).split("\n");
      for (const part of parts.slice(0, -1)) {
        line((carry + part).slice(0, 1200));
        carry = "";
        overflow = false;
      }
      if (!overflow) {
        carry = (carry + parts.at(-1)).slice(0, 1200);
        overflow = carry.length === 1200;
      }
    });
    stream.on("end", () => line((carry + decoder.end()).slice(0, 1200)));
  }

  private async start(server: ServerConfig) {
    if (this.active(server.id)) throw new Error("This server process is already managed");
    if (!server.executable || !existsSync(server.executable)) throw new Error("Configure an existing FXServer executable");
    try {
      const response = await fetch("http://127.0.0.1:" + server.bridgePort + "/v1", { signal: AbortSignal.timeout(650), redirect: "manual" });
      await response.body?.cancel();
      throw new Error("Configured bridge port is already occupied");
    } catch (error) {
      if (!(error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED")) throw error;
    }
    if (this.stopping) throw new Error("MCP server is shutting down");
    const child = spawn(server.executable, server.args, { cwd: server.cwd, shell: false, windowsHide: true, stdio: "pipe" });
    const record: Managed = { child, exit: Promise.resolve() };
    this.managed.set(server.id, record);
    this.capture(server, "stdout", child.stdout);
    this.capture(server, "stderr", child.stderr);
    child.stdin.on("error", () => {});
    let spawnError: string | undefined;
    record.exit = new Promise(resolve => {
      child.on("error", error => { spawnError = error.message; });
      child.once("close", (code, signal) => {
        record.lastExit = { code, signal, at: Date.now(), error: spawnError };
        resolve();
      });
    });
    for (let attempt = 0; attempt < 25; attempt++) {
      if (record.lastExit) throw new Error(record.lastExit.error ?? "FXServer exited during startup");
      try { await this.bridge(server, "status", {}, 300); return; } catch { await sleep(400); }
    }
    if (record.lastExit) throw new Error(record.lastExit.error ?? "FXServer exited during startup");
  }

  private async stop(server: ServerConfig) {
    const record = this.active(server.id);
    if (!record) throw new Error("Only processes launched by this MCP session can be stopped");
    record.child.stdin?.write("quit\n");
    const exited = (ms: number) => {
      const timer = new AbortController();
      return Promise.race([record.exit.then(() => true), sleep(ms, false, { signal: timer.signal })])
        .finally(() => timer.abort());
    };
    if (!await exited(4000)) {
      record.child.kill();
      if (!await exited(2500)) throw new Error("FXServer did not exit");
    }
  }

  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(this.servers.filter(s => this.active(s.id)).map(s => this.stop(s)));
  }
}
