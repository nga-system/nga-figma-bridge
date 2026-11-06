// Hub: owns 127.0.0.1:PORT, holds the WebSocket to the Figma plugin, relays RPC, serves files for `html`.
// Node APIs only (runs under node via Claude Code, or under bun in standalone `serve` mode).
// If the port is already owned by another NGA hub (another Claude session), we become a relay client.
import http from "node:http";
import { readdirSync, readFileSync, existsSync, statSync, createReadStream, watch } from "node:fs";
import { join, normalize, extname, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { HTTP_STATUS, PROTOCOL_VERSION, ERROR_CODES, isErrorCode, type ErrorCode, type FromPlugin, type ToPlugin, type WireResult } from "./protocol";

export const HUB_NAME = "nga-figma-bridge";
export type HubOptions = { port: number; handlersDir: string; root?: string; protectedPages: string[]; remote?: string; log?: (m: string) => void };
export interface Bridge {
  readonly mode: "owner" | "relay";
  readonly remote?: boolean; // hub lives on another machine: local files cannot be mounted
  call(cmd: string, args: Record<string, unknown>, timeoutMs?: number): Promise<WireResult>;
  status(): Promise<unknown>;
  mount(dir: string): Promise<string>; // returns url prefix under /files/
  reload(): Promise<void>;
}
const fail = (code: ErrorCode, message: string): WireResult => ({ ok: false, error: { code, message } });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json" };

type Job = { id: string; cmd: string; startedAt: number; progress?: { done: number; total: number; label?: string }; resolve: (r: WireResult) => void; timer: NodeJS.Timeout };

class OwnerHub implements Bridge {
  readonly mode = "owner" as const;
  private plugin: WebSocket | null = null;
  private info: Extract<FromPlugin, { type: "hello" }> | null = null;
  private handlersState: { names: string[]; error?: string; at?: string } = { names: [] };
  private jobs = new Map<string, Job>();
  private mounts = new Map<string, string>();
  private seq = 0;
  constructor(private o: HubOptions, private server: http.Server) {}

  attach() {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    this.server.on("upgrade", (req, sock, head) => {
      if (!req.url?.startsWith("/plugin")) return sock.destroy();
      wss.handleUpgrade(req, sock, head, (ws) => this.onPlugin(ws));
    });
    this.server.on("request", (req, res) => this.onHttp(req, res).catch((e) => { res.writeHead(500, CORS); res.end(String(e)); }));
    let t: NodeJS.Timeout | null = null;
    try { watch(this.o.handlersDir, () => { if (t) clearTimeout(t); t = setTimeout(() => this.pushHandlers(), 200); }); } catch {}
  }

  private send(m: ToPlugin) { if (this.plugin?.readyState === 1) this.plugin.send(JSON.stringify(m)); }
  private handlerFiles() {
    return readdirSync(this.o.handlersDir).filter((f) => f.endsWith(".js")).sort().map((name) => ({ name, src: readFileSync(join(this.o.handlersDir, name), "utf8") }));
  }
  private pushHandlers() { if (this.info?.evalSupported) this.send({ type: "handlers", files: this.handlerFiles() }); }

  private onPlugin(ws: WebSocket) {
    if (this.plugin && this.plugin !== ws) this.plugin.close(4000, "replaced by a newer plugin connection");
    this.plugin = ws;
    this.send({ type: "config", protectedPages: this.o.protectedPages });
    ws.on("message", (raw) => {
      let m: FromPlugin;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "hello") {
        this.info = m;
        const drift = ERROR_CODES.filter((c) => !m.errorCodes.includes(c));
        if (drift.length) this.o.log?.(`error code drift between hub and plugin: ${drift.join(",")}`);
        this.send({ type: "config", protectedPages: this.o.protectedPages });
        this.pushHandlers();
      } else if (m.type === "result") {
        const j = this.jobs.get(m.id);
        if (!j) return;
        clearTimeout(j.timer); this.jobs.delete(m.id);
        const r = m.result;
        j.resolve(r.ok || isErrorCode(r.error?.code) ? r : fail("INTERNAL", JSON.stringify(r).slice(0, 500)));
      } else if (m.type === "progress") {
        const j = this.jobs.get(m.id);
        if (j) j.progress = { done: m.done, total: m.total, label: m.label };
      } else if (m.type === "handlersLoaded") {
        this.handlersState = { names: m.names, error: m.error, at: new Date().toISOString() };
      }
    });
    ws.on("close", () => {
      if (this.plugin !== ws) return;
      this.plugin = null; this.info = null;
      for (const j of this.jobs.values()) { clearTimeout(j.timer); j.resolve(fail("PLUGIN_OFFLINE", `plugin disconnected during ${j.cmd}`)); }
      this.jobs.clear();
    });
  }

  call(cmd: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<WireResult> {
    if (!cmd) return Promise.resolve(fail("INVALID_INPUT", "cmd required"));
    if (!this.plugin) return Promise.resolve(fail("PLUGIN_OFFLINE", "NGA Figma Bridge plugin is not connected — open it in Figma (Plugins → NGA Figma Bridge) and press 연결"));
    const id = `j${++this.seq}`;
    return new Promise((resolveP) => {
      const timer = setTimeout(() => { this.jobs.delete(id); resolveP(fail("TIMEOUT", `no reply in ${timeoutMs}ms; job ${id} may still be running in Figma`)); }, timeoutMs);
      this.jobs.set(id, { id, cmd, startedAt: Date.now(), resolve: resolveP, timer });
      this.send({ type: "rpc", id, cmd, args });
    });
  }
  async status() {
    return {
      server: { name: HUB_NAME, mode: this.mode, port: this.o.port, root: this.o.root ?? null, protectedPages: this.o.protectedPages, protocol: PROTOCOL_VERSION, mounts: this.mounts.size },
      connected: !!this.plugin, plugin: this.info, handlers: this.handlersState,
      jobs: [...this.jobs.values()].map((j) => ({ id: j.id, cmd: j.cmd, seconds: Math.round((Date.now() - j.startedAt) / 1000), progress: j.progress })),
    };
  }
  async mount(dir: string) {
    const abs = resolve(dir);
    const id = createHash("sha1").update(abs).digest("hex").slice(0, 12);
    this.mounts.set(id, abs);
    return `m/${id}/`;
  }
  async reload() { this.pushHandlers(); }

  private json(res: http.ServerResponse, body: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json", ...CORS }); res.end(JSON.stringify(body)); }
  private async body(req: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks).toString("utf8"); }
  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === "/rpc" && req.method === "POST") {
      let b: any; try { b = JSON.parse(await this.body(req)); } catch { return this.json(res, fail("INVALID_INPUT", "body must be JSON"), 400); }
      if (b?.v != null && b.v !== PROTOCOL_VERSION) return this.json(res, fail("INVALID_INPUT", `protocol v${b.v} unsupported`), 400);
      const r = await this.call(String(b?.cmd ?? ""), b?.args ?? {}, b?.timeoutMs);
      return this.json(res, r, r.ok ? 200 : HTTP_STATUS[r.error.code]);
    }
    if (url.pathname === "/status") return this.json(res, await this.status());
    if (url.pathname === "/reload" && req.method === "POST") { await this.reload(); return this.json(res, { ok: true, data: {} }); }
    if (url.pathname === "/mount" && req.method === "POST") {
      const b = JSON.parse(await this.body(req));
      return this.json(res, { ok: true, data: { prefix: await this.mount(String(b.dir)) } });
    }
    if (url.pathname.startsWith("/files/")) return this.serveFile(decodeURIComponent(url.pathname.slice(7)), res);
    res.writeHead(200, CORS); res.end(HUB_NAME);
  }
  private serveFile(rel: string, res: http.ServerResponse) {
    let base: string | undefined, sub = rel;
    const m = /^m\/([0-9a-f]{12})\/(.*)$/.exec(rel);
    if (m) { base = this.mounts.get(m[1]); sub = m[2]; } else base = this.o.root;
    if (!base) { res.writeHead(404, CORS); return res.end("no root"); }
    const p = normalize(join(base, sub));
    if (!p.startsWith(normalize(base))) { res.writeHead(403, CORS); return res.end("forbidden"); }
    if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404, CORS); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[extname(p).toLowerCase()] ?? "application/octet-stream", ...CORS });
    createReadStream(p).pipe(res);
  }
}

// Relay: another Claude session already owns the port — forward everything over HTTP.
class RelayHub implements Bridge {
  readonly mode = "relay" as const;
  constructor(private base: string, readonly remote = false) {}
  private async post(path: string, body: unknown) {
    const r = await fetch(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json() as Promise<any>;
  }
  async call(cmd: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<WireResult> {
    try { return await this.post("/rpc", { v: PROTOCOL_VERSION, cmd, args, timeoutMs }); }
    catch (e) { return fail("PLUGIN_OFFLINE", `hub ${this.base} unreachable (${String(e)})`); }
  }
  async status() {
    try { const r = await fetch(`${this.base}/status`, { signal: AbortSignal.timeout(5000) }); const s: any = await r.json(); return { ...s, via: this.remote ? `remote ${this.base}` : "relay" }; }
    catch (e) { return { connected: false, error: `hub ${this.base} unreachable (${String(e)})` }; }
  }
  async mount(dir: string) { return (await this.post("/mount", { dir: resolve(dir) })).data.prefix as string; }
  async reload() { await this.post("/reload", {}); }
}

async function isOurHub(port: number) {
  try { const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) }); const s: any = await r.json(); return s?.server?.name === HUB_NAME; } catch { return false; }
}

// Start as owner; if the port is taken by our hub, relay. Re-checks so a relay can take over when the owner exits.
export async function startBridge(o: HubOptions): Promise<{ get: () => Bridge }> {
  if (o.remote) { o.log?.(`hub remote → ${o.remote}`); const r = new RelayHub(o.remote.replace(/\/$/, ""), true); return { get: () => r }; }
  let current: Bridge = new RelayHub(`http://127.0.0.1:${o.port}`);
  const tryOwn = () => new Promise<boolean>((res) => {
    const server = http.createServer();
    server.once("error", () => res(false));
    server.listen(o.port, "127.0.0.1", () => { const hub = new OwnerHub(o, server); hub.attach(); current = hub; o.log?.(`hub owner on 127.0.0.1:${o.port}`); res(true); });
  });
  if (!(await tryOwn())) {
    if (!(await isOurHub(o.port))) o.log?.(`port ${o.port} is used by another program; set NGA_PORT`);
    else o.log?.(`hub relay → 127.0.0.1:${o.port}`);
    const timer = setInterval(async () => { if (current.mode === "relay" && !(await isOurHub(o.port)) && (await tryOwn())) clearInterval(timer); }, 3000);
    timer.unref();
  }
  return { get: () => current };
}

export const fileForHtml = (file: string) => ({ dir: dirname(resolve(file)), name: basename(file) });
