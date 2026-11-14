// Reads the local FiveM client log (CitizenFX_log_*.log). It contains client Lua output, script errors
// and NUI console messages (thread CrBrowserMain) with @resource/file:line references.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { enrichLog, logLevel } from "./runtime.js";

type ClientLogQuery = { after?: string; limit: number; level?: "error" | "warning"; resource?: string; contains?: string };
type Entry = { t: number; thread: string; message: string; end: number };

const prefix = /^\[\s*(\d+)\]\s+\[[^\]]*\]\s+(.+?)\/ ?(.*)$/;
const tailBytes = 512 * 1024;
const chunkBytes = 2 * 1024 * 1024;

async function latest(dir: string) {
  const files = (await readdir(dir).catch(() => { throw new Error("FiveM client log folder not found: " + dir); }))
    .filter(name => /^CitizenFX_log_.*\.log$/.test(name)).sort();
  if (!files.length) throw new Error("No FiveM client log found in " + dir);
  return files.at(-1)!;
}

async function readRange(path: string, from: number, to: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// Parses whole lines. Each entry records the byte offset just past its last line (relative to the buffer).
function parse(buffer: Buffer) {
  const entries: Entry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let newline = buffer.indexOf(10, offset);
    if (newline === -1) newline = buffer.length;
    const line = buffer.toString("utf8", offset, newline).trimEnd();
    offset = newline + 1;
    const match = prefix.exec(line);
    if (match) {
      const message = match[3].trim();
      if (message) entries.push({ t: Number(match[1]), thread: match[2].trim(), message, end: offset });
    } else if (line.trim() && entries.length) {
      const last = entries.at(-1)!;
      if (last.message.length < 1500) last.message += "\n" + line;
      last.end = offset;
    }
  }
  return entries;
}

export class ClientLog {
  constructor(readonly dir: string) {}

  /** Cursor at the current end of the log, for reading only what happens next. */
  async cursor() {
    const file = await latest(this.dir);
    return file + ":" + (await stat(join(this.dir, file))).size;
  }

  async read(query: ClientLogQuery) {
    const file = await latest(this.dir);
    const path = join(this.dir, file);
    const size = (await stat(path)).size;
    const cursor = query.after ? /^(CitizenFX_log_[^:]+\.log):(\d+)$/.exec(query.after) : null;
    if (query.after && !cursor) throw new Error("Invalid cursor. Pass the next value from a previous read");
    // A different file means the game restarted, so read the new file from the start.
    const rotated = Boolean(cursor && cursor[1] !== file);
    let start = cursor && !rotated ? Math.min(Number(cursor[2]), size) : rotated ? 0 : Math.max(0, size - tailBytes);
    let buffer = await readRange(path, start, Math.min(size, start + chunkBytes));
    if (!cursor && start > 0) {
      // Drop the partial first line of a tail read.
      const first = buffer.indexOf(10) + 1;
      buffer = buffer.subarray(first);
      start += first;
    }
    // Only consume whole lines so the next cursor starts on a line boundary.
    buffer = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
    const needle = query.contains?.toLowerCase();
    const matches = parse(buffer).map(entry => ({ ...entry, ...enrichLog({ seq: 0, at: 0, channel: entry.thread, message: entry.message }) }))
      .filter(entry => (!query.level || logLevel(entry) === query.level)
        && (!query.resource || entry.resource?.toLowerCase() === query.resource.toLowerCase())
        && (!needle || entry.message.toLowerCase().includes(needle)));
    const paged = Boolean(cursor) && matches.length > query.limit;
    const selected = cursor ? matches.slice(0, query.limit) : matches.slice(-query.limit);
    return {
      next: file + ":" + (start + (paged ? selected.at(-1)!.end : buffer.length)),
      ...(rotated ? { rotated: true } : {}),
      ...(paged ? { more: true } : {}),
      entries: selected.map(entry => "[" + entry.t + " " + entry.thread + "] " + entry.message.slice(0, 600)),
    };
  }
}
