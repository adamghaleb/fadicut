// Rubber-band selection. mode 'touch' (default: anything the box touches) or 'enclose' (only fully inside).
// Shift = add to the selection that existed when the drag began; Alt = subtract from it. Locked/hidden items are never picked.
import { rectOf, intersects, contains } from './geometry.js';
export function createMarquee({ items, mode = 'touch', minDrag = 3 }) {   // items(): [{id,x,y,w,h,locked,hidden}]
  let start = null, base = [], mods = {}, rect = null;
  return {
    begin(p, baseIds, m = {}) { start = p; base = m.shift || m.alt ? baseIds.slice() : []; mods = m; rect = null; },
    update(p, pxPerUnit = 1, m = mods) {
      if (!start) return null; const moved = Math.hypot(p.x - start.x, p.y - start.y) * pxPerUnit; if (moved < minDrag) return null;
      rect = rectOf(start, p); const hit = items().filter(i => !i.locked && !i.hidden && (mode === 'enclose' ? contains(rect, i) : intersects(rect, i))).map(i => i.id);
      const set = new Set(m.alt ? base : base); if (m.alt) hit.forEach(i => set.delete(i)); else hit.forEach(i => set.add(i));
      return { rect, ids: [...set] };
    },
    end() { const r = rect; start = null; rect = null; return r; },
    get active() { return !!start; },
  };
}
