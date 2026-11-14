import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadConfig, stateDir } from "./config.js";
import { sourceNames, type Document, type Snapshot, type SourceName } from "./knowledge-sources.js";

const folder = resolve(stateDir, "knowledge");
const maxPage = 512 * 1024;
const repoHost = "https://api.github.com/repos/";
const repoRaw = "https://raw.githubusercontent.com/";
const repoWeb = "https://github.com/";
const kqHost = "https://docs.kuzquality.com";
const markdown = /\.mdx?$/i;

async function download(url: string, maximum = maxPage) {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(14000), redirect: "error", headers: { "user-agent": "bakery-fivem-mcp" } });
    } catch (error) {
      if (attempt < 1) continue;
      throw new Error("Download failed for " + url, { cause: error });
    }
    if (response.status >= 500 && attempt < 1) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new Error("HTTP " + response.status + " for " + url);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, bytes).toString("utf8");
        bytes += value.length;
        if (bytes > maximum) throw new Error("Download exceeds size limit for " + url);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
  }
}

async function mapLimited<T, U>(items: T[], work: (item: T) => Promise<U>) {
  let cursor = 0;
  const output: U[] = [];
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => {
    while (cursor < items.length && !errors.length) {
      const index = cursor++;
      try { output[index] = await work(items[index]); }
      catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
  return output;
}

const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function guide(id: string, path: string, url: string, raw: string, revision?: string): Document {
  const clean = raw.replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(clean);
  const title = (front?.[1].match(/^title:\s*(.+)$/m)?.[1] ??
    clean.match(/^#\s+(.+)$/m)?.[1] ?? path.split("/").at(-1)!.replace(markdown, "")).replace(/^(['"])(.*)\1$/, "$2");
  const body = front ? clean.slice(front[0].length) : clean;
  const text = body.replace(/^> For the complete documentation index[^\n]*\n\n?/m, "")
    .replace(/\n(?:---\n)?# Agent Instructions\n[\s\S]*$/, "").trim();
  return { id, title, kind: "guide", path, url, revision, text: text || title };
}

type GitTree = { sha: string; truncated: boolean; tree: { path: string; type: string; size?: number }[] };
const trees = new Map<string, Promise<GitTree>>();

async function repository(repo: string, branch: string, select: (path: string) => boolean) {
  const key = repo + "/" + branch;
  let pending = trees.get(key);
  if (!pending) {
    pending = download(repoHost + repo + "/git/trees/" + branch + "?recursive=1", 4 * 1024 * 1024)
      .then(text => JSON.parse(text) as GitTree);
    trees.set(key, pending);
  }
  const tree = await pending;
  if (tree.truncated || !/^[a-f0-9]{40}$/.test(tree.sha)) throw new Error("Incomplete upstream tree for " + repo);
  const files = tree.tree.filter(item => item.type === "blob" && markdown.test(item.path) && select(item.path));
  if (!files.length || files.length > 1000 || files.some(file => (file.size ?? 0) > maxPage)) throw new Error("Unexpected documentation size for " + repo);
  return mapLimited(files, async file => {
    const key = repo + "/" + tree.sha + "/" + encoded(file.path);
    return guide("docs/" + file.path, file.path, repoWeb + repo + "/blob/" + tree.sha + "/" + encoded(file.path),
      await download(repoRaw + key), tree.sha);
  });
}

type Native = {
  name: string;
  params?: { name: string; type: string; description?: string }[];
  results?: string;
  resultsDescription?: string;
  description?: string;
  apiset?: Document["apiSet"];
  aliases?: string[];
  jhash?: string;
  examples?: { lang: string; code: string }[];
};

async function natives(filename: string, defaultApiSet: Document["apiSet"]) {
  const url = "https://runtime.fivem.net/doc/" + filename;
  const data = JSON.parse(await download(url, 8 * 1024 * 1024)) as Record<string, Record<string, Native>>;
  const docs: Document[] = [];
  for (const [namespace, group] of Object.entries(data)) {
    for (const [hash, entry] of Object.entries(group)) {
      if (!entry.name || !/^0x[0-9a-f]+$/i.test(hash)) continue;
      const apiSet = entry.apiset ?? defaultApiSet;
      const params = entry.params ?? [];
      const signature = (entry.results ?? "void") + " " + entry.name + "(" + params.map(param => param.type + " " + param.name).join(", ") + ")";
      const lines = ["# " + entry.name, "", "Namespace: " + namespace + " | API set: " + apiSet + " | Hash: " + hash,
        "", "```c", signature, "```", "", entry.description ?? ""];
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      if (aliases.length) lines.push("", "Aliases: " + aliases.join(", "));
      if (params.length) lines.push("", "## Parameters", ...params.map(param => "- `" + param.name + "` (`" + param.type + "`)" + (param.description ? " — " + param.description : "")));
      if (entry.resultsDescription) lines.push("", "## Returns", entry.resultsDescription);
      for (const example of entry.examples ?? []) {
        if (example.code) lines.push("", "## Example (" + example.lang + ")", "```" + example.lang, example.code, "```");
      }
      docs.push({ id: "native/" + namespace + "/" + hash, title: entry.name, kind: "native", apiSet,
        url: "https://docs.fivem.net/natives/?" + hash, keywords: [namespace, hash, entry.jhash, ...aliases].filter(Boolean).join(" "),
        text: lines.join("\n").replace(/\r\n/g, "\n") });
    }
  }
  if (docs.length < 100) throw new Error("Incomplete native reference " + filename);
  return docs;
}

async function localKq(workspace: string) {
  const docs: Document[] = [];
  const root = join(workspace, "kq_link");
  const entry = (await readdir(workspace, { withFileTypes: true })).find(dir => dir.name.toLowerCase() === "kq_link");
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return docs;
  let revision: string | undefined;
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (dir.name === "fxmanifest.lua" && dir.isFile() && !dir.isSymbolicLink()) {
      revision = /^\s*version\s+['"]([^'"]+)['"]/m.exec(await readFile(join(root, dir.name), "utf8"))?.[1];
    }
  }
  async function walk(directory: string, depth = 0) {
    if (depth > 8) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
      const path = join(directory, item.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (item.isDirectory() && (depth > 0 || ["exports", "links", "resource"].includes(item.name))) await walk(path, depth + 1);
      if (!item.isFile() || !(rel === "README.md" || rel === "fxmanifest.lua" || (depth > 0 && item.name.endsWith(".lua")))) continue;
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > maxPage || text.includes("\0")) continue;
      docs.push({ id: "installed/" + rel, title: "kq_link " + rel, kind: "local_source", path: "kq_link/" + rel, revision, text: text.replace(/\r\n/g, "\n") });
    }
  }
  await walk(root);
  return docs;
}

async function kqGuides() {
  const index = await download(kqHost + "/llms.txt");
  const pages = [...new Set(index.match(/https:\/\/docs\.kuzquality\.com\/kq-link\/[A-Za-z0-9_/-]+\.md\b/g) ?? [])];
  if (!pages.length || pages.length > 100) throw new Error("KuzQuality did not publish a KQ Link page index");
  return mapLimited(pages, async page => {
    const path = new URL(page).pathname.slice(1);
    return guide("docs/" + path, path, page.replace(/\.md$/, ""), await download(page));
  });
}

async function collect(source: SourceName, workspace: string): Promise<Document[]> {
  switch (source) {
    case "fivem": {
      const sets = await Promise.all([
        repository("citizenfx/fivem-docs", "master", path => path.startsWith("content/docs/")),
        natives("natives.json", "client"), natives("natives_cfx.json", "shared"),
      ]);
      return [...new Map(sets.flat().map(doc => [doc.id, doc])).values()];
    }
    case "kq_link":
      return (await Promise.all([kqGuides(), localKq(workspace)])).flat();
    case "ox_lib":
    case "oxmysql":
      return repository("overextended/overextended.github.io", "main", path => path.startsWith("content/docs/" + source + "/"));
    case "qbx":
      return repository("Qbox-project/qbox-docs", "main", path => path.startsWith("docs/") && !path.startsWith("docs/dashboard/"));
    case "qbcore":
      return repository("qbcore-framework/qb-docs", "main", path => !path.startsWith(".") && !path.startsWith("mantle/") && path !== "README.md" && path !== "SUMMARY.md");
    case "esx":
      return repository("esx-framework/esx-legacy-documentation", "tested", path => path.startsWith("src/pages/en/"));
  }
}

const requested = process.argv.slice(2);
if (requested.some(source => !sourceNames.includes(source as SourceName))) {
  console.error("Usage: npm run knowledge:sync -- [" + sourceNames.join(" | ") + "] ...");
  process.exitCode = 1;
} else {
  const { workspace } = await loadConfig();
  await mkdir(folder, { recursive: true });
  const selected = [...new Set(requested.length ? requested as SourceName[] : sourceNames)];
  const outcomes = await Promise.allSettled(selected.map(async source => {
    const documents = await collect(source, workspace);
    const snapshot: Snapshot = { version: 1, updated: new Date().toISOString(), documents };
    const temp = join(folder, source + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temp, JSON.stringify(snapshot), { flag: "wx" });
      await rename(temp, join(folder, source + ".json"));
    } finally { await rm(temp, { force: true }); }
    console.log(source + ": " + documents.length + " documents");
  }));
  for (const [index, result] of outcomes.entries()) {
    if (result.status === "rejected") {
      console.error(selected[index] + ": " + String(result.reason) + ". Previous snapshot retained if present.");
      process.exitCode = 1;
    }
  }
}
