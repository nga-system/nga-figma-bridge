// Read-only commands: pages, nodes, find, spec, select, screenshot, audit.
// Runs inside the plugin (H, ctx, figma in scope). Hot-reloadable.

const box = (n) => ({ id: n.id, name: n.name, type: n.type, x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100, width: Math.round(n.width * 100) / 100, height: Math.round(n.height * 100) / 100 });

H.register('pages', async () => figma.root.children.map((p) => ({ id: p.id, name: p.name, current: p === figma.currentPage, protected: ctx.protectedPages.includes(p.name) })));

H.register('page.set', async (a) => {
  const p = await ctx.page(a.page);
  await figma.setCurrentPageAsync(p);
  return { id: p.id, name: p.name };
});

// children of a page (default current) or of a node
H.register('nodes', async (a) => {
  const parent = a.parent ? await ctx.node(a.parent) : await ctx.page(a.page);
  if (!('children' in parent)) ctx.fail('INVALID_INPUT', 'parent has no children');
  return { parent: { id: parent.id, name: parent.name }, nodes: parent.children.map(box) };
});

// find by name regex / type under a page or node; limit default 500
H.register('find', async (a) => {
  const root = a.parent ? await ctx.node(a.parent) : await ctx.page(a.page);
  const re = a.name ? new RegExp(a.name, a.flags || '') : null;
  const types = a.type ? [].concat(a.type) : null;
  const limit = a.limit || 500;
  const out = [];
  const hit = (n) => (!re || re.test(n.name)) && (!types || types.includes(n.type)) && (!a.text || (n.type === 'TEXT' && n.characters.includes(a.text)));
  const kids = a.deep === false ? root.children : root.findAll(hit);
  for (const n of kids) { if (a.deep === false && !hit(n)) continue; out.push(box(n)); if (out.length >= limit) break; }
  return { count: out.length, nodes: out };
});

function paintsOut(paints) {
  if (!paints || paints === figma.mixed) return paints === figma.mixed ? 'mixed' : [];
  return paints.filter((p) => p.visible !== false).map((p) => {
    if (p.type === 'SOLID') return { type: 'SOLID', hex: ctx.hexOf(p.color), opacity: p.opacity, variable: p.boundVariables && p.boundVariables.color ? p.boundVariables.color.id : undefined };
    if (p.type === 'IMAGE') return { type: 'IMAGE', scaleMode: p.scaleMode, hash: p.imageHash };
    return { type: p.type };
  });
}

function specOf(n, depth) {
  const s = box(n);
  if (n.visible === false) s.visible = false;
  if ('fills' in n) s.fills = paintsOut(n.fills);
  if ('strokes' in n && n.strokes.length) { s.strokes = paintsOut(n.strokes); s.strokeWeight = n.strokeWeight; }
  if ('topLeftRadius' in n && n.type !== 'TEXT') {
    const r = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    if (r.some((x) => x)) s.radius = r;
  }
  if ('layoutMode' in n && n.layoutMode !== 'NONE') {
    s.layout = { mode: n.layoutMode, gap: n.itemSpacing, padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft], primary: n.primaryAxisAlignItems, counter: n.counterAxisAlignItems, primarySizing: n.primaryAxisSizingMode, counterSizing: n.counterAxisSizingMode, wrap: n.layoutWrap };
  }
  if ('layoutSizingHorizontal' in n && n.parent && 'layoutMode' in n.parent && n.parent.layoutMode !== 'NONE') s.sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical];
  if (n.type === 'TEXT') {
    s.text = {
      chars: n.characters.slice(0, 400),
      fontSize: n.fontSize === figma.mixed ? 'mixed' : n.fontSize,
      font: n.fontName === figma.mixed ? 'mixed' : n.fontName.family + ' ' + n.fontName.style,
      lineHeight: n.lineHeight === figma.mixed ? 'mixed' : n.lineHeight,
      align: n.textAlignHorizontal, autoResize: n.textAutoResize,
    };
  }
  if (n.boundVariables && Object.keys(n.boundVariables).length) s.bound = Object.keys(n.boundVariables);
  if (n.type === 'INSTANCE') s.instance = true;
  if (n.type === 'COMPONENT') s.component = true;
  if ('children' in n) {
    if (depth === 0) s.childCount = n.children.length;
    else s.children = n.children.map((c) => specOf(c, depth - 1));
  }
  return s;
}

// node tree; depth -1 = full
H.register('spec', async (a) => {
  const n = await ctx.node(a.id);
  return specOf(n, a.depth == null ? -1 : a.depth);
});

H.register('select', async (a) => {
  const ids = [].concat(a.ids || a.id || []);
  if (!ids.length) ctx.fail('INVALID_INPUT', 'ids required');
  const nodes = [];
  for (const id of ids) nodes.push(await ctx.node(id));
  const p = ctx.pageOf(nodes[0]);
  if (p !== figma.currentPage) await figma.setCurrentPageAsync(p);
  p.selection = nodes.filter((n) => ctx.pageOf(n) === p);
  if (a.zoom !== false) figma.viewport.scrollAndZoomIntoView(p.selection);
  return { page: p.name, selected: p.selection.map((n) => ({ id: n.id, name: n.name })) };
});

H.register('selection', async () => figma.currentPage.selection.map(box));

// PNG/JPG export as base64; scale default 1, clamps to 4096px longest side unless maxSide given
H.register('screenshot', async (a) => {
  const n = await ctx.node(a.id);
  const maxSide = a.maxSide || 4096;
  let scale = a.scale || 1;
  const longest = Math.max(n.width, n.height) * scale;
  if (longest > maxSide) scale = maxSide / Math.max(n.width, n.height);
  const bytes = await n.exportAsync({ format: a.format === 'JPG' ? 'JPG' : 'PNG', constraint: { type: 'SCALE', value: scale } });
  return { id: n.id, name: n.name, scale, format: a.format === 'JPG' ? 'JPG' : 'PNG', base64: figma.base64Encode(bytes) };
});

// quality audit for frames: fonts, unbound raw colors, text overflowing its parent box
H.register('audit', async (a) => {
  let frames;
  if (a.ids) { frames = []; for (const id of a.ids) frames.push(await ctx.node(id)); }
  else { const p = await ctx.page(a.page); frames = p.children.filter((n) => !a.name || new RegExp(a.name).test(n.name)); }
  const rows = [];
  let i = 0;
  for (const f of frames) {
    ctx.progress(++i, frames.length, f.name);
    const fonts = {};
    let texts = 0, raw = 0, bound = 0, overflow = 0;
    const samples = [];
    const nodes = 'findAll' in f ? [f, ...f.findAll(() => true)] : [f];
    for (const n of nodes) {
      if ('fills' in n && n.fills !== figma.mixed) for (const p of n.fills) {
        if (p.type !== 'SOLID' || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) bound++; else { raw++; if (samples.length < 5) samples.push({ id: n.id, name: n.name, hex: ctx.hexOf(p.color) }); }
      }
      if (n.type !== 'TEXT') continue;
      texts++;
      if (n.characters.length) for (const fn of n.getRangeAllFontNames(0, n.characters.length)) fonts[fn.family] = (fonts[fn.family] || 0) + 1;
      const p = n.parent;
      if (p && p.type !== 'PAGE' && (n.width > p.width + 1 || n.height > p.height + 1)) overflow++;
    }
    rows.push({ id: f.id, name: f.name, texts, fonts, boundColors: bound, rawColors: raw, rawSamples: samples, textOverflow: overflow });
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return { frames: rows.length, texts: sum('texts'), rawColors: sum('rawColors'), textOverflow: sum('textOverflow'), rows };
});
