// Smart guides. Snap radius is in SCREEN pixels (default 8) so it feels identical at every zoom. Hold Alt to bypass.
// Targets: canvas edges/centre + every non-moving item's edges/centres.
export function createSnapper({ radiusPx = 8, canvas = null }) {
  const targets = (others) => { const xs = new Set(), ys = new Set(); const add = b => { [b.x, b.x + b.w / 2, b.x + b.w].forEach(v => xs.add(v)); [b.y, b.y + b.h / 2, b.y + b.h].forEach(v => ys.add(v)); }; if (canvas) add(canvas); others.forEach(add); return { xs: [...xs], ys: [...ys] }; };
  const best = (cands, tgts, r) => { let b = null; for (const c of cands) for (const t of tgts) { const d = t - c; if (Math.abs(d) <= r && (!b || Math.abs(d) < Math.abs(b.d))) b = { d, at: t }; } return b; };
  return {
    // moving box (after the raw drag delta was applied) -> {dx,dy,guides}
    move(box, others, pxPerUnit, { bypass = false } = {}) {
      if (bypass) return { dx: 0, dy: 0, guides: [] }; const r = radiusPx / pxPerUnit, t = targets(others);
      const bx = best([box.x, box.x + box.w / 2, box.x + box.w], t.xs, r), by = best([box.y, box.y + box.h / 2, box.y + box.h], t.ys, r), dx = bx ? bx.d : 0, dy = by ? by.d : 0, nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, g = [];
      const span = (axis) => { const bs = [nb, ...others]; return axis === 'x' ? [Math.min(...bs.map(b => b.y)), Math.max(...bs.map(b => b.y + b.h))] : [Math.min(...bs.map(b => b.x)), Math.max(...bs.map(b => b.x + b.w))]; };
      if (bx) g.push({ axis: 'x', pos: bx.at, span: span('x') }); if (by) g.push({ axis: 'y', pos: by.at, span: span('y') });
      return { dx, dy, guides: g };
    },
  };
}
