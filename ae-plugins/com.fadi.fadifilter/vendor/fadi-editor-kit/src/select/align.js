// Align / distribute / z-order as pure patch generators (apply them in ONE history entry).
import { union } from './geometry.js';
export function align(items, mode, rel = null) {          // rel: box to align to (default: the selection's own bounds, e.g. the canvas)
  const b = rel || union(items), out = {};
  for (const i of items) out[i.id] = { left: { x: b.x }, hcenter: { x: b.x + (b.w - i.w) / 2 }, right: { x: b.x + b.w - i.w }, top: { y: b.y }, vcenter: { y: b.y + (b.h - i.h) / 2 }, bottom: { y: b.y + b.h - i.h } }[mode];
  return out;
}
export function distribute(items, axis) {                 // equal gaps between >=3 items along 'x' or 'y'
  if (items.length < 3) return {}; const k = axis === 'x' ? ['x', 'w'] : ['y', 'h'], s = items.slice().sort((a, b) => a[k[0]] - b[k[0]]), first = s[0], last = s[s.length - 1];
  const total = last[k[0]] + last[k[1]] - first[k[0]], used = s.reduce((n, i) => n + i[k[1]], 0), gap = (total - used) / (s.length - 1), out = {}; let cur = first[k[0]];
  for (const i of s) { out[i.id] = { [k[0]]: cur }; cur += i[k[1]] + gap; } return out;
}
export function zorder(all, ids, cmd) {                   // all: [{id,z}] -> patches setting z so order is stable and contiguous
  const order = all.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map(i => i.id), sel = new Set(ids); let n = order.slice();
  if (cmd === 'front') n = [...order.filter(i => !sel.has(i)), ...order.filter(i => sel.has(i))];
  else if (cmd === 'back') n = [...order.filter(i => sel.has(i)), ...order.filter(i => !sel.has(i))];
  else if (cmd === 'forward') { for (let k = n.length - 2; k >= 0; k--) if (sel.has(n[k]) && !sel.has(n[k + 1])) [n[k], n[k + 1]] = [n[k + 1], n[k]]; }
  else if (cmd === 'backward') { for (let k = 1; k < n.length; k++) if (sel.has(n[k]) && !sel.has(n[k - 1])) [n[k], n[k - 1]] = [n[k - 1], n[k]]; }
  return Object.fromEntries(n.map((id, z) => [id, { z }]));
}
