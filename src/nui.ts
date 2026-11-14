// Drives FiveM NUI pages through the client's Chrome DevTools endpoint (127.0.0.1:13172 by default).
// Each resource's ui_page is an iframe inside nui://game/ui/root.html; we evaluate inside that frame's main world.

type Target = { url: string; webSocketDebuggerUrl: string };
type Frame = { frame: { id: string; url: string }; childFrames?: Frame[] };
type Message = { id?: number; method?: string; params?: { context?: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } };
  result?: Record<string, unknown>; error?: { message: string } };

function frameResource(url: string) {
  return /^https:\/\/cfx-nui-([^/]+)\//i.exec(url)?.[1] ?? /^nui:\/\/([^/]+)\//i.exec(url)?.[1];
}

async function session<T>(port: number, run: (send: (method: string, params?: object) => Promise<Record<string, unknown>>,
  contexts: Map<string, number>) => Promise<T>) {
  let targets: Target[];
  try {
    targets = await (await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(2000) })).json() as Target[];
  } catch {
    throw new Error("NUI DevTools is unreachable on 127.0.0.1:" + port + ". The FiveM client must run on this machine");
  }
  const root = targets.find(target => target.url === "nui://game/ui/root.html");
  if (!root) throw new Error("FiveM root NUI page not found. Join a server first");
  const socket = new WebSocket(root.webSocketDebuggerUrl);
  const waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const contextByFrame = new Map<string, number>();
  let next = 0;
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const job = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) job?.reject(new Error(message.error.message));
      else job?.resolve(message.result ?? {});
    } else if (message.method === "Runtime.executionContextCreated") {
      const context = message.params?.context;
      if (context?.auxData?.isDefault && context.auxData.frameId) contextByFrame.set(context.auxData.frameId, context.id);
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("NUI DevTools connection timed out")), 3000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("NUI DevTools connection failed")); };
  });
  socket.onclose = () => { for (const job of waiting.values()) job.reject(new Error("NUI DevTools connection closed")); waiting.clear(); };
  const send = (method: string, params: object = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const tree = (await send("Page.getFrameTree")).frameTree as Frame;
    const frames = new Map<string, string>();
    for (const child of tree.childFrames ?? []) {
      const name = frameResource(child.frame.url);
      if (name) frames.set(name.toLowerCase(), child.frame.id);
    }
    await send("Runtime.enable");
    const contexts = new Map<string, number>();
    for (const [name, frameId] of frames) {
      const context = contextByFrame.get(frameId);
      if (context !== undefined) contexts.set(name, context);
    }
    return await run(send, contexts);
  } finally { socket.close(); }
}

async function evaluate(send: (method: string, params?: object) => Promise<Record<string, unknown>>, contextId: number, expression: string) {
  const reply = await send("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true, timeout: 5000 });
  const details = reply.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
  if (details) throw new Error((details.exception?.description ?? details.text ?? "Evaluation failed").split("\n")[0].slice(0, 400));
  return (reply.result as { value?: unknown }).value;
}

function context(contexts: Map<string, number>, resource: string) {
  const id = contexts.get(resource.toLowerCase());
  if (id === undefined) throw new Error("No NUI page for " + resource + ". Use nui_list to see resources with a ui_page");
  return id;
}

// Runs inside the NUI page. Kept dependency-free and self-contained.
const pageScript = String.raw`(function (command, input) {
  const MAX = input.maxChars || 6000;
  const interactiveTags = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL"]);
  const roles = /^(button|link|tab|menuitem|checkbox|radio|switch|option|combobox|slider|textbox)$/;
  function visible(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // display: contents has no box of its own; its children decide.
    if (style.display === "contents") return true;
    if (!el.getClientRects().length) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (getComputedStyle(node).opacity === "0") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }
  function interactive(el) {
    if (el.disabled) return false;
    if (interactiveTags.has(el.tagName) && !(el.tagName === "A" && !el.hasAttribute("href") && !el.onclick)) return true;
    if (roles.test(el.getAttribute("role") || "") || el.isContentEditable || el.hasAttribute("onclick")) return true;
    if (el.tabIndex >= 0 && el.hasAttribute("tabindex")) return true;
    return getComputedStyle(el).cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer");
  }
  function label(el) {
    let text = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
    if (!text) {
      // Icon-only controls: name them after the icon's class (e.g. lucide-x -> icon:x).
      const icon = el.querySelector("svg[class], i[class], img[alt]");
      const cls = icon ? (icon.getAttribute("alt") || String(icon.getAttribute("class"))) : "";
      const named = /(?:lucide|fa|icon|mdi|bi|ri)-([a-z0-9-]+)/i.exec(cls);
      text = named ? "icon:" + named[1] : cls ? "icon" : "";
    }
    return text.slice(0, 80);
  }
  function describe(el) {
    const role = el.getAttribute("role") || (el.tagName === "INPUT" ? "input:" + (el.type || "text") : el.tagName.toLowerCase());
    let out = role + ' "' + label(el) + '"';
    if ("value" in el && el.tagName !== "BUTTON" && el.value !== undefined && el.value !== "") out += " value=" + JSON.stringify(String(el.value).slice(0, 60));
    if (el.checked) out += " checked";
    if (el.getAttribute("aria-selected") === "true" || el.classList.contains("active")) out += " active";
    return out;
  }
  function find() {
    if (input.ref != null) {
      const el = document.querySelector('[data-bakery-ref="' + Number(input.ref) + '"]');
      if (!el) throw new Error("Ref " + input.ref + " not found. Take a new nui_snapshot");
      return el;
    }
    if (input.selector) {
      const el = Array.from(document.querySelectorAll(input.selector)).find(visible);
      if (!el) throw new Error("No visible element matches " + input.selector);
      return el;
    }
    if (input.text) {
      const needle = input.text.toLowerCase();
      const all = Array.from(document.querySelectorAll("body *")).filter(el => interactive(el) && visible(el));
      const exact = all.find(el => label(el).toLowerCase() === needle);
      const el = exact || all.find(el => label(el).toLowerCase().includes(needle));
      if (!el) throw new Error('No visible interactive element with text "' + input.text + '"');
      return el;
    }
    return document.activeElement || document.body;
  }
  function point(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  }
  function key(el, name) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
    const init = { key: name, code: name.length === 1 ? "Key" + name.toUpperCase() : name, keyCode: codes[name] || name.toUpperCase().charCodeAt(0), which: codes[name] || 0, bubbles: true, cancelable: true };
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, init));
  }
  if (command === "exists") {
    if (input.selector) return { found: Array.from(document.querySelectorAll(input.selector)).some(visible) };
    return { found: (document.body ? document.body.innerText : "").toLowerCase().includes(String(input.text).toLowerCase()) };
  }
  if (command === "probe") {
    const shown = Array.from(document.body ? document.body.querySelectorAll("*") : []).some(el => el.children.length === 0 && visible(el) && (el.innerText || "").trim());
    return { visible: shown, title: document.title };
  }
  if (command === "snapshot") {
    document.querySelectorAll("[data-bakery-ref]").forEach(el => el.removeAttribute("data-bakery-ref"));
    const root = input.selector ? document.querySelector(input.selector) : document.body;
    if (!root) throw new Error("No element matches " + input.selector);
    const lines = [];
    let ref = 0, size = 0, truncated = false, pending = [];
    const push = line => { if (size + line.length > MAX) { truncated = true; return; } lines.push(line); size += line.length + 1; };
    // Inline text within one block is joined onto a single line.
    const flush = () => { const text = pending.join(" ").replace(/\s+/g, " ").trim(); pending = []; if (text) push(text.slice(0, 300)); };
    const walk = node => {
      if (truncated) return;
      if (node.nodeType === 3) {
        if (node.textContent.trim() && node.parentElement && visible(node.parentElement)) pending.push(node.textContent);
        return;
      }
      if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"].includes(node.tagName.toUpperCase())) return;
      if (!visible(node) && node !== root) return;
      if (interactive(node) && node !== root) {
        flush();
        node.setAttribute("data-bakery-ref", String(++ref));
        push("[" + ref + "] " + describe(node));
        return;
      }
      if (/^H[1-6]$/.test(node.tagName)) { flush(); push("# " + label(node)); return; }
      if (node.tagName === "IMG") { const alt = node.getAttribute("alt"); if (alt) pending.push("[img " + alt.slice(0, 60) + "]"); return; }
      const display = getComputedStyle(node).display;
      const block = !display.startsWith("inline") && display !== "contents";
      if (block) flush();
      for (const child of node.childNodes) walk(child);
      if (block) flush();
    };
    walk(root);
    flush();
    const deduped = lines.filter((line, i) => line !== lines[i - 1]);
    return { content: deduped.join("\n"), refs: ref, truncated };
  }
  if (command === "act") {
    const el = find();
    const action = input.action;
    if (action === "click" || action === "hover") {
      const at = point(el);
      const pointer = Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, at);
      el.dispatchEvent(new PointerEvent("pointerover", pointer));
      el.dispatchEvent(new MouseEvent("mouseover", at));
      el.dispatchEvent(new MouseEvent("mouseenter", Object.assign({}, at, { bubbles: false })));
      if (action === "click") {
        el.dispatchEvent(new PointerEvent("pointerdown", pointer));
        el.dispatchEvent(new MouseEvent("mousedown", at));
        if (typeof el.focus === "function") el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", pointer));
        el.dispatchEvent(new MouseEvent("mouseup", at));
        el.dispatchEvent(new MouseEvent("click", at));
      }
    } else if (action === "type") {
      if (typeof el.focus === "function") el.focus();
      if (el.isContentEditable) el.textContent = input.value;
      else {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, input.value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (input.submit) { key(el, "Enter"); if (el.form && el.form.requestSubmit) el.form.requestSubmit(); }
    } else if (action === "key") {
      key(el, input.value);
    } else if (action === "scroll") {
      const target = el === document.body ? document.scrollingElement || document.body : el;
      target.scrollBy({ top: Number(input.value) || 400 });
    } else throw new Error("Unknown action " + action);
    return { target: el === document.body ? "body" : describe(el) };
  }
  throw new Error("Unknown command " + command);
})`;

export class Nui {
  constructor(private port: number) {}

  list(visibleOnly: boolean) {
    return session(this.port, async (send, contexts) => {
      const pages = await Promise.all([...contexts].map(async ([resource, id]) => {
        const probe = await evaluate(send, id, pageScript + '("probe", {})').catch(() => undefined) as { visible: boolean } | undefined;
        return { resource, visible: probe?.visible ?? false };
      }));
      const shown = pages.filter(page => !visibleOnly || page.visible).sort((a, b) => a.resource.localeCompare(b.resource));
      return { pages: shown, total: pages.length };
    });
  }

  run(resource: string, command: "snapshot" | "act" | "exists", input: Record<string, unknown>) {
    return session(this.port, async (send, contexts) =>
      await evaluate(send, context(contexts, resource), pageScript + "(" + JSON.stringify(command) + "," + JSON.stringify(input) + ")") as Record<string, unknown>);
  }

  evaluate(resource: string, expression: string) {
    return session(this.port, async (send, contexts) => {
      const value = await evaluate(send, context(contexts, resource), expression);
      const text = JSON.stringify(value) ?? "undefined";
      return text.length > 24000 ? { result: text.slice(0, 24000), truncated: true } : { result: value ?? null };
    });
  }
}
