// DOM overlay: per-item outlines, the group box + 8 handles, marquee rectangle, smart-guide lines. Pure presentation, no state.
const CSS = `.fk-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.fk-box{position:absolute;border:1px solid var(--fk-accent,#05d3ff);box-sizing:border-box}
.fk-group{position:absolute;border:1.5px solid var(--fk-accent,#05d3ff);box-shadow:0 0 0 1px rgba(0,0,0,.55);box-sizing:border-box}
.fk-h{position:absolute;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;background:#fff;border:1.5px solid var(--fk-accent,#05d3ff);border-radius:50%;pointer-events:auto;box-sizing:border-box}
.fk-h[data-h=n],.fk-h[data-h=s]{cursor:ns-resize}.fk-h[data-h=e],.fk-h[data-h=w]{cursor:ew-resize}.fk-h[data-h=nw],.fk-h[data-h=se]{cursor:nwse-resize}.fk-h[data-h=ne],.fk-h[data-h=sw]{cursor:nesw-resize}
.fk-marquee{position:absolute;border:1px solid var(--fk-accent,#05d3ff);background:color-mix(in srgb,var(--fk-accent,#05d3ff) 14%,transparent);box-sizing:border-box}
.fk-guide{position:absolute;background:var(--fk-guide,#ff0060)}`;
export function createOverlay(container) {
  if (!document.getElementById('fk-css')) { const s = document.createElement('style'); s.id = 'fk-css'; s.textContent = CSS; document.head.appendChild(s); }
  const layer = document.createElement('div'); layer.className = 'fk-layer'; container.appendChild(layer);
  const el = (cls, st) => { const d = document.createElement('div'); d.className = cls; Object.assign(d.style, st); layer.appendChild(d); return d; };
  return {
    layer,
    draw({ boxes = [], group = null, marquee = null, guides = [], k = 1, handles = true, canvas = null }) {
      layer.textContent = ''; const px = (v) => v * k + 'px';
      if (boxes.length > 1) boxes.forEach(b => el('fk-box', { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) }));
      if (group) { el('fk-group', { left: px(group.x), top: px(group.y), width: px(group.w), height: px(group.h) });
        if (handles) { const P = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] }; for (const [h, [fx, fy]] of Object.entries(P)) { const d = el('fk-h', { left: px(group.x + group.w * fx), top: px(group.y + group.h * fy) }); d.dataset.h = h; } } }
      if (marquee) el('fk-marquee', { left: px(marquee.x), top: px(marquee.y), width: px(marquee.w), height: px(marquee.h) });
      guides.forEach(g => g.axis === 'x' ? el('fk-guide', { left: px(g.pos) , top: px(g.span[0]), width: '1px', height: px(g.span[1] - g.span[0]) }) : el('fk-guide', { top: px(g.pos), left: px(g.span[0]), height: '1px', width: px(g.span[1] - g.span[0]) }));
    },
  };
}
