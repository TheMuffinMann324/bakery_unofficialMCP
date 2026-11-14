import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stateDir } from "./config.js";

type Request = { id: string; resource: string; workspace: string; created: number };
const approvals = resolve(stateDir, "approvals");
const approvalPath = (id: string, suffix: string) => resolve(approvals, id + "." + suffix + ".json");
const privateFile = { flag: "wx", mode: 0o600 } as const;

export async function requestDelete(workspace: string, resource: string) {
  await mkdir(approvals, { recursive: true });
  const request: Request = { id: randomUUID(), resource, workspace, created: Date.now() };
  await writeFile(approvalPath(request.id, "request"), JSON.stringify(request), privateFile);
  return { approvalRequired: true, requestId: request.id, expiresInSeconds: 600 };
}

async function readRequest(id: string): Promise<Request> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid approval ID");
  const request = JSON.parse(await readFile(approvalPath(id, "request"), "utf8")) as Request;
  if (Date.now() - request.created > 600000) throw new Error("Approval expired");
  return request;
}

export async function approveDelete(id: string, confirmPath: string) {
  const request = await readRequest(id);
  if (resolve(request.workspace, request.resource) !== resolve(confirmPath)) throw new Error("Approval requires the exact resource directory");
  await writeFile(approvalPath(id, "approved"), JSON.stringify(request), privateFile);
}

export async function consumeDelete(id: string, workspace: string, resource: string) {
  const request = await readRequest(id);
  if (request.workspace !== workspace || request.resource !== resource) throw new Error("Approval belongs to a different resource");
  const approved = JSON.parse(await readFile(approvalPath(id, "approved"), "utf8"));
  if (JSON.stringify(approved) !== JSON.stringify(request)) throw new Error("Approval does not match request");
  await writeFile(approvalPath(id, "used"), "used", privateFile);
}
