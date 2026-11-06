// html: render an HTML page into Figma nodes (DesignAgent html_to_design replacement).
// The plugin UI lays the page out in a real browser iframe (fonts, flexbox, images) and returns a
// layout tree; this handler turns it into frames / text / image rects / svg.
// args: { url (path under the server /files root) | html, width, x?, y?, page?, parent?, name?, replaceId? }
// Layout tree contract (produced by ui.html extractLayout):
//   { k:'frame'|'text'|'image'|'svg', name, x, y, w, h, abs?, opacity?,
//     fills?:[{t:'solid',c}|{t:'image',url,fit}|{t:'linear',angle,stops:[{c,p}]}],
//     radius?:[tl,tr,br,bl], stroke?:{c,w}, shadow?:{x,y,blur,spread,c}, clip?,
//     layout?:{dir:'H'|'V',gap,rowGap,pad:[t,r,b,l],primary,counter,wrap}, children?,
//     text?:{chars, runs:[{s,e,family,weight,italic,size,c,ls,lh,deco}], align, upper, autoResize},
//     image?:{url, fit}, svg? }   colors c = {r,g,b,a} in 0..1

const paintColor = (c) => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a == null ? 1 : c.a });

function linearPaint(f) {
  // CSS angle: 0deg = to top, 90deg = to right. Figma gradientTransform maps (0,0)-(1,0) along the gradient.
  const rad = ((f.angle == null ? 180 : f.angle) - 90) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[cos, sin, 0.5 - cos / 2 - sin / 2], [-sin, cos, 0.5 + sin / 2 - cos / 2]],
    gradientStops: f.stops.map((s) => ({ position: s.p, color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a == null ? 1 : s.c.a } })),
  };
}

H.register('html', async (a, c) => {
  if (!a.url && !a.html) ctx.fail('INVALID_INPUT', 'url or html required');
  const width = a.width || 1440;
  let parent;
  let replaced = null;
  if (a.replaceId) {
    replaced = await ctx.writable(a.replaceId);
    parent = replaced.parent;
  } else if (a.parent) parent = await ctx.writable(a.parent);
  else { parent = await ctx.page(a.page); ctx.assertWritable(parent); }

  ctx.progress(0, 3, 'layout');
  const res = await ctx.ui('layout', { url: a.url, html: a.html, width, script: ctx.layoutScript, timeoutMs: a.layoutTimeoutMs });
  const tree = res.tree;
  const images = res.images || {};

  // fonts: resolve every family/weight once
  ctx.progress(1, 3, 'fonts');
  const fontKey = (r) => `${r.family}|${r.weight}|${r.italic ? 1 : 0}`;
  const need = new Map();
  const walk = (n) => { if (n.text) for (const r of n.text.runs) need.set(fontKey(r), r); (n.children || []).forEach(walk); };
  walk(tree);
  const resolved = {};
  const missing = new Set();
  for (const [k, r] of need) {
    let f = null;
    for (const fam of String(r.family).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)) {
      f = await ctx.resolveFont(fam, r.weight, r.italic);
      if (f) break;
      missing.add(fam);
    }
    if (!f) f = (await ctx.resolveFont('Inter', r.weight, r.italic)) || { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(f);
    resolved[k] = f;
  }

  const hashes = {};
  const imageHash = (url) => {
    if (!(url in hashes)) hashes[url] = images[url] ? figma.createImage(images[url]).hash : null;
    return hashes[url];
  };
  const fillsOf = (list) => (list || []).map((f) => {
    if (f.t === 'solid') return paintColor(f.c);
    if (f.t === 'linear') return linearPaint(f);
    if (f.t === 'image') { const h = imageHash(f.url); return h ? { type: 'IMAGE', imageHash: h, scaleMode: f.fit || 'FILL' } : null; }
    return null;
  }).filter(Boolean);

  let count = 0;
  const warnings = [];
  function style(node, n) {
    if (n.opacity != null && n.opacity < 1) node.opacity = n.opacity;
    if (n.radius && 'topLeftRadius' in node) [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = n.radius;
    if (n.stroke && 'strokes' in node) { node.strokes = [paintColor(n.stroke.c)]; node.strokeWeight = n.stroke.w; node.strokeAlign = 'INSIDE'; }
    if (n.shadow && 'effects' in node) node.effects = [{ type: 'DROP_SHADOW', offset: { x: n.shadow.x, y: n.shadow.y }, radius: n.shadow.blur, spread: n.shadow.spread || 0, color: { r: n.shadow.c.r, g: n.shadow.c.g, b: n.shadow.c.b, a: n.shadow.c.a }, visible: true, blendMode: 'NORMAL' }];
  }
  function place(node, n, par, inAuto) {
    if (inAuto && n.abs) node.layoutPositioning = 'ABSOLUTE';
    if (!inAuto || n.abs) { node.x = n.x; node.y = n.y; }
  }

  async function build(n, par, inAuto) {
    count++;
    if (count % 300 === 0) ctx.progress(2, 3, `nodes ${count}`);
    let node;
    if (n.k === 'text') {
      node = figma.createText();
      par.appendChild(node);
      const t = n.text;
      node.fontName = resolved[fontKey(t.runs[0])];
      node.characters = t.chars;
      for (const r of t.runs) {
        if (r.e <= r.s) continue;
        node.setRangeFontName(r.s, r.e, resolved[fontKey(r)]);
        node.setRangeFontSize(r.s, r.e, Math.max(1, r.size));
        node.setRangeFills(r.s, r.e, [paintColor(r.c)]);
        if (r.ls) node.setRangeLetterSpacing(r.s, r.e, { unit: 'PIXELS', value: r.ls });
        node.setRangeLineHeight(r.s, r.e, r.lh ? { unit: 'PIXELS', value: r.lh } : { unit: 'AUTO' });
        if (r.deco) node.setRangeTextDecoration(r.s, r.e, r.deco);
      }
      node.textAlignHorizontal = t.align || 'LEFT';
      if (t.upper) node.textCase = 'UPPER';
      if (t.autoResize === 'WIDTH_AND_HEIGHT') node.textAutoResize = 'WIDTH_AND_HEIGHT';
      else { node.textAutoResize = 'HEIGHT'; node.resize(Math.max(1, n.w), node.height); }
      if (inAuto && !n.abs && t.autoResize !== 'WIDTH_AND_HEIGHT') node.layoutSizingHorizontal = 'FIXED';
    } else if (n.k === 'image') {
      node = figma.createRectangle();
      par.appendChild(node);
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
      const h = imageHash(n.image.url);
      node.fills = h ? [{ type: 'IMAGE', imageHash: h, scaleMode: n.image.fit || 'FILL' }] : [paintColor({ r: 0.9, g: 0.9, b: 0.9, a: 1 })];
      if (!h) warnings.push(`image not loaded: ${n.image.url}`);
      style(node, n);
    } else if (n.k === 'svg') {
      try { node = figma.createNodeFromSvg(n.svg); par.appendChild(node); node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h)); }
      catch (e) { warnings.push(`svg failed: ${n.name}`); node = figma.createFrame(); par.appendChild(node); node.fills = []; node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h)); }
    } else {
      node = figma.createFrame();
      par.appendChild(node);
      node.fills = fillsOf(n.fills);
      node.clipsContent = !!n.clip;
      style(node, n);
      if (n.layout) {
        const L = n.layout;
        node.layoutMode = L.dir === 'H' ? 'HORIZONTAL' : 'VERTICAL';
        node.primaryAxisSizingMode = 'FIXED';
        node.counterAxisSizingMode = 'FIXED';
        node.itemSpacing = L.gap || 0;
        [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft] = L.pad || [0, 0, 0, 0];
        node.primaryAxisAlignItems = L.primary || 'MIN';
        node.counterAxisAlignItems = L.counter || 'MIN';
        if (L.wrap && L.dir === 'H') { node.layoutWrap = 'WRAP'; node.counterAxisSpacing = L.rowGap || 0; }
      }
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
    node.name = n.name || node.name;
    place(node, n, par, inAuto);
    if (n.k === 'frame') for (const ch of n.children || []) await build(ch, node, !!n.layout);
    if (n.k === 'frame' && n.layout) node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    return node;
  }

  ctx.progress(2, 3, 'nodes');
  let index = null;
  if (replaced) index = replaced.parent.children.indexOf(replaced);
  const root = await build({ ...tree, x: 0, y: 0 }, parent, false);
  root.name = a.name || (replaced ? replaced.name : tree.name);
  if (replaced) {
    parent.insertChild(index, root);
    root.x = a.x != null ? a.x : replaced.x;
    root.y = a.y != null ? a.y : replaced.y;
    replaced.remove();
  } else {
    root.x = a.x || 0;
    root.y = a.y || 0;
  }
  ctx.progress(3, 3, 'done');
  return { id: root.id, name: root.name, width: root.width, height: root.height, nodes: count, missingFonts: [...missing], warnings: warnings.slice(0, 20) };
});
