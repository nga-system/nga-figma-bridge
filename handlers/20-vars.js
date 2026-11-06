// Variables and design-token presets.
// tokens.* take a preset object (presets/*.json, sent by the CLI) so the plugin holds no project data.

H.register('vars.list', async () => {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const vars = await figma.variables.getLocalVariablesAsync();
  return cols.map((c) => ({
    id: c.id, name: c.name, modes: c.modes.map((m) => m.name),
    variables: vars.filter((v) => v.variableCollectionId === c.id).map((v) => ({
      id: v.id, name: v.name, type: v.resolvedType,
      values: Object.fromEntries(c.modes.map((m) => {
        const val = v.valuesByMode[m.modeId];
        return [m.name, val && typeof val === 'object' && 'r' in val ? ctx.hexOf(val) : val];
      })),
    })),
  }));
});

async function ensureCollection(name, modes) {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  let col = all.find((c) => c.name === name);
  if (!col) col = figma.variables.createVariableCollection(name);
  col.renameMode(col.modes[0].modeId, modes[0]);
  for (const m of modes.slice(1)) if (!col.modes.find((x) => x.name === m)) col.addMode(m);
  return col;
}
async function ensureVariable(col, name, type) {
  const vars = await figma.variables.getLocalVariablesAsync(type);
  return vars.find((v) => v.name === name && v.variableCollectionId === col.id) || figma.variables.createVariable(name, col, type);
}
ctx.ensureCollection = ensureCollection;
ctx.ensureVariable = ensureVariable;

// { collection, modes:[..], type: COLOR|FLOAT|STRING, vars: { name: value | [value per mode] } }
H.register('vars.ensure', async (a) => {
  if (!a.collection || !a.vars) ctx.fail('INVALID_INPUT', 'collection and vars required');
  const modes = a.modes || ['Default'];
  const col = await ensureCollection(a.collection, modes);
  const type = a.type || 'COLOR';
  const out = {};
  for (const [name, val] of Object.entries(a.vars)) {
    const v = await ensureVariable(col, name, type);
    const vals = Array.isArray(val) ? val : modes.map(() => val);
    modes.forEach((m, i) => v.setValueForMode(col.modes.find((x) => x.name === m).modeId, type === 'COLOR' ? ctx.rgb(vals[i]) : vals[i]));
    out[name] = v.id;
  }
  return { collection: col.id, variables: out };
});

// bind a node field (fills/strokes color or a numeric field like itemSpacing, fontSize) to a variable
H.register('vars.bind', async (a) => {
  const n = await ctx.writable(a.id);
  const v = await ctx.variableRef(a.variable);
  if (a.field === 'fills' || a.field === 'strokes') {
    const paints = (n[a.field] && n[a.field] !== figma.mixed && n[a.field].length ? n[a.field] : [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]);
    n[a.field] = paints.map((p, i) => (i === (a.index || 0) && p.type === 'SOLID' ? figma.variables.setBoundVariableForPaint(p, 'color', v) : p));
  } else if (n.type === 'TEXT' && ['fontSize', 'letterSpacing', 'lineHeight'].includes(a.field)) {
    await ctx.loadFonts(n);
    n.setRangeBoundVariable(0, n.characters.length, a.field, v);
  } else {
    n.setBoundVariable(a.field, v);
  }
  return { id: n.id, field: a.field, variable: v.name };
});

// set explicit variable mode on a frame
H.register('vars.mode', async (a) => {
  const n = await ctx.writable(a.id);
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col = cols.find((c) => c.id === a.collection || c.name === a.collection);
  if (!col) ctx.fail('NOT_FOUND', `collection not found: ${a.collection}`);
  const mode = col.modes.find((m) => m.name === a.mode);
  if (!mode) ctx.fail('NOT_FOUND', `mode not found: ${a.mode}`);
  n.setExplicitVariableModeForCollection(col, mode.modeId);
  return { id: n.id, mode: mode.name };
});

// ---------- token presets ----------
// preset: { colorCollection, colors:{name:hex}, layoutCollection, modes:[..], layout:{name:[per mode]},
//           groups:{ radius:[names], type:[names], spacing:[[field,[names]],...] },
//           font:{ family, styleMap:{fromStyle:toStyle} }, viewPattern, viewModes:{view:modeIndex} }
async function preparePreset(p) {
  const colorCol = await ensureCollection(p.colorCollection, ['Default']);
  const byHex = {};
  for (const [name, hex] of Object.entries(p.colors || {})) {
    const v = await ensureVariable(colorCol, name, 'COLOR');
    v.setValueForMode(colorCol.modes[0].modeId, ctx.rgb(hex));
    byHex[hex.toUpperCase()] = v;
  }
  const layoutCol = await ensureCollection(p.layoutCollection, p.modes);
  const L = {};
  for (const [name, vals] of Object.entries(p.layout || {})) {
    const v = await ensureVariable(layoutCol, name, 'FLOAT');
    p.modes.forEach((m, i) => v.setValueForMode(layoutCol.modes.find((x) => x.name === m).modeId, vals[i]));
    L[name] = v;
  }
  return { colorCol, layoutCol, byHex, L };
}

// tokens.values: create/update variables only
H.register('tokens.values', async (a) => {
  if (!a.preset) ctx.fail('INVALID_INPUT', 'preset required');
  const t = await preparePreset(a.preset);
  return { colors: Object.keys(t.byHex).length, layout: Object.keys(t.L).length };
});

// tokens.apply: { preset, ids? | page?, steps?: ['modes','fonts','bind'] }
H.register('tokens.apply', async (a) => {
  const p = a.preset;
  if (!p) ctx.fail('INVALID_INPUT', 'preset required');
  const steps = a.steps || ['modes', 'fonts', 'bind'];
  const t = await preparePreset(p);
  let tops;
  if (a.ids) { tops = []; for (const id of a.ids) tops.push(await ctx.writable(id)); }
  else { const pg = await ctx.page(a.page); ctx.assertWritable(pg); tops = pg.children.slice(); }
  const viewRe = new RegExp(p.viewPattern || '(desktop|tablet|mobile)', 'i');
  const viewIdx = (node) => { const top = ctx.topOf(node); const m = top && viewRe.exec(top.name); return m ? p.viewModes[m[1].toLowerCase()] : null; };
  const stats = { frames: 0, font: 0, fills: 0, strokes: 0, radius: 0, spacing: 0, fontSize: 0, skipped: 0 };

  if (steps.includes('modes')) for (const top of tops) {
    const vi = viewIdx(top);
    if (vi == null || !('setExplicitVariableModeForCollection' in top)) continue;
    top.setExplicitVariableModeForCollection(t.layoutCol, t.layoutCol.modes.find((x) => x.name === p.modes[vi]).modeId);
    stats.frames++;
  }
  const inInstance = (n) => { for (let c = n.parent; c && c.type !== 'PAGE'; c = c.parent) if (c.type === 'INSTANCE') return true; return false; };
  const nodes = tops.flatMap((f) => ('findAll' in f ? [f, ...f.findAll((n) => !inInstance(n))] : [f]));

  const loaded = new Set();
  const load = async (f) => { const k = f.family + '/' + f.style; if (!loaded.has(k)) { await figma.loadFontAsync(f); loaded.add(k); } };
  if (steps.includes('fonts') && p.font) {
    const fam = p.font.family;
    let i = 0;
    for (const n of nodes) {
      if (++i % 500 === 0) ctx.progress(i, nodes.length, 'fonts');
      if (n.type !== 'TEXT' || !n.characters.length) continue;
      try {
        for (const seg of n.getStyledTextSegments(['fontName'])) {
          if (seg.fontName.family === fam) continue;
          const to = { family: fam, style: (p.font.styleMap || {})[seg.fontName.style] || seg.fontName.style };
          await load(seg.fontName);
          try { await load(to); } catch (e) { to.style = 'Regular'; await load(to); }
          n.setRangeFontName(seg.start, seg.end, to);
          stats.font++;
        }
      } catch (e) { stats.skipped++; }
    }
  }
  if (steps.includes('bind')) {
    const g = p.groups || {};
    const pick = (names, val, vi) => (names || []).find((k) => p.layout[k] && p.layout[k][vi] === val);
    const bindPaints = (node, key) => {
      const paints = node[key];
      if (!paints || paints === figma.mixed || !paints.length) return 0;
      let c = 0;
      const next = paints.map((pp) => {
        if (pp.type !== 'SOLID' || (pp.boundVariables && pp.boundVariables.color)) return pp;
        const v = t.byHex[ctx.hexOf(pp.color)];
        if (!v) return pp;
        c++;
        return figma.variables.setBoundVariableForPaint(pp, 'color', v);
      });
      if (c) node[key] = next;
      return c;
    };
    let i = 0;
    for (const n of nodes) {
      if (++i % 500 === 0) ctx.progress(i, nodes.length, 'bind');
      try {
        if ('fills' in n) stats.fills += bindPaints(n, 'fills');
        if ('strokes' in n) stats.strokes += bindPaints(n, 'strokes');
        const vi = viewIdx(n);
        if (vi == null) continue;
        if ('topLeftRadius' in n && n.type !== 'TEXT') for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) {
          if (n.boundVariables && n.boundVariables[f]) continue;
          const k = pick(g.radius, n[f], vi);
          if (k) { n.setBoundVariable(f, t.L[k]); stats.radius++; }
        }
        if ('layoutMode' in n && n.layoutMode !== 'NONE') for (const [f, names] of g.spacing || []) {
          if (n.boundVariables && n.boundVariables[f]) continue;
          const k = pick(names, n[f], vi);
          if (k) { n.setBoundVariable(f, t.L[k]); stats.spacing++; }
        }
        if (n.type === 'TEXT' && n.fontSize !== figma.mixed && n.characters.length && !(n.boundVariables && n.boundVariables.fontSize)) {
          const k = pick(g.type, n.fontSize, vi);
          if (k) { for (const f of n.getRangeAllFontNames(0, n.characters.length)) await load(f); n.setRangeBoundVariable(0, n.characters.length, 'fontSize', t.L[k]); stats.fontSize++; }
        }
      } catch (e) { stats.skipped++; }
    }
  }
  return stats;
});

// grow every text's parent box to fit the text (fixes wrappers after a font swap)
H.register('fit.textBoxes', async (a) => {
  let tops;
  if (a.ids) { tops = []; for (const id of a.ids) tops.push(await ctx.writable(id)); }
  else { const pg = await ctx.page(a.page); ctx.assertWritable(pg); tops = pg.children.slice(); }
  let resized = 0, skipped = 0, i = 0;
  for (const top of tops) {
    ctx.progress(++i, tops.length, top.name);
    if (!('findAll' in top)) continue;
    for (const t of top.findAll((n) => n.type === 'TEXT')) {
      const p = t.parent;
      if (!p || p.type === 'PAGE' || !('resize' in p) || p.type === 'INSTANCE') continue;
      if (t.width > p.width + 0.5 || t.height > p.height + 0.5) {
        try { p.resize(Math.max(p.width, Math.ceil(t.width)), Math.max(p.height, Math.ceil(t.height))); resized++; } catch (e) { skipped++; }
      }
    }
  }
  return { resized, skipped };
});
