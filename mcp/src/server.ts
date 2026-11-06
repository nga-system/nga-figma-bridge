// NGA Figma Bridge — MCP stdio server (Claude Code launches it from .mcp.json; no manual server needed).
//   node mcp/server.js          MCP over stdio + hub on 127.0.0.1:7777 (relays if another session owns the port)
//   node mcp/server.js serve    hub only (headless machine running Figma, reached through NGA_HUB / ssh -L)
// env: NGA_PORT (7777) · NGA_PROTECTED (comma list of read-only page names, default none) · NGA_ROOT (static /files root) · NGA_HUB (remote hub URL)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, fileForHtml } from "./hub";
import type { WireResult } from "./protocol";

const VERSION = "0.2.0";
const HERE = dirname(fileURLToPath(import.meta.url));
// bundled: <root>/mcp/server.js · source: <root>/mcp/src/server.ts
const ROOT = [resolve(HERE, ".."), resolve(HERE, "../..")].find((d) => existsSync(join(d, "handlers"))) ?? resolve(HERE, "..");
const log = (m: string) => process.stderr.write(`[nga-figma-bridge] ${m}\n`);

const bridgeP = startBridge({
  port: Number(process.env.NGA_PORT ?? 7777),
  handlersDir: join(ROOT, "handlers"),
  root: process.env.NGA_ROOT,
  protectedPages: (process.env.NGA_PROTECTED ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  remote: process.env.NGA_HUB,
  log,
});

if (process.argv[2] === "serve") {
  await bridgeP;
  log(`serving (handlers: ${join(ROOT, "handlers")})`);
} else {
  const bridge = (await bridgeP).get;
  const server = new McpServer({ name: "nga-figma-bridge", version: VERSION });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  const reply = (r: WireResult) => (r.ok ? text(r.data) : { ...text({ error: r.error }), isError: true });
  const run = async (cmd: string, args: Record<string, unknown>, timeoutMs?: number) => reply(await bridge().call(cmd, args, timeoutMs));
  const loadPreset = (p: string) => {
    const file = isAbsolute(p) || p.endsWith(".json") ? resolve(p) : join(ROOT, "presets", `${p}.json`);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const timeout = z.number().int().positive().optional().describe("ms to wait for Figma (default 120000)");
  const any = z.record(z.string(), z.unknown());

  server.registerTool("figma_status", { description: "Hub and Figma plugin connection state, plugin version, loaded handlers, running jobs with progress. Call first; if connected=false ask the user to open Plugins → NGA Figma Bridge in Figma and press 연결." }, async () => text(await bridge().status()));

  server.registerTool("figma_command", {
    description: "Run any NGA Figma Bridge command. Read: ping pages page.set nodes find spec select selection screenshot audit · Edit: resize move rename delete clone reparent radius fill stroke text autolayout frame · Components: component.create instance.create instance.swapIn · Variables: vars.list vars.ensure vars.bind vars.mode tokens.values tokens.apply fit.textBoxes · Render: html · Control: batch exec. Writes to protected pages fail with PAGE_PROTECTED.",
    inputSchema: { cmd: z.string(), args: any.optional(), timeoutMs: timeout },
  }, async ({ cmd, args, timeoutMs }) => run(cmd, args ?? {}, timeoutMs));

  server.registerTool("figma_pages", { description: "List pages with ids and top-level frame counts." }, async () => run("pages", {}));

  server.registerTool("figma_find", {
    description: "Find nodes by name/type on a page. args: page (name or id), name (substring), type, deep (default true), limit.",
    inputSchema: { page: z.string().optional(), name: z.string().optional(), type: z.string().optional(), deep: z.boolean().optional(), limit: z.number().int().optional() },
  }, async (a) => run("find", a));

  server.registerTool("figma_spec", {
    description: "Node tree with geometry, fills, text, auto-layout and bound variables.",
    inputSchema: { id: z.string(), depth: z.number().int().optional() },
  }, async (a) => run("spec", a));

  server.registerTool("figma_screenshot", {
    description: "Export a node as an image and return it. Optional out saves the file locally too.",
    inputSchema: { id: z.string(), scale: z.number().positive().optional(), maxSide: z.number().int().optional(), format: z.enum(["PNG", "JPG"]).optional(), out: z.string().optional(), timeoutMs: timeout },
  }, async ({ out, timeoutMs, ...a }) => {
    const r = await bridge().call("screenshot", a, timeoutMs);
    if (!r.ok) return reply(r);
    const d = r.data as { base64: string; format: string; [k: string]: unknown };
    if (out) writeFileSync(resolve(out), Buffer.from(d.base64, "base64"));
    const { base64, ...meta } = d;
    return { content: [{ type: "image" as const, data: base64, mimeType: d.format === "JPG" ? "image/jpeg" : "image/png" }, { type: "text" as const, text: JSON.stringify({ ...meta, file: out ? resolve(out) : undefined }) }] };
  });

  server.registerTool("figma_html", {
    description: "Render HTML into Figma nodes (frames/text/images/svg; flex → auto-layout). Source: file (local .html path; its folder is served so relative CSS/images work), url (http/https), or html (string). Place with page/x/y/parent, or replace an existing frame with replaceId.",
    inputSchema: {
      file: z.string().optional(), url: z.string().optional(), html: z.string().optional(), width: z.number().int().positive().optional(),
      page: z.string().optional(), x: z.number().optional(), y: z.number().optional(), parent: z.string().optional(), name: z.string().optional(), replaceId: z.string().optional(),
      layoutTimeoutMs: z.number().int().optional(), timeoutMs: timeout,
    },
  }, async ({ file, timeoutMs, ...a }) => {
    const args: Record<string, unknown> = { ...a };
    if (file) {
      const { dir, name } = fileForHtml(file);
      if (!existsSync(join(dir, name))) return { ...text({ error: { code: "INVALID_INPUT", message: `file not found: ${file}` } }), isError: true };
      const b = bridge();
      if (b.remote) args.html = readFileSync(join(dir, name), "utf8"); // remote hub cannot read local files; relative assets won't resolve
      else args.url = `${await b.mount(dir)}${encodeURIComponent(name)}`;
    }
    return run("html", args, timeoutMs ?? 600_000);
  });

  server.registerTool("figma_audit", {
    description: "Audit a page or nodes: fonts in use, raw (unbound) colors with samples, text overflow.",
    inputSchema: { page: z.string().optional(), ids: z.array(z.string()).optional(), timeoutMs: timeout },
  }, async ({ timeoutMs, ...a }) => run("audit", a, timeoutMs ?? 600_000));

  server.registerTool("figma_tokens_apply", {
    description: "Create variables from a token preset and bind them (modes, fonts, colors, radius, spacing, type). preset: bundled name (e.g. example) or a JSON file path.",
    inputSchema: { preset: z.string(), ids: z.array(z.string()).optional(), page: z.string().optional(), steps: z.array(z.enum(["modes", "fonts", "bind"])).optional(), timeoutMs: timeout },
  }, async ({ preset, timeoutMs, ...a }) => {
    try { return await run("tokens.apply", { ...a, preset: loadPreset(preset) }, timeoutMs ?? 600_000); }
    catch (e) { return { ...text({ error: { code: "INVALID_INPUT", message: `preset ${preset}: ${String(e)}` } }), isError: true }; }
  });

  server.registerTool("figma_exec", {
    description: "Escape hatch: run JS in the plugin sandbox (async body; `figma`, `ctx` in scope; return a JSON value). Bypasses the page guard — never write to protected pages with it.",
    inputSchema: { code: z.string(), timeoutMs: timeout },
  }, async ({ code, timeoutMs }) => run("exec", { code }, timeoutMs));

  server.registerTool("figma_reload_handlers", { description: "Push handlers/*.js to the plugin now (also happens automatically on file change)." }, async () => { await bridge().reload(); return text(await bridge().status()); });

  await server.connect(new StdioServerTransport());
  log(`mcp ready (${bridge().mode})`);
}
