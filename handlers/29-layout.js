// extractLayout: runs INSIDE the page iframe that the plugin UI creates for the html command.
// Kept here (hot-reloadable) and sent to the UI as source text on every html call.
// Must be self-contained: no closures over plugin scope.
function extractLayout(rid) {
  const post = (m) => parent.postMessage(Object.assign({ __nga: rid }, m), '*');
  const run = async () => {
    // timers, not requestAnimationFrame: rAF is paused in hidden/offscreen frames
    const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    post({ stage: 'fonts' });
    await within(document.fonts ? document.fonts.ready : Promise.resolve(), 15000);
    post({ stage: 'images' });
    await within(Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))), 20000);
    await new Promise((r) => setTimeout(r, 50));
    post({ stage: 'walk' });
    const urls = new Set();
    const px = (v) => parseFloat(v) || 0;
    const col = (s) => {
      if (!s || s === 'transparent') return null;
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      const a = p.length > 3 ? p[3] : 1;
      return a === 0 ? null : { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a };
    };
    const nameOf = (el) => el.getAttribute('data-name') || (el.id ? `#${el.id}` : el.classList.length ? `${el.tagName.toLowerCase()}.${el.classList[0]}` : el.tagName.toLowerCase());
    const WEIGHT = (w) => (w === 'bold' ? 700 : w === 'normal' ? 400 : parseInt(w, 10) || 400);
    const INLINE = new Set(['inline', 'contents']);
    const hidden = (cs) => cs.display === 'none' || cs.visibility === 'hidden';
    const isTextLeaf = (el) => {
      if (!el.textContent.trim()) return false;
      for (const c of el.childNodes) {
        if (c.nodeType === 3) continue;
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') continue;
        const cs = getComputedStyle(c);
        if (hidden(cs)) continue;
        if (!INLINE.has(cs.display) || ['IMG', 'SVG', 'svg', 'INPUT', 'BUTTON', 'IFRAME'].includes(c.tagName) || !isTextLeafInline(c)) return false;
      }
      return true;
    };
    const isTextLeafInline = (el) => [...el.childNodes].every((c) => c.nodeType === 3 || c.nodeType === 8 || (c.nodeType === 1 && (c.tagName === 'BR' || (INLINE.has(getComputedStyle(c).display) && isTextLeafInline(c)))));

    // text runs for an element (or a single text node)
    function textOf(el, onlyNode) {
      let chars = '';
      const runs = [];
      const pre = (cs) => /^pre/.test(cs.whiteSpace) || cs.whiteSpace === 'break-spaces';
      const push = (txt, cs) => {
        if (!txt) return;
        const s = chars.length;
        chars += txt;
        const deco = cs.textDecorationLine.includes('underline') ? 'UNDERLINE' : cs.textDecorationLine.includes('line-through') ? 'STRIKETHROUGH' : null;
        runs.push({ s, e: chars.length, family: cs.fontFamily, weight: WEIGHT(cs.fontWeight), italic: cs.fontStyle === 'italic', size: px(cs.fontSize), c: col(cs.color) || { r: 0, g: 0, b: 0, a: 1 }, ls: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing), lh: cs.lineHeight === 'normal' ? 0 : px(cs.lineHeight), deco });
      };
      const visit = (n) => {
        if (n.nodeType === 3) {
          const cs = getComputedStyle(n.parentElement);
          let t = n.nodeValue;
          if (!pre(cs)) t = t.replace(/\s+/g, ' ');
          if (!pre(cs) && /\s$/.test(chars) && t.startsWith(' ')) t = t.slice(1);
          push(t, cs);
        } else if (n.nodeType === 1) {
          if (n.tagName === 'BR') { if (chars.endsWith(' ')) chars = chars.slice(0, -1); push('\n', getComputedStyle(n.parentElement)); return; }
          if (hidden(getComputedStyle(n))) return;
          n.childNodes.forEach(visit);
        }
      };
      if (onlyNode) visit(onlyNode); else el.childNodes.forEach(visit);
      // list bullet
      const host = el;
      if (!onlyNode && getComputedStyle(host).display === 'list-item' && getComputedStyle(host).listStyleType !== 'none') {
        const cs = getComputedStyle(host);
        const mark = cs.listStyleType === 'decimal' ? `${[...host.parentElement.children].indexOf(host) + 1}. ` : '• ';
        chars = mark + chars;
        runs.forEach((r) => { r.s += mark.length; r.e += mark.length; });
        if (runs.length) runs[0].s = 0;
      }
      // trim
      const lead = chars.length - chars.replace(/^[ \n]+/, '').length;
      const trail = chars.length - chars.replace(/[ \n]+$/, '').length;
      const end = chars.length - trail;
      chars = chars.slice(lead, end);
      const out = runs.map((r) => ({ ...r, s: Math.max(0, r.s - lead), e: Math.min(chars.length, r.e - lead) })).filter((r) => r.e > r.s);
      if (!out.length && runs.length) out.push({ ...runs[0], s: 0, e: chars.length });
      return { chars, runs: out };
    }
    const range = document.createRange();
    function textNode(el, cs, prect, onlyNode, elRect) {
      const t = textOf(el, onlyNode);
      if (!t.chars) return null;
      if (onlyNode) range.selectNodeContents(onlyNode); else range.selectNodeContents(el);
      const rr = range.getBoundingClientRect();
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      const align = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' }[cs.textAlign] || 'LEFT';
      const nowrap = cs.whiteSpace === 'nowrap' || lines <= 1;
      let x, w;
      if (nowrap) { x = rr.left; w = rr.width; }
      else {
        const r = elRect || el.getBoundingClientRect();
        x = r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth);
        w = r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
      }
      return { k: 'text', name: t.chars.slice(0, 40), x: x - prect.left, y: rr.top - prect.top, w, h: rr.height, text: { chars: t.chars, runs: t.runs, align: nowrap ? 'LEFT' : align, upper: cs.textTransform === 'uppercase', autoResize: nowrap ? 'WIDTH_AND_HEIGHT' : 'HEIGHT' } };
    }
    const hasBox = (cs) => col(cs.backgroundColor) || cs.backgroundImage !== 'none' || px(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none' || px(cs.paddingTop) + px(cs.paddingLeft) > 0 || /hidden|clip/.test(cs.overflow);

    function boxStyle(el, cs, n) {
      const fills = [];
      const bg = col(cs.backgroundColor);
      if (bg) fills.push({ t: 'solid', c: bg });
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const u = cs.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (u) { urls.add(u[1]); fills.push({ t: 'image', url: u[1], fit: cs.backgroundSize === 'contain' ? 'FIT' : 'FILL' }); }
        const g = cs.backgroundImage.match(/linear-gradient\((.*)\)/);
        if (g) {
          const parts = g[1].split(/,(?![^(]*\))/).map((s) => s.trim());
          let angle = 180;
          if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift());
          else if (/^to /.test(parts[0])) { const d = parts.shift(); angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[d] || 180; }
          const stops = parts.map((p, i) => { const m = p.match(/(rgba?\([^)]+\))\s*([\d.]+%)?/); return m ? { c: col(m[1]) || { r: 0, g: 0, b: 0, a: 0 }, p: m[2] ? parseFloat(m[2]) / 100 : i / Math.max(1, parts.length - 1) } : null; }).filter(Boolean);
          if (stops.length > 1) fills.push({ t: 'linear', angle, stops });
        }
      }
      if (fills.length) n.fills = fills;
      const rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px);
      const r = el.getBoundingClientRect();
      const cap = Math.min(r.width, r.height) / 2;
      if (rad.some((v) => v)) n.radius = rad.map((v) => Math.min(v, cap));
      const bw = px(cs.borderTopWidth);
      const bc = col(cs.borderTopColor);
      if (bw > 0 && bc && cs.borderTopStyle !== 'none') n.stroke = { c: bc, w: bw };
      if (cs.boxShadow && cs.boxShadow !== 'none' && !/inset/.test(cs.boxShadow)) {
        const m = cs.boxShadow.match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/);
        if (m) n.shadow = { c: col(m[1]) || { r: 0, g: 0, b: 0, a: 0.2 }, x: +m[2], y: +m[3], blur: +m[4], spread: +(m[5] || 0) };
      }
      const op = parseFloat(cs.opacity);
      if (op < 1) n.opacity = op;
      if (/hidden|clip/.test(cs.overflow)) n.clip = true;
    }

    function flexLayout(el, cs, kids) {
      if (!/flex/.test(cs.display)) return null;
      if (/reverse/.test(cs.flexDirection)) return null;
      const dir = cs.flexDirection.startsWith('column') ? 'V' : 'H';
      const primary = { 'flex-start': 'MIN', start: 'MIN', normal: 'MIN', left: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', right: 'MAX', 'space-between': 'SPACE_BETWEEN' }[cs.justifyContent];
      const counter = { 'flex-start': 'MIN', start: 'MIN', normal: 'MIN', stretch: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', baseline: 'BASELINE' }[cs.alignItems];
      if (!primary || !counter) return null;
      for (const k of el.childNodes) if (k.nodeType === 3 && k.nodeValue.trim()) return null;
      for (const k of kids) {
        const kc = getComputedStyle(k);
        if (kc.position === 'absolute' || kc.position === 'fixed') continue;
        if (kc.alignSelf !== 'auto' && kc.alignSelf !== 'normal' && kc.alignSelf !== cs.alignItems) return null;
        const mm = dir === 'H' ? px(kc.marginLeft) + px(kc.marginRight) : px(kc.marginTop) + px(kc.marginBottom);
        if (Math.abs(mm) > 0.5 || (kc.order && kc.order !== '0')) return null;
      }
      const gap = dir === 'H' ? px(cs.columnGap) : px(cs.rowGap);
      return { dir, gap, rowGap: px(cs.rowGap), pad: [px(cs.paddingTop) + px(cs.borderTopWidth), px(cs.paddingRight) + px(cs.borderRightWidth), px(cs.paddingBottom) + px(cs.borderBottomWidth), px(cs.paddingLeft) + px(cs.borderLeftWidth)], primary, counter, wrap: cs.flexWrap === 'wrap' };
    }

    function walk(el, prect) {
      const cs = getComputedStyle(el);
      if (hidden(cs)) return null;
      const de = document.documentElement;
      const r = el.tagName === 'BODY' ? { left: 0, top: 0, width: de.clientWidth, height: Math.max(de.scrollHeight, el.scrollHeight) } : el.getBoundingClientRect();
      if (r.width < 0.5 && r.height < 0.5 && el.tagName !== 'BODY') return null;
      const base = { name: nameOf(el), x: r.left - prect.left, y: r.top - prect.top, w: r.width, h: r.height };
      if (cs.position === 'absolute' || cs.position === 'fixed') base.abs = true;
      const tag = el.tagName.toLowerCase();
      if (tag === 'svg') {
        const clone = el.cloneNode(true);
        clone.setAttribute('width', r.width); clone.setAttribute('height', r.height);
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        return { ...base, k: 'svg', svg: new XMLSerializer().serializeToString(clone) };
      }
      if (tag === 'img') {
        const u = el.currentSrc || el.src;
        urls.add(u);
        const n = { ...base, k: 'image', image: { url: u, fit: cs.objectFit === 'contain' ? 'FIT' : 'FILL' } };
        boxStyle(el, cs, n);
        delete n.fills;
        return n;
      }
      if (isTextLeaf(el)) {
        const t = textNode(el, cs, r, null, r);
        if (!t) return null;
        if (!hasBox(cs) && el.tagName !== 'BODY') { t.x += base.x; t.y += base.y; if (base.abs) t.abs = true; t.name = base.name; return t; }
        const n = { ...base, k: 'frame', children: [t] };
        boxStyle(el, cs, n);
        return n;
      }
      const n = { ...base, k: 'frame', children: [] };
      boxStyle(el, cs, n);
      const kids = [...el.children].filter((k) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'NOSCRIPT', 'TEMPLATE'].includes(k.tagName));
      for (const c of el.childNodes) {
        if (c.nodeType === 3 && c.nodeValue.trim()) {
          const t = textNode(el, cs, r, c, r);
          if (t) n.children.push(t);
        } else if (c.nodeType === 1 && kids.includes(c)) {
          const ch = walk(c, r);
          if (ch) n.children.push(ch);
        }
      }
      const lay = flexLayout(el, cs, kids);
      if (lay) n.layout = lay;
      return n;
    }

    const body = document.body;
    const prect = { left: 0, top: 0 };
    const tree = walk(body, prect);
    tree.w = document.documentElement.clientWidth;
    tree.h = Math.max(document.documentElement.scrollHeight, body.scrollHeight);
    tree.x = 0; tree.y = 0;
    if (!tree.fills) { const bg = col(getComputedStyle(document.documentElement).backgroundColor) || col(getComputedStyle(body).backgroundColor); tree.fills = [{ t: 'solid', c: bg || { r: 1, g: 1, b: 1, a: 1 } }]; }
    tree.name = document.title || 'page';
    delete tree.layout;
    post({ stage: 'fetch images' });
    const images = {};
    for (const u of urls) {
      try { const res = await fetch(u); if (res.ok) images[u] = new Uint8Array(await res.arrayBuffer()); } catch (e) {}
    }
    post({ tree, images });
  };
  const go = () => (post({ stage: 'start' }), run()).catch((e) => post({ error: String(e && e.stack || e) }));
  document.readyState === 'complete' ? go() : addEventListener('load', go);
}

ctx.layoutScript = extractLayout.toString();
