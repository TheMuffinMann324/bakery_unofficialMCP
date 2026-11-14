import { z } from "zod";
import { clientCommand, name } from "./config.js";

export const player = z.number().int().min(1).max(65534);
export const position = z.strictObject({ x: z.number().min(-20000).max(20000), y: z.number().min(-20000).max(20000), z: z.number().min(-4000).max(4000) });
const spawn = z.strictObject({ model: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), position: position.optional(), heading: z.number().min(-360).max(360).optional() });
// Named GTA controls for game_input. On foot, movement is read from the axis controls
// (31 = forward/back, 30 = left/right), so those names carry a direction sign. Raw IDs (0-360) are accepted too.
const axes = { forward: [31, -1], back: [31, 1], left: [30, -1], right: [30, 1] } as const;
const controls = {
  ...axes, sprint: 21, jump: 22, enter_vehicle: 23, attack: 24, aim: 25,
  interact: 38, context: 51, cover: 44, reload: 45, phone: 27, accelerate: 71, brake: 72, steer: 59,
  handbrake: 76, horn: 86, exit_vehicle: 75, look_behind: 79, frontend_accept: 201, frontend_cancel: 202, pause: 199,
} as const;
const control = z.strictObject({
  control: z.union([z.enum(Object.keys(controls) as [keyof typeof controls, ...(keyof typeof controls)[]]), z.number().int().min(0).max(360)]),
  value: z.number().min(-1).max(1).default(1),
});
const inputData = z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 8000, "Adapter input exceeds 8 KiB");
export const operations = {
  state: z.strictObject({}),
  spawn_vehicle: spawn.extend({ warpIn: z.boolean().optional() }),
  spawn_ped: spawn,
  spawn_object: spawn,
  delete_entity: z.strictObject({ entityId: z.number().int().positive() }),
  entities: z.strictObject({}),
  teleport: z.strictObject({ position }),
  weather: z.strictObject({ weather: z.enum(["CLEAR", "EXTRASUNNY", "CLOUDS", "OVERCAST", "RAIN", "THUNDER", "FOGGY", "SMOG", "CLEARING", "NEUTRAL", "SNOW", "BLIZZARD", "SNOWLIGHT", "XMAS", "HALLOWEEN"]) }),
  time: z.strictObject({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59).default(0) }),
  reset_environment: z.strictObject({}),
  adapter: z.strictObject({ resource: name, action: name, side: z.enum(["client", "server"]).default("client"), data: inputData.default({}) }),
  client_command: z.strictObject({ command: clientCommand, args: z.array(z.string().regex(/^[A-Za-z0-9_.,:+\-/]{1,100}$/)).max(16).default([]) }),
  input: z.strictObject({ controls: z.array(control).min(1).max(8), durationMs: z.number().int().min(16).max(4000).default(250) }),
};

/** Bridge arguments for an operation: named controls become numeric GTA control IDs. */
export function bridgeArgs(action: keyof typeof operations, args: Record<string, unknown>) {
  if (action !== "input") return args;
  const list = args.controls as z.output<typeof control>[];
  return { ...args, controls: list.map(item => {
    const named = typeof item.control === "number" ? item.control : controls[item.control];
    return typeof named === "number" ? { control: named, value: item.value } : { control: named[0], value: named[1] * item.value };
  }) };
}
const operationName = z.enum(Object.keys(operations) as [keyof typeof operations, ...(keyof typeof operations)[]]);
const valuePath = z.string().regex(/^(?:[a-zA-Z0-9_]+\.){0,7}[a-zA-Z0-9_]+$/);
const reference = z.strictObject({
  from: name,
  path: valuePath,
});
const comparison = reference.extend({
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "exists"]).default("eq"),
  value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
});
export type Comparison = z.infer<typeof comparison>;
const base = { when: comparison.optional() };
const actionStep = z.strictObject({
  ...base,
  type: z.literal("action"),
  participant: name.default("default"),
  action: operationName,
  args: z.record(z.string(), z.json()).default({}),
  bind: z.record(valuePath, reference).default({}),
  saveAs: name.optional(),
});
export const scenario = z.strictObject({
  name,
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  steps: z.array(z.discriminatedUnion("type", [
    actionStep,
    z.strictObject({ ...base, type: z.literal("delay"), ms: z.number().int().min(0).max(5000) }),
    z.strictObject({ ...base, type: z.literal("assert"), check: comparison }),
  ])).min(1).max(40),
  cleanup: z.array(actionStep).max(8).default([]),
});
export type Scenario = z.infer<typeof scenario>;
export const participants = z.record(name, player).refine(value => Object.keys(value).length <= 8, "At most eight test clients are supported");
