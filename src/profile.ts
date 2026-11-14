import { readFile, stat } from "node:fs/promises";

type TraceEvent = { name: string; ph: string; ts: number; pid: number; tid: number; cat: string };

export async function measureResource(path: string, resource: string) {
  const size = (await stat(path)).size;
  if (size > 24 * 1024 * 1024) throw new Error("Profile exceeds the 24 MiB analysis limit");
  const trace = JSON.parse(await readFile(path, "utf8")) as { traceEvents?: TraceEvent[] };
  if (!Array.isArray(trace.traceEvents)) throw new Error("Unsupported Cfx trace format");
  const key = "tick (" + resource + ")";
  const starts = new Map<string, number[]>();
  const samples: number[] = [];
  for (const event of trace.traceEvents) {
    if (event.cat !== "blink.user_timing" || event.name !== key || !Number.isFinite(event.ts)) continue;
    const thread = event.pid + ":" + event.tid;
    const stack = starts.get(thread) ?? [];
    starts.set(thread, stack);
    if (event.ph === "B") stack.push(event.ts);
    if (event.ph === "E") {
      const start = stack.pop();
      if (start !== undefined && event.ts >= start) samples.push((event.ts - start) / 1000);
    }
  }
  samples.sort((a, b) => a - b);
  const count = samples.length;
  return { samples: count, mean: count ? samples.reduce((a, b) => a + b, 0) / count : null,
    p95: samples[Math.ceil(count * 0.95) - 1] ?? null, max: samples.at(-1) ?? null };
}
