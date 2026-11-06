// NGA Figma Bridge CLI — runs on the MacBook, talks to the server on the Figma machine over ssh.
// usage:
//   bun cli/fb.ts status
//   bun cli/fb.ts <cmd> ['{"json":"args"}'] [--timeout 120000] [--out file.png] [--host <ssh host>]
//   bun cli/fb.ts tokens.apply '{"ids":[...]}' --preset example       (loads presets/example.json, or a .json path, into args.preset)
//   bun cli/fb.ts put <local file> <path under server root>           (scp helper)
//   bun cli/fb.ts reload                                              (push handlers to the plugin now)
// env: NGA_HOST (ssh host running Figma + hub; required unless --host), NGA_PORT (default 7777)
// exit codes: 0 ok · 2 invalid input / unknown command · 3 offline / timeout · 4 page protected · 5 not found · 1 other
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODE, isErrorCode, type WireResult } from "../mcp/src/protocol";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const host = flag("host") ?? process.env.NGA_HOST ?? "";
const port = process.env.NGA_PORT ?? "7777";
const timeoutMs = Number(flag("timeout") ?? 120000);
const out = flag("out");
const preset = flag("preset");
const [cmd, rawArgs] = argv;

function ssh(remote: string, stdin?: string) {
  const p = Bun.spawnSync(["ssh", host, remote], { stdin: stdin ? new TextEncoder().encode(stdin) : undefined, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function die(msg: string, code = 1): never { console.error(msg); process.exit(code); }

if (!host) die("set NGA_HOST or pass --host <ssh host running Figma>", 2);
if (!cmd) die("usage: bun cli/fb.ts <status|reload|put|cmd> [json-args]", 2);

if (cmd === "status") {
  const r = ssh(`curl -s -m 10 http://127.0.0.1:${port}/status`);
  if (!r.out) die(`server not reachable on ${host}:${port} (${r.err.trim() || "no output"})`, 3);
  console.log(r.out);
  process.exit(0);
}
if (cmd === "reload") {
  console.log(ssh(`curl -s -m 10 -X POST http://127.0.0.1:${port}/reload`).out);
  process.exit(0);
}
if (cmd === "put") {
  const [, local, remote] = argv;
  if (!local || !remote) die("usage: put <local> <remote path under server root>", 2);
  const st = ssh(`curl -s -m 10 http://127.0.0.1:${port}/status`);
  const root = JSON.parse(st.out || "{}").server?.root;
  if (!root) die("server not reachable", 3);
  const p = Bun.spawnSync(["scp", "-q", local, `${host}:${root}/${remote}`]);
  process.exit(p.exitCode ?? 1);
}

let args: Record<string, unknown> = {};
if (rawArgs) { try { args = JSON.parse(rawArgs); } catch { die(`args must be JSON: ${rawArgs}`, 2); } }
if (preset) args.preset = JSON.parse(readFileSync(preset.endsWith(".json") ? preset : join(import.meta.dir, "..", "presets", `${preset}.json`), "utf8"));

const body = JSON.stringify({ v: 1, cmd, args, timeoutMs });
const r = ssh(`curl -s -m ${Math.ceil(timeoutMs / 1000) + 10} -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:${port}/rpc`, body);
if (!r.out) die(`server not reachable on ${host}:${port} (${r.err.trim() || "no output"})`, 3);
let res: WireResult<any>;
try { res = JSON.parse(r.out); } catch { die(`bad reply: ${r.out.slice(0, 300)}`); }
if (!res.ok) {
  console.error(JSON.stringify(res.error));
  process.exit(isErrorCode(res.error.code) ? EXIT_CODE[res.error.code] : 1);
}
if (out && res.data?.base64) {
  writeFileSync(out, Buffer.from(res.data.base64, "base64"));
  delete res.data.base64;
  res.data.file = out;
}
console.log(JSON.stringify(res.data));
