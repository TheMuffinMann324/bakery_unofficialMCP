import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { name, stateDir, type ServerConfig } from "./config.js";
import { errorText, logLevel, Runtime, type Fields, type Log } from "./runtime.js";
import { bridgeArgs, operations, scenario, type Comparison, type Scenario } from "./schema.js";

const folder = resolve(stateDir, "scenarios");
const history = resolve(stateDir, "runs");
type Participant = { id: number; session: string };
type Failure = { step: number; error: string };
type Run = {
  id: string; name: string; server: string; state: "running" | "passed" | "failed"; started: number;
  passed: number; skipped: number; failed: Failure[]; durationMs?: number; cleanupErrors: string[];
  errorRefs: { epoch: string; seq: number }[]; targets: Participant[];
};

function savedValue(reference: { from: string; path: string }, values: Map<string, unknown>) {
  let value = values.get(reference.from);
  for (const part of reference.path.split(".")) {
    value = value && typeof value === "object" && Object.hasOwn(value, part) ? (value as Fields)[part] : undefined;
  }
  return value;
}

function check(comparison: Comparison, values: Map<string, unknown>) {
  const actual = savedValue(comparison, values);
  const expected = comparison.value;
  const pass = comparison.op === "exists" ? actual !== undefined :
    comparison.op === "eq" ? actual === expected :
    comparison.op === "ne" ? actual !== undefined && actual !== expected :
    typeof actual === "number" && typeof expected === "number" && (
      comparison.op === "gt" ? actual > expected :
      comparison.op === "gte" ? actual >= expected :
      comparison.op === "lt" ? actual < expected : actual <= expected);
  return { pass, actual };
}

function validate(value: Scenario) {
  const keys = new Set<string>();
  const validateCheck = (comparison: Comparison) => {
    if (!keys.has(comparison.from)) throw new Error("Unknown saved step " + comparison.from);
    if (comparison.op !== "exists" && comparison.value === undefined) throw new Error("Comparison needs a value");
  };
  for (const step of [...value.steps, ...value.cleanup]) {
    if (step.when) validateCheck(step.when);
    if (step.type === "assert") validateCheck(step.check);
    if (step.type !== "action") continue;
    const fields = operations[step.action].shape as Record<string, { parse(value: unknown): unknown }>;
    const bindings = Object.entries(step.bind);
    if (bindings.length > 8) throw new Error("An action can bind up to eight values");
    for (const [path, reference] of bindings) {
      if (!keys.has(reference.from)) throw new Error("Unknown saved step " + reference.from);
      const parts = path.split(".");
      if (!Object.hasOwn(fields, parts[0]) || parts.some(part => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("Invalid binding target " + path);
      if (parts.length > 1 && !(parts.length === 2 && step.action === "adapter" && parts[0] === "data")) {
        throw new Error("Nested bindings must target an adapter data field");
      }
    }
    if (!bindings.length) operations[step.action].parse(step.args);
    else {
      for (const field of Object.keys(step.args)) {
        if (!Object.hasOwn(fields, field)) throw new Error("Unknown action argument " + field);
      }
      for (const [key, field] of Object.entries(fields)) {
        if (!Object.hasOwn(step.bind, key)) field.parse(step.args[key]);
      }
    }
    if (step.saveAs) {
      if (keys.has(step.saveAs)) throw new Error("Duplicate saved step " + step.saveAs);
      keys.add(step.saveAs);
    }
  }
}

/** Throws unless the server's allowClientCommands permits this client console command. */
export function allowCommand(server: ServerConfig, command: string) {
  if (!server.allowClientCommands.includes("*") && !server.allowClientCommands.includes(command)) {
    throw new Error("Client command " + command + " is not in allowClientCommands for server " + server.id);
  }
}

export async function createScenario(value: Scenario) {
  validate(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("Scenario exceeds 64 KiB");
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, value.name.toLowerCase() + ".json"), JSON.stringify(value, null, 2), { flag: "wx" });
  return { scenario: value.name, steps: value.steps.length };
}

export class Scenarios {
  private runs = new Map<string, Run>();
  private tasks = new Set<Promise<Run>>();
  private busy = new Set<string>();
  private shutdownSignal = new AbortController();

  constructor(private runtime: Runtime) {}

  locked(server: string, id: number) { return this.busy.has(server + ":" + id); }

  async get(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run ID");
    const run = this.runs.get(id);
    if (run) return run;
    return JSON.parse(await readFile(resolve(history, id + ".json"), "utf8")) as Run;
  }

  async start(server: ServerConfig, scenarioName: string, mapping: Record<string, number>, wait: boolean) {
    this.shutdownSignal.signal.throwIfAborted();
    const stored = scenario.parse(JSON.parse(await readFile(resolve(folder, name.parse(scenarioName).toLowerCase() + ".json"), "utf8")));
    validate(stored);
    const status = await this.runtime.bridge(server, "status");
    this.shutdownSignal.signal.throwIfAborted();
    const clients = status.testClients as Participant[];
    const needed = new Set([...stored.steps, ...stored.cleanup].flatMap(step => step.type === "action" ? [step.participant] : []));
    const targets = new Map<string, Participant>();
    for (const alias of needed) {
      const target = clients.find(item => item.id === mapping[alias]);
      if (!target) throw new Error("Missing or unavailable opted-in participant " + alias);
      if (this.locked(server.id, target.id)) throw new Error("Participant is reserved by another scenario");
      targets.set(alias, target);
    }
    if (this.tasks.size >= 8) throw new Error("Too many concurrent scenarios");
    const unique = [...new Map([...targets.values()].map(target => [target.id, target])).values()];
    const run: Run = { id: randomUUID(), name: stored.name, server: server.id, state: "running", started: Date.now(),
      passed: 0, skipped: 0, failed: [], cleanupErrors: [], errorRefs: [], targets: unique };
    for (const target of unique) this.busy.add(server.id + ":" + target.id);
    this.runs.set(run.id, run);
    const task = this.execute(server, stored, run, targets).finally(() => {
      for (const target of unique) this.busy.delete(server.id + ":" + target.id);
      this.tasks.delete(task);
      this.runs.delete(run.id);
    });
    this.tasks.add(task);
    if (wait) return task;
    void task.catch(error => console.error("Scenario history:", errorText(error)));
    return { id: run.id, name: run.name, state: "running" };
  }

  private async execute(server: ServerConfig, value: Scenario, run: Run, targets: Map<string, Participant>) {
    const values = new Map<string, unknown>();
    const signal = AbortSignal.any([AbortSignal.timeout(value.timeoutMs), this.shutdownSignal.signal]);
    const touched = new Set<number>();
    const originalPositions = new Map<number, unknown>();
    const adapterCalls = new Map<string, { target: Participant; resource: string; side: string }>();
    let initial: Fields | undefined;
    const perform = async (step: Scenario["steps"][number], deadline?: AbortSignal) => {
      deadline?.throwIfAborted();
      if (step.when && !check(step.when, values).pass) return false;
      if (step.type === "delay") await sleep(step.ms, undefined, { signal: deadline });
      if (step.type === "assert") {
        const result = check(step.check, values);
        if (!result.pass) throw new Error(`Assertion failed for ${step.check.from}.${step.check.path} (${step.check.op}). Actual ${String(result.actual).slice(0, 200)}`);
      }
      if (step.type === "action") {
        const target = targets.get(step.participant)!;
        const inputs: Fields = { ...step.args };
        for (const [path, reference] of Object.entries(step.bind)) {
          const value = savedValue(reference, values);
          if (value === undefined) throw new Error("Saved binding is unavailable " + reference.from + "." + reference.path);
          const [field, subfield] = path.split(".");
          if (subfield) inputs[field] = { ...(inputs[field] as Fields | undefined), [subfield]: value };
          else inputs[field] = value;
        }
        const args = operations[step.action].parse(inputs);
        if (step.action === "client_command" && "command" in args) allowCommand(server, args.command);
        const context = { player: target.id, session: target.session, scope: run.id };
        touched.add(target.id);
        if (step.action === "teleport" && !originalPositions.has(target.id)) {
          const before = await this.runtime.bridge(server, "state", context, 6500, deadline);
          originalPositions.set(target.id, before.position);
        }
        if (step.action === "adapter" && "resource" in args) {
          adapterCalls.set([target.id, args.resource, args.side].join(":"), { target, resource: args.resource, side: args.side });
        }
        // Let an in-flight native finish before cleanup, even when the scenario deadline expires.
        const result = await this.runtime.bridge(server, step.action, { ...bridgeArgs(step.action, args), ...context });
        deadline?.throwIfAborted();
        if (step.saveAs) values.set(step.saveAs, result);
      }
      return true;
    };
    let index = 0;
    try {
      initial = await this.runtime.bridge(server, "logs", { limit: 1 }, 1500, signal);
      for (const step of value.steps) {
        index++;
        if (await perform(step, signal)) run.passed++;
        else run.skipped++;
      }
    } catch (error) {
      run.failed.push({ step: index, error: errorText(error).slice(0, 400) });
    }
    const cleanupSignal = AbortSignal.timeout(20000);
    for (const step of value.cleanup) {
      try { await perform(step, cleanupSignal); } catch (error) { run.cleanupErrors.push(errorText(error).slice(0, 300)); }
    }
    const cleanupCall = async (target: Participant, op: string, args: Fields = {}) => {
      try {
        const result = await this.runtime.bridge(server, op, { ...args, player: target.id, session: target.session, scope: run.id });
        if (Array.isArray(result.failures)) run.cleanupErrors.push(...result.failures.map(failure => String(failure).slice(0, 200)));
      } catch (error) { run.cleanupErrors.push(errorText(error).slice(0, 300)); }
    };
    await Promise.all(run.targets.filter(target => touched.has(target.id)).map(async target => {
      for (const adapter of adapterCalls.values()) {
        if (adapter.target.id === target.id) await cleanupCall(target, "adapter", { resource: adapter.resource, action: "cleanup", side: adapter.side });
      }
      if (originalPositions.has(target.id)) await cleanupCall(target, "teleport", { position: originalPositions.get(target.id) });
      await cleanupCall(target, "cleanup");
    }));
    if (initial) {
      try {
        const logs = await this.runtime.bridge(server, "logs", { after: initial.latest, limit: 120 }, 1500);
        if (logs.epoch === initial.epoch) {
          run.errorRefs = (logs.entries as Log[]).filter(log => logLevel(log) === "error").slice(0, 12)
            .map(log => ({ epoch: String(logs.epoch), seq: log.seq }));
        }
      } catch { /* The run outcome is still available if FXServer exited. */ }
    }
    run.state = run.failed.length || run.cleanupErrors.length ? "failed" : "passed";
    run.durationMs = Date.now() - run.started;
    await mkdir(history, { recursive: true });
    await writeFile(resolve(history, run.id + ".json"), JSON.stringify(run), { flag: "wx" });
    return run;
  }

  async cleanup(server: ServerConfig, id: number, session?: string, scope?: string) {
    if (this.locked(server.id, id)) throw new Error("Participant is reserved by a running scenario");
    return this.runtime.bridge(server, "cleanup", { player: id, session, scope });
  }

  async shutdown() {
    this.shutdownSignal.abort();
    await Promise.allSettled(this.tasks);
  }
}
