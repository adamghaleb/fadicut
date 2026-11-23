// Group transform: the selection's shared bounding box with 8 handles; every item is derived from the group transform.
// Rules: Shift = proportional; Alt = scale about the CENTER (default: about the opposite handle/corner); min size clamp, no flipping;
// rotate by dragging just outside a corner, Shift snaps to 15 degrees.
import { union, handlePoint, oppositeHandle, center } from './geometry.js';
export const groupBox = items => union(items);
export function moveGroup(items, dx, dy, { axisLock = false } = {}) {
  if (axisLock) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  return Object.fromEntries(items.map(i => [i.id, { x: i.x + dx, y: i.y + dy }]));
}
export function scaleGroup(items, box, handle, p, { proportional = false, fromCenter = false, minSize = 1 } = {}) {
  const hp = handlePoint(box, handle), a = fromCenter ? center(box) : handlePoint(box, oppositeHandle(handle));
  const lockX = handle === 'n' || handle === 's', lockY = handle === 'e' || handle === 'w';
  let sx = lockX ? 1 : (p.x - a.x) / (hp.x - a.x || 1), sy = lockY ? 1 : (p.y - a.y) / (hp.y - a.y || 1);
  if (proportional) { const s = lockX ? sy : lockY ? sx : Math.max(Math.abs(sx), Math.abs(sy)); sx = sy = s; }
  const minS = (d, m) => d ? Math.max(sx, 0) : 1; sx = Math.max(sx, minSize / box.w); sy = Math.max(sy, minSize / box.h);
  const out = {}; for (const i of items) out[i.id] = { x: a.x + (i.x - a.x) * sx, y: a.y + (i.y - a.y) * sy, w: i.w * sx, h: i.h * sy };
  return out;
}
export function rotateGroup(items, box, startAngle, nowAngle, { snapDeg = null } = {}) {
  let d = nowAngle - startAngle; if (snapDeg) d = Math.round(d / snapDeg) * snapDeg; const c = center(box), r = d * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), out = {};
  for (const i of items) { const ic = center(i), dx = ic.x - c.x, dy = ic.y - c.y, nx = c.x + dx * cs - dy * sn, ny = c.y + dx * sn + dy * cs; out[i.id] = { x: nx - i.w / 2, y: ny - i.h / 2, rot: ((i.rot || 0) + d) % 360 }; }
  return out;
}
export const angleOf = (c, p) => Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI;
// hit-test the 8 handles + rotate zone. slop is in SCREEN px (so it feels the same at every zoom); pass pxPerUnit.
export function hitHandle(box, p, pxPerUnit, { slop = 12, rotateRing = 28, rotate = false } = {}) {
  const r = slop / pxPerUnit; for (const h of ['nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w']) { const q = handlePoint(box, h); if (Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r) return { type: 'scale', handle: h }; }
  if (rotate) { const rr = rotateRing / pxPerUnit; for (const h of ['nw', 'ne', 'se', 'sw']) { const q = handlePoint(box, h); if (Math.hypot(p.x - q.x, p.y - q.y) <= rr) return { type: 'rotate', handle: h }; } }
  return null;
}
