// Boxes are {x,y,w,h} in the editor's own world units (grid cells, px, mm: the kit doesn't care). Optional rot in degrees.
export const union = boxes => { if (!boxes.length) return null; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
export const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
export const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const pointIn = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const handlePoint = (b, h) => ({ x: h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2, y: h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2 });
export const oppositeHandle = h => ({ nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' })[h];
