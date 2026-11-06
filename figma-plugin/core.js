// NGA Figma Bridge — plugin main thread core.
// Owns: RPC dispatch (one job at a time), write guard for protected pages, UI round-trips,
// and hot-reload of command handlers (handlers/*.js are bundled into code.js and, when the
// sandbox allows `new Function`, replaced live by the server without reopening the plugin).
const VERSION = '0.1.0';
const PROTOCOL = 1;
const ERROR_CODES = ['INVALID_INPUT', 'UNKNOWN_COMMAND', 'NOT_FOUND', 'PAGE_PROTECTED', 'PLUGIN_OFFLINE', 'TIMEOUT', 'EXEC_UNSUPPORTED', 'FONT_MISSING', 'UI_FAILED', 'INTERNAL'];

figma.showUI(__html__, { visible: true, width: 260, height: 132, title: 'NGA Figma Bridge' });

class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BridgeError(code, message); };

let evalSupported = false;
try { evalSupported = new Function('return 1')() === 1; } catch (e) { evalSupported = false; }

const H = {
  map: {},
  register(name, fn) { this.map[name] = fn; },
  names() { return Object.keys(this.map).sort(); },
};

// ---------- ctx: shared helpers handed to every handler ----------
const ctx = {
  VERSION, BridgeError, fail,
  protectedPages: [], // set by the hub (NGA_PROTECTED)
  job: null,
  progress(done, total, label) {
    if (ctx.job) figma.ui.postMessage({ type: 'progress', id: ctx.job, done, total, label });
  },
  rgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  },
  hexOf(c) {
    const h = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
  },
  pageOf(node) {
    let c = node;
    while (c && c.type !== 'PAGE') c = c.parent;
    return c;
  },
  topOf(node) {
    let c = node;
    while (c && c.parent && c.parent.type !== 'PAGE') c = c.parent;
    return c;
  },
  async page(ref) {
    if (ref == null) return figma.currentPage;
    const p = figma.root.children.find((x) => x.id === ref || x.name === ref);
    if (!p) fail('NOT_FOUND', `page not found: ${ref}`);
    await p.loadAsync();
    return p;
  },
  async node(id) {
    if (typeof id !== 'string' || !id) fail('INVALID_INPUT', 'node id required');
    const n = await figma.getNodeByIdAsync(id);
    if (!n) fail('NOT_FOUND', `node not found: ${id}`);
    const p = ctx.pageOf(n);
    if (p) await p.loadAsync();
    return n;
  },
  assertWritable(nodeOrPage) {
    const p = nodeOrPage.type === 'PAGE' ? nodeOrPage : ctx.pageOf(nodeOrPage);
    if (p && ctx.protectedPages.includes(p.name)) fail('PAGE_PROTECTED', `page "${p.name}" is protected`);
  },
  async writable(id) {
    const n = await ctx.node(id);
    ctx.assertWritable(n);
    return n;
  },
  async loadFonts(textNode) {
    if (!textNode.characters.length) { if (textNode.fontName !== figma.mixed) await figma.loadFontAsync(textNode.fontName); return; }
    for (const f of textNode.getRangeAllFontNames(0, textNode.characters.length)) await figma.loadFontAsync(f);
  },
  // round-trip to the UI iframe (html layout, network fetch)
  ui(kind, payload) {
    return new Promise((resolve, reject) => {
      const rid = 'u' + (++uiSeq);
      uiPending.set(rid, { resolve, reject });
      figma.ui.postMessage({ type: 'uiReq', rid, kind, payload });
    });
  },
  call(cmd, args) { return dispatch(cmd, args || {}); },
};
let uiSeq = 0;
const uiPending = new Map();

// ---------- dispatch ----------
async function dispatch(cmd, args) {
  const fn = H.map[cmd];
  if (!fn) fail('UNKNOWN_COMMAND', `unknown command: ${cmd}`);
  if (args == null || typeof args !== 'object') fail('INVALID_INPUT', 'args must be an object');
  return await fn(args, ctx);
}
const toWireError = (e) => ({
  code: e && ERROR_CODES.includes(e.code) ? e.code : 'INTERNAL',
  message: String((e && e.message) || e).slice(0, 2000),
});

// built-ins that must survive a broken hot reload
H.register('ping', async () => ({ pong: true, version: VERSION, evalSupported, page: figma.currentPage.name, commands: H.names() }));
H.register('batch', async (a) => {
  if (!Array.isArray(a.ops)) fail('INVALID_INPUT', 'ops: array of {cmd,args} required');
  const out = [];
  let i = 0;
  for (const op of a.ops) {
    ctx.progress(++i, a.ops.length, op && op.cmd);
    try { out.push({ ok: true, data: await dispatch(op.cmd, op.args || {}) }); }
    catch (e) { out.push({ ok: false, error: toWireError(e) }); if (a.stopOnError) break; }
  }
  return { results: out, failed: out.filter((r) => !r.ok).length };
});
H.register('exec', async (a) => {
  if (!evalSupported) fail('EXEC_UNSUPPORTED', 'this Figma sandbox does not allow new Function');
  if (typeof a.code !== 'string') fail('INVALID_INPUT', 'code: string required (async function body)');
  const fn = new Function('figma', 'ctx', 'args', `return (async () => {\n${a.code}\n})();`);
  return await fn(figma, ctx, a.args || {});
});

function loadHandlers(files) {
  const loaded = [];
  for (const f of files) {
    // each file registers through H.register(...)
    new Function('H', 'ctx', 'figma', f.src)(H, ctx, figma);
    loaded.push(f.name);
  }
  return loaded;
}

// ---------- job queue: one command at a time ----------
const queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const m = queue.shift();
    ctx.job = m.id;
    let result;
    try { result = { ok: true, data: await dispatch(m.cmd, m.args || {}) }; }
    catch (e) { result = { ok: false, error: toWireError(e) }; }
    ctx.job = null;
    figma.ui.postMessage({ type: 'result', id: m.id, result });
  }
  running = false;
}

figma.ui.onmessage = (m) => {
  if (!m || !m.type) return;
  if (m.type === 'rpc') { queue.push(m); pump(); return; }
  if (m.type === 'config') { if (Array.isArray(m.protectedPages)) ctx.protectedPages = m.protectedPages; return; }
  if (m.type === 'handlers') {
    if (!evalSupported) { figma.ui.postMessage({ type: 'handlersLoaded', names: H.names(), error: 'eval unsupported; using bundled handlers' }); return; }
    try { loadHandlers(m.files || []); figma.ui.postMessage({ type: 'handlersLoaded', names: H.names() }); }
    catch (e) { figma.ui.postMessage({ type: 'handlersLoaded', names: H.names(), error: String(e && e.message || e) }); }
    return;
  }
  if (m.type === 'uiRes') {
    const p = uiPending.get(m.rid);
    if (!p) return;
    uiPending.delete(m.rid);
    if (m.ok) p.resolve(m.data); else p.reject(new BridgeError('UI_FAILED', m.error || 'ui task failed'));
    return;
  }
  if (m.type === 'uiReady') {
    figma.ui.postMessage({ type: 'hello', version: VERSION, protocol: PROTOCOL, evalSupported, page: figma.currentPage.name, errorCodes: ERROR_CODES });
  }
};
