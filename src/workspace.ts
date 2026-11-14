import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { name, stateDir } from "./config.js";

const limit = 256 * 1024;
const sourceExtensions = new Set([".lua", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".md", ".sql", ".xml", ".ytyp", ".meta"]);
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const protectedNames = new Set(["bakery_ai_bridge", "bakery_fivem_mcp", "fivem-unofficialmcp", "fivem-unofficial-mcp", "node_modules"]);
const skip = new Set(["node_modules", ".git", ".bakery-data"]);
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export function resourceName(value: string) {
  if (!name.safeParse(value).success || reserved.test(value) || protectedNames.has(value.toLowerCase())) throw new Error("Invalid or protected resource name");
  return value;
}

async function statIfPresent(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function checked(root: string, parts: string[], parents = false) {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("Path escapes workspace");
    const last = index === parts.length - 1;
    let stat = await statIfPresent(path);
    if (!stat && parents && !last) {
      await mkdir(path).catch(error => { if (error.code !== "EEXIST") throw error; });
      stat = await lstat(path);
    }
    if (stat?.isSymbolicLink() || (stat && !samePath(await realpath(path), path))) throw new Error("Linked paths are excluded");
    if (!last && !stat?.isDirectory()) throw new Error("Parent directory is missing");
  }
  return path;
}

async function hasManifest(path: string) {
  for (const file of ["fxmanifest.lua", "__resource.lua"]) {
    const stat = await statIfPresent(resolve(path, file));
    if (stat?.isFile() && !stat.isSymbolicLink()) return true;
  }
  return false;
}

async function resourcePath(root: string, resource: string) {
  const path = await checked(root, [resourceName(resource)]);
  if (!(await statIfPresent(path))?.isDirectory() || !await hasManifest(path)) throw new Error("Resource has no manifest in this workspace");
  return path;
}

function fileParts(file: string) {
  const parts = file.split("/");
  if (parts.length > 12 || parts.some(part => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(part) ||
    part.endsWith(".") || reserved.test(part) || skip.has(part.toLowerCase()) || /(?:secret|credential)/i.test(part))) {
    throw new Error("Use a workspace-relative source path with forward slashes");
  }
  if (!sourceExtensions.has(extname(file).toLowerCase())) throw new Error("Unsupported source file extension");
  return parts;
}

async function readSource(path: string) {
  const stat = await statIfPresent(path);
  if (!stat?.isFile() || stat.size > limit) throw new Error("Source file is missing or exceeds 256 KiB");
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("Source file exceeds 256 KiB");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (content.includes("\0")) throw new Error("Binary file is excluded");
    return { content, sha256: createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex") };
  } finally { await fd.close(); }
}

const writing = new Set<string>();
export async function withResourceLock<T>(root: string, resource: string, fn: () => Promise<T>) {
  const key = resolve(root, resource).toLowerCase();
  if (writing.has(key)) throw new Error("Resource operation already in progress");
  writing.add(key);
  try { return await fn(); } finally { writing.delete(key); }
}

export async function listResources(root: string, prefix: string, after: string, count: number) {
  const resources: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || protectedNames.has(entry.name.toLowerCase())) continue;
    if (entry.name <= after || !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (await hasManifest(resolve(root, entry.name))) resources.push(entry.name);
    if (resources.length > count) break;
  }
  return { resources: resources.slice(0, count), next: resources.length > count ? resources[count - 1] : null };
}

export async function readResource(root: string, resource: string, file?: string, from = 1, count = 120, directory?: string) {
  const path = await resourcePath(root, resource);
  if (!file) {
    const folder = directory ? await checked(path, fileParts(directory + "/index.lua").slice(0, -1)) : path;
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(e => !e.isSymbolicLink() && !e.name.startsWith(".") && !skip.has(e.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { entries: entries.slice(from - 1, from - 1 + count).map(e => ({ name: e.name, directory: e.isDirectory() })), total: entries.length };
  }
  const { content, sha256 } = await readSource(await checked(path, fileParts(file)));
  const lines = content.split("\n");
  const page = lines.slice(from - 1, from - 1 + count).join("\n");
  return { file, sha256, from, totalLines: lines.length, content: page.slice(0, 24000), truncated: page.length > 24000 };
}

export function createResource(root: string, resource: string, language: "lua" | "js") {
  return withResourceLock(root, resource, async () => {
    const path = await checked(root, [resourceName(resource)]);
    if (await statIfPresent(path)) throw new Error("Resource directory already exists");
    const stage = resolve(root, ".bakery-stage-" + randomUUID());
    await mkdir(stage);
    try {
      const files = {
        "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\n\nclient_script 'client.${language}'\nserver_script 'server.${language}'\n`,
        [`client.${language}`]: language === "lua" ? "-- Client-side scripts\n" : "// Client-side scripts\n",
        [`server.${language}`]: language === "lua" ? "-- Server-side scripts\n" : "// Server-side scripts\n",
      };
      for (const [file, contents] of Object.entries(files)) await writeFile(resolve(stage, file), contents, { flag: "wx" });
      await rename(stage, path);
      return { resource, files: Object.keys(files) };
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}

export function editResource(root: string, resource: string, file: string, content: string, expected: string | null) {
  return withResourceLock(root, resource, async () => {
    if (Buffer.byteLength(content) > limit || content.includes("\0")) throw new Error("Source exceeds 256 KiB or contains binary data");
    const path = await resourcePath(root, resource);
    const parts = fileParts(file);
    const target = await checked(path, parts, expected === null);
    const current = await statIfPresent(target);
    if ((expected === null && current) || (expected !== null && (!current || (await readSource(target)).sha256 !== expected))) {
      throw new Error("File changed or exists. Read it again before editing");
    }
    const temporary = resolve(dirname(target), ".bakery-write-" + randomUUID());
    try {
      await writeFile(temporary, content, { flag: "wx", mode: current ? current.mode & 0o777 : 0o644 });
      if (expected === null) await link(temporary, target);
      else {
        if ((await readSource(await checked(path, parts))).sha256 !== expected) throw new Error("File changed during editing");
        await rename(temporary, target);
      }
    } finally { await rm(temporary, { force: true }); }
    return { resource, file, sha256: createHash("sha256").update(content).digest("hex") };
  });
}

async function copyTree(source: string, target: string, budget: { files: number; bytes: number }, depth = 0) {
  if (depth > 20) throw new Error("Deployment exceeds directory depth limit");
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skip.has(entry.name.toLowerCase())) continue;
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    const stat = await lstat(from);
    if (stat.isSymbolicLink() || !samePath(await realpath(from), from)) throw new Error("Deployment contains a linked path");
    if (stat.isDirectory()) await copyTree(from, to, budget, depth + 1);
    else if (stat.isFile()) {
      if (++budget.files > 4000 || (budget.bytes += stat.size) > 512 * 1024 * 1024) throw new Error("Deployment exceeds file or size limit");
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else throw new Error("Deployment contains an unsupported file type");
  }
}

export async function deployResource(root: string, destination: string, resource: string) {
  const source = await resourcePath(root, resource);
  const deployRoot = await realpath(destination);
  if (samePath(root, deployRoot)) return { resource, mode: "shared_workspace" };
  const target = await checked(deployRoot, [resource]);
  const existing = await statIfPresent(target);
  if (existing) {
    const marker = await checked(target, [".bakery-deployed.json"]);
    if (!existing.isDirectory() || !(await statIfPresent(marker))?.isFile() || JSON.parse((await readSource(marker)).content).source !== source) {
      throw new Error("Destination belongs to an unmanaged resource");
    }
  }
  const suffix = randomUUID();
  const stage = resolve(deployRoot, ".bakery-stage-" + suffix);
  const backup = resolve(deployRoot, ".bakery-backup-" + suffix);
  const budget = { files: 0, bytes: 0 };
  let moved = false;
  try {
    await copyTree(source, stage, budget);
    await writeFile(resolve(stage, ".bakery-deployed.json"), JSON.stringify({ source }), { flag: "wx" });
    if (existing) { await rename(target, backup); moved = true; }
    await rename(stage, target);
  } catch (error) {
    if (moved) {
      try { await rename(backup, target); }
      catch { throw new Error("Deployment rollback failed. Recover the resource from " + basename(backup)); }
    }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
  if (moved) await rm(backup, { recursive: true, force: true });
  return { resource, mode: "copied", ...budget };
}

export async function quarantineResource(root: string, resource: string, requestId: string) {
  const source = await resourcePath(root, resource);
  const trash = resolve(stateDir, "trash");
  await mkdir(trash, { recursive: true });
  const recoveryPath = resolve(trash, requestId + "-" + resource);
  await rename(source, recoveryPath);
  return { resource, recoveryPath };
}

