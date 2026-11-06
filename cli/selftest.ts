// End-to-end self test against the live plugin. Leaves no nodes behind (test frame is deleted).
// usage: bun cli/selftest.ts --host <ssh host> [--page <page name>] [--url <path under NGA_ROOT>]
// Without --page the test frame goes to the current page; without --url a built-in HTML sample is rendered.
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const host = flag("host", process.env.NGA_HOST);
if (!host) { console.error("set NGA_HOST or pass --host <ssh host running Figma>"); process.exit(2); }
const page = flag("page");
const url = flag("url");
const SAMPLE = `<!doctype html><html><body style="margin:0;font-family:Inter,sans-serif"><main style="display:flex;flex-direction:column;gap:24px;padding:64px;background:#F5F7FB"><h1 style="margin:0;font-size:56px;color:#14161C">NGA Figma Bridge</h1><p style="margin:0;font-size:18px;color:#3D4250">Self test render: flex column → auto-layout, text, fills.</p><div style="display:flex;gap:16px"><span style="padding:12px 20px;border-radius:12px;background:#2F5BEA;color:#fff">Primary</span><span style="padding:12px 20px;border-radius:12px;border:1px solid #E2E6EF;color:#14161C">Secondary</span></div></main></body></html>`;
const FB = `${import.meta.dir}/fb.ts`;

function fb(cmd: string, args: unknown = {}, timeout = 120000) {
  const p = Bun.spawnSync(["bun", FB, cmd, JSON.stringify(args), "--host", host, "--timeout", String(timeout)], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  return { code: p.exitCode, data: out ? JSON.parse(out) : null, err: p.stderr.toString().trim() };
}
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown) => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}`); if (!ok) failed++; };

const ping = fb("ping");
check("ping", ping.code === 0 && ping.data?.pong, ping.data ?? ping.err);
check("eval (live reload + exec)", ping.data?.evalSupported === true, `evalSupported=${ping.data?.evalSupported}`);

const pages = fb("pages");
check("pages", pages.code === 0 && pages.data.length > 0, pages.data?.map((p: any) => `${p.name}${p.protected ? "(protected)" : ""}`).join(" | "));
const prot = pages.data?.find((p: any) => p.protected);

if (prot) {
  const kids = fb("nodes", { page: prot.id });
  check("read protected page (other page)", kids.code === 0 && kids.data.nodes.length > 0, `${kids.data?.nodes.length} top nodes`);
  const target = kids.data?.nodes[0];
  if (target) {
    const w = fb("rename", { id: target.id, name: target.name + " x" });
    check("write guard blocks protected page", w.code === 4 && /PAGE_PROTECTED/.test(w.err), w.err || w.data);
  }
}

const ex = fb("exec", { code: "return 1 + 1" });
check("exec", ex.code === 0 && ex.data === 2, ex.data ?? ex.err);

const t0 = Date.now();
const made = fb("html", { ...(url ? { url } : { html: SAMPLE }), width: 1440, ...(page ? { page } : {}), x: -20000, y: -20000, name: "nga-selftest" }, 600000);
check("html render", made.code === 0 && made.data?.id, made.data ?? made.err);
if (made.data?.id) {
  console.log(`     html: ${made.data.nodes} nodes · ${made.data.width}x${Math.round(made.data.height)} · ${((Date.now() - t0) / 1000).toFixed(1)}s · missingFonts=${JSON.stringify(made.data.missingFonts)} · warnings=${made.data.warnings.length}`);
  const shot = fb("screenshot", { id: made.data.id, scale: 0.5 });
  check("screenshot", shot.code === 0 && shot.data?.base64?.length > 1000, `${shot.data?.base64?.length ?? 0} b64 chars`);
  if (shot.data?.base64) await Bun.write(`${process.env.TMPDIR ?? "/tmp"}/nga-selftest.png`, Buffer.from(shot.data.base64, "base64"));
  const au = fb("audit", { ids: [made.data.id] });
  check("audit", au.code === 0, { texts: au.data?.texts, fonts: au.data?.rows?.[0]?.fonts, overflow: au.data?.textOverflow });
  const del = fb("delete", { id: made.data.id });
  check("cleanup", del.code === 0, del.data ?? del.err);
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
