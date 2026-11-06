// Mutating commands. Every write goes through ctx.writable / ctx.assertWritable (page guard).

H.register('resize', async (a) => {
  const n = await ctx.writable(a.id);
  if (!('resize' in n)) ctx.fail('INVALID_INPUT', `${n.type} cannot be resized`);
  n.resize(a.width != null ? a.width : n.width, a.height != null ? a.height : n.height);
  return { id: n.id, width: n.width, height: n.height };
});

H.register('move', async (a) => {
  const n = await ctx.writable(a.id);
  if (a.x != null) n.x = a.x;
  if (a.y != null) n.y = a.y;
  return { id: n.id, x: n.x, y: n.y };
});

H.register('rename', async (a) => {
  const n = await ctx.writable(a.id);
  n.name = String(a.name);
  return { id: n.id, name: n.name };
});

H.register('delete', async (a) => {
  const ids = [].concat(a.ids || a.id || []);
  const out = [];
  for (const id of ids) { const n = await ctx.writable(id); out.push(n.id); n.remove(); }
  return { deleted: out };
});

H.register('clone', async (a) => {
  const n = await ctx.writable(a.id);
  const c = n.clone();
  if (a.parent) { const p = await ctx.writable(a.parent); p.appendChild(c); }
  if (a.x != null) c.x = a.x;
  if (a.y != null) c.y = a.y;
  if (a.name) c.name = a.name;
  return { id: c.id, name: c.name };
});

H.register('reparent', async (a) => {
  const n = await ctx.writable(a.id);
  const p = await ctx.writable(a.parent);
  if (a.index != null) p.insertChild(a.index, n); else p.appendChild(n);
  return { id: n.id, parent: p.id };
});

// radius: number (all) or [tl, tr, br, bl]
H.register('radius', async (a) => {
  const n = await ctx.writable(a.id);
  const r = a.radius;
  if (Array.isArray(r)) { [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] = r; }
  else n.cornerRadius = r;
  return { id: n.id, radius: [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] };
});

async function variableRef(ref) {
  if (!ref) return null;
  const byId = await figma.variables.getVariableByIdAsync(ref).catch(() => null);
  if (byId) return byId;
  const all = await figma.variables.getLocalVariablesAsync();
  const v = all.find((x) => x.name === ref);
  if (!v) ctx.fail('NOT_FOUND', `variable not found: ${ref}`);
  return v;
}
ctx.variableRef = variableRef;

function solid(hex, opacity) { return { type: 'SOLID', color: ctx.rgb(hex), opacity: opacity == null ? 1 : opacity }; }

// fill / stroke: { hex, opacity } or { variable } (name or id); "none" clears
for (const key of ['fills', 'strokes']) {
  H.register(key === 'fills' ? 'fill' : 'stroke', async (a) => {
    const n = await ctx.writable(a.id);
    if (a.none) { n[key] = []; return { id: n.id, [key]: [] }; }
    let paint = solid(a.hex || '#000000', a.opacity);
    if (a.variable) {
      const v = await variableRef(a.variable);
      paint = figma.variables.setBoundVariableForPaint(paint, 'color', v);
    }
    n[key] = [paint];
    if (key === 'strokes' && a.weight != null) n.strokeWeight = a.weight;
    return { id: n.id, ok: true };
  });
}

// pick the closest installed style of a family for a CSS weight
let fontCache = null;
async function fonts() {
  if (!fontCache) fontCache = await figma.listAvailableFontsAsync();
  return fontCache;
}
const WEIGHT = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
ctx.resolveFont = async (family, weight, italic) => {
  const all = await fonts();
  const fam = all.filter((f) => f.fontName.family === family);
  if (!fam.length) return null;
  const w = weight || 400;
  let best = null, bestD = 1e9;
  for (const f of fam) {
    const st = f.fontName.style.toLowerCase().replace(/[\s-]/g, '');
    const isItalic = st.includes('italic');
    const sw = WEIGHT[st.replace('italic', '')] || (st === '' || st === 'italic' ? 400 : 400);
    const d = Math.abs(sw - w) + (isItalic !== !!italic ? 1000 : 0);
    if (d < bestD) { bestD = d; best = f.fontName; }
  }
  return best;
};

// text: chars, fontSize, fontFamily(+fontWeight|fontStyle), lineHeight(px number | "120%" | "auto"),
// letterSpacing(px), align, autoResize, hex
H.register('text', async (a) => {
  const n = await ctx.writable(a.id);
  if (n.type !== 'TEXT') ctx.fail('INVALID_INPUT', 'not a TEXT node');
  await ctx.loadFonts(n);
  const len = () => n.characters.length;
  if (a.fontFamily) {
    const to = a.fontStyle ? { family: a.fontFamily, style: a.fontStyle } : await ctx.resolveFont(a.fontFamily, a.fontWeight);
    if (!to) ctx.fail('FONT_MISSING', `font not installed: ${a.fontFamily}`);
    await figma.loadFontAsync(to);
    if (len()) n.setRangeFontName(0, len(), to); else n.fontName = to;
  } else if (a.fontStyle) {
    const fam = n.fontName === figma.mixed ? n.getRangeFontName(0, 1).family : n.fontName.family;
    const to = { family: fam, style: a.fontStyle };
    await figma.loadFontAsync(to);
    n.setRangeFontName(0, len(), to);
  }
  if (a.chars != null) n.characters = String(a.chars);
  if (a.fontSize != null) n.fontSize = a.fontSize;
  if (a.lineHeight != null) {
    const lh = a.lineHeight;
    n.lineHeight = lh === 'auto' ? { unit: 'AUTO' } : typeof lh === 'string' && lh.endsWith('%') ? { unit: 'PERCENT', value: parseFloat(lh) } : { unit: 'PIXELS', value: Number(lh) };
  }
  if (a.letterSpacing != null) n.letterSpacing = { unit: 'PIXELS', value: a.letterSpacing };
  if (a.align) n.textAlignHorizontal = a.align;
  if (a.autoResize) n.textAutoResize = a.autoResize;
  if (a.hex) n.fills = [solid(a.hex, a.opacity)];
  return { id: n.id, width: n.width, height: n.height };
});

// auto layout: mode HORIZONTAL|VERTICAL|NONE, gap, padding [t,r,b,l]|number, primary, counter, sizing
H.register('autolayout', async (a) => {
  const n = await ctx.writable(a.id);
  if (!('layoutMode' in n)) ctx.fail('INVALID_INPUT', `${n.type} has no layout`);
  if (a.mode) n.layoutMode = a.mode;
  if (a.gap != null) n.itemSpacing = a.gap;
  if (a.padding != null) {
    const p = Array.isArray(a.padding) ? a.padding : [a.padding, a.padding, a.padding, a.padding];
    [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft] = p;
  }
  if (a.primary) n.primaryAxisAlignItems = a.primary;
  if (a.counter) n.counterAxisAlignItems = a.counter;
  if (a.primarySizing) n.primaryAxisSizingMode = a.primarySizing;
  if (a.counterSizing) n.counterAxisSizingMode = a.counterSizing;
  if (a.wrap) n.layoutWrap = a.wrap;
  if (a.clips != null) n.clipsContent = !!a.clips;
  return { id: n.id, mode: n.layoutMode };
});

H.register('frame', async (a) => {
  const parent = a.parent ? await ctx.writable(a.parent) : await ctx.page(a.page);
  ctx.assertWritable(parent);
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = a.name || 'Frame';
  f.resize(a.width || 100, a.height || 100);
  f.x = a.x || 0; f.y = a.y || 0;
  f.fills = a.hex ? [solid(a.hex)] : [];
  return { id: f.id };
});

H.register('component.create', async (a) => {
  const n = await ctx.writable(a.id);
  const c = n.type === 'COMPONENT' ? n : figma.createComponentFromNode(n);
  if (a.name) c.name = a.name;
  return { id: c.id, key: c.key, name: c.name };
});

H.register('instance.create', async (a) => {
  const comp = await ctx.node(a.componentId);
  if (comp.type !== 'COMPONENT') ctx.fail('INVALID_INPUT', 'componentId is not a COMPONENT');
  const inst = comp.createInstance();
  if (a.parent) { const p = await ctx.writable(a.parent); if (a.index != null) p.insertChild(a.index, inst); else p.appendChild(inst); }
  else { const p = await ctx.page(a.page); ctx.assertWritable(p); p.appendChild(inst); }
  if (a.x != null) inst.x = a.x;
  if (a.y != null) inst.y = a.y;
  return { id: inst.id, name: inst.name };
});

// replace a node with an instance of a component, keeping position/size/parent index
H.register('instance.swapIn', async (a) => {
  const target = await ctx.writable(a.id);
  const comp = await ctx.node(a.componentId);
  if (comp.type !== 'COMPONENT') ctx.fail('INVALID_INPUT', 'componentId is not a COMPONENT');
  const parent = target.parent;
  const idx = parent.children.indexOf(target);
  const inst = comp.createInstance();
  parent.insertChild(idx, inst);
  if (!('layoutMode' in parent) || parent.layoutMode === 'NONE' || target.layoutPositioning === 'ABSOLUTE') { inst.x = target.x; inst.y = target.y; }
  if (a.keepSize !== false) inst.resize(target.width, target.height);
  target.remove();
  return { id: inst.id };
});
