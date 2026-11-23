// attachEditorControls: wires selection + marquee + group transform + snapping + undo + shortcuts onto a container.
// adapter contract (everything an editor must provide):
//   items()        -> [{id,x,y,w,h,z?,locked?,hidden?,rot?}]  in world units
//   patch(p)       -> apply {id:{x?,y?,w?,h?,z?,rot?}}         (must NOT push history; the controller does)
//   toWorld(e)     -> {x,y} world coords of a pointer event
//   pxPerUnit()    -> screen px per world unit (for snap radius, handle slop, overlay scale)
//   canvas         -> {x,y,w,h} world bounds (snap targets, align target)
//   grid           -> step to round moves to (default 1; Alt = free). 0 disables.
//   onSelect(ids)  -> optional;  onDraw() -> optional;  remove(ids) / duplicate(ids)->newIds optional
import { createSelection } from '../select/selection.js';
import { createMarquee } from '../select/marquee.js';
import { createSnapper } from '../select/snap.js';
import { groupBox, moveGroup, scaleGroup, rotateGroup, angleOf, hitHandle } from '../select/transform.js';
import { align as alignP, distribute as distP, zorder as zP } from '../select/align.js';
import { center, pointIn } from '../select/geometry.js';
import { createOverlay } from './overlay.js';

export function attachEditorControls({ container, adapter, history, registry, taste = null, marqueeMode = 'touch', snapPx = 8, rotate = false, proportionalDefault = false, dupThreshold = 2, axisHysteresisDeg = 8, nudgeMergeMs = 700 }) {
  const sel = createSelection({ onChange: ids => { adapter.onSelect?.(ids); redraw(); } }), overlay = createOverlay(container), snapper = createSnapper({ radiusPx: snapPx, canvas: adapter.canvas });
  const marq = createMarquee({ items: () => adapter.items(), mode: marqueeMode });
  let drag = null, guides = [], marqueeRect = null, nudgeRun = null;
  const visible = () => adapter.items().filter(i => !i.hidden), byId = id => adapter.items().find(i => i.id === id);
  const selected = () => adapter.items().filter(i => sel.has(i.id) && !i.locked);
  const k = () => adapter.pxPerUnit();
  function redraw() { const s = selected(); overlay.draw({ boxes: s, group: s.length ? groupBox(s) : null, marquee: marqueeRect, guides, k: k(), handles: !drag || drag.type !== 'marquee' }); adapter.onDraw?.(); }
  const topAt = p => visible().filter(i => !i.locked && pointIn(i, p)).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0];
  const snapshot = () => selected().map(i => ({ ...i }));
  const logEdit = (type, before) => taste?.log('edit:' + type, { n: before.length, before: before.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })), after: selected().map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) });

  container.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; const p = adapter.toWorld(e), mods = { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey, alt: e.altKey }, h = e.target.dataset?.h;
    if (h && sel.size) { const items0 = snapshot(); drag = { type: 'scale', h, items0, box0: groupBox(items0), g: history.gesture('scale'), p0: p }; container.setPointerCapture(e.pointerId); return; }
    const hit = topAt(p), r = sel.pointerDown(hit?.id ?? null, mods);
    if (rotate && sel.size && !hit) { const hh = hitHandle(groupBox(selected()), p, k(), { rotate: true }); if (hh?.type === 'rotate') { const items0 = snapshot(), box0 = groupBox(items0); drag = { type: 'rotate', items0, box0, a0: angleOf(center(box0), p), g: history.gesture('rotate') }; container.setPointerCapture(e.pointerId); return; } }
    if (hit && sel.has(hit.id)) {
      drag = { type: 'move', items0: snapshot(), p0: p, g: history.gesture('move'), collapse: r.collapseOnUp, toggleOff: r.toggleOffOnUp, moved: false, wantDup: mods.alt && !!adapter.duplicate, axis: null }; container.setPointerCapture(e.pointerId);
    } else if (!hit) { drag = { type: 'marquee' }; marq.begin(p, sel.ids, mods); container.setPointerCapture(e.pointerId); }
    redraw();
  });
  container.addEventListener('pointermove', e => {
    if (!drag) return; const p = adapter.toWorld(e), mods = { shift: e.shiftKey, alt: e.altKey };
    if (drag.type === 'marquee') { const r = marq.update(p, k(), mods); if (r) { marqueeRect = r.rect; sel.set(r.ids); } return; }
    if (drag.type === 'move') {
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y; if (Math.hypot(dx, dy) * k() < dupThreshold && !drag.moved) return;
      if (!drag.moved && drag.wantDup) { drag.g.end(); history.begin('duplicate'); const ids = adapter.duplicate(sel.ids); sel.set(ids); drag.items0 = snapshot(); drag.g = history.gesture('move'); drag.dup = true; }   // Alt-drag copies AFTER 2px, like PhotoCraft
      drag.moved = true; const bypass = (mods.alt && !drag.dup) || e.ctrlKey, grid = adapter.grid ?? 1;
      if (grid && !bypass) { dx = Math.round(dx / grid) * grid; dy = Math.round(dy / grid) * grid; }
      if (mods.shift) { const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI), horiz = ang < 45 || ang > 135, hy = axisHysteresisDeg;   // shift = straight lines with 8deg hysteresis so the lock doesn't flicker at 45
        if (drag.axis == null) drag.axis = horiz ? 'x' : 'y'; else if (drag.axis === 'x' && Math.abs(ang - 90) < 45 - hy) drag.axis = 'y'; else if (drag.axis === 'y' && (ang < 45 - hy || ang > 135 + hy)) drag.axis = 'x';
        if (drag.axis === 'x') dy = 0; else dx = 0; } else drag.axis = null;
      let patch = moveGroup(drag.items0, dx, dy); const moving = new Set(drag.items0.map(i => i.id)), box = groupBox(drag.items0.map(i => ({ ...i, ...patch[i.id] })));
      const s = snapper.move(box, visible().filter(i => !moving.has(i.id)), k(), { bypass }); guides = s.guides; const sdx = drag.axis === 'y' ? 0 : s.dx, sdy = drag.axis === 'x' ? 0 : s.dy; if (sdx || sdy) patch = moveGroup(drag.items0, dx + sdx, dy + sdy);   // an axis lock is never un-locked by a snap
      adapter.patch(patch);
    } else if (drag.type === 'scale') {
      adapter.patch(scaleGroup(drag.items0, drag.box0, drag.h, p, { proportional: proportionalDefault ? !mods.shift : mods.shift, fromCenter: mods.alt, minSize: adapter.minSize ?? 1 }));
    } else if (drag.type === 'rotate') { adapter.patch(rotateGroup(drag.items0, drag.box0, drag.a0, angleOf(center(drag.box0), p), { snapDeg: mods.shift ? 15 : null })); }
    redraw();
  });
  const finish = (cancel = false) => {
    if (!drag) return; const d = drag; drag = null; guides = []; marqueeRect = null;
    if (d.type === 'marquee') { marq.end(); }
    else { if (cancel) { adapter.patch(Object.fromEntries(d.items0.map(i => [i.id, { x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot }]))); d.g.end(); }
      else { if (d.type === 'move' && !d.moved) { if (d.toggleOff != null) sel.remove(d.toggleOff); else if (d.collapse != null) sel.set([d.collapse], d.collapse); } const changed = d.g.end(); if (changed) logEdit(d.type + (d.items0.length > 1 ? '-group' : ''), d.items0); } }
    redraw();
  };
  container.addEventListener('pointerup', () => finish()); container.addEventListener('pointercancel', () => finish(true));

  // ---- commands (also reachable from buttons) ----
  const commit = (label, patches) => { if (!Object.keys(patches).length) return; history.do(label, () => adapter.patch(patches)); redraw(); };
  const api = {
    selection: sel, redraw, flush() { if (nudgeRun) { clearTimeout(nudgeRun.timer); nudgeRun.g.end(); nudgeRun = null; } }, cancel: () => finish(true),
    selectAll: () => sel.selectAll(visible().filter(i => !i.locked).map(i => i.id)), invert: () => sel.invert(visible().filter(i => !i.locked).map(i => i.id)),
    nudge(dx, dy, m = 1) { const s = selected(); if (!s.length) return; const now = performance.now();   // a run of nudges within 700 ms = ONE undo step (PhotoCraft nudge_bundle)
      if (!nudgeRun || now - nudgeRun.t > nudgeMergeMs || nudgeRun.key !== sel.ids.join()) { nudgeRun = { key: sel.ids.join(), g: history.gesture('nudge'), before: snapshot() }; } nudgeRun.t = now; adapter.patch(moveGroup(s, dx * m, dy * m)); clearTimeout(nudgeRun.timer); const run = nudgeRun; run.timer = setTimeout(() => { if (nudgeRun === run) { run.g.end(); logEdit('nudge', run.before); nudgeRun = null; } }, nudgeMergeMs); redraw(); },
    align: mode => commit('align-' + mode, alignP(selected(), mode, sel.size > 1 ? null : adapter.canvas)), distribute: axis => commit('distribute-' + axis, distP(selected(), axis)),
    zorder: cmd => commit('z-' + cmd, zP(adapter.items(), sel.ids, cmd)),
    remove() { if (sel.size && adapter.remove) { history.begin('delete'); adapter.remove(sel.ids); sel.clear(); redraw(); } },
    duplicate() { if (sel.size && adapter.duplicate) { history.begin('duplicate'); sel.set(adapter.duplicate(sel.ids)); redraw(); } },
  };
  const R = registry, G = 'Selection';
  R.register('mod+a', 'Select all', api.selectAll, G).register('mod+shift+i', 'Invert selection', api.invert, G).register('escape', 'Cancel drag / deselect', () => drag ? finish(true) : sel.clear(), G);
  R.register('tab', 'Select next object', () => sel.cycle(visible().map(i => i.id), 1), G).register('shift+tab', 'Select previous object', () => sel.cycle(visible().map(i => i.id), -1), G);
  for (const [key, dx, dy] of [['arrowleft', -1, 0], ['arrowright', 1, 0], ['arrowup', 0, -1], ['arrowdown', 0, 1]]) { R.register(key, 'Nudge selection 1', () => api.nudge(dx, dy, 1), 'Move'); R.register('shift+' + key, 'Nudge selection ×10', () => api.nudge(dx, dy, 10), 'Move'); R.register('alt+' + key, 'Nudge selection ÷4 (fine)', () => api.nudge(dx, dy, .25), 'Move'); }
  [['mod+alt+arrowleft', 'left'], ['mod+alt+arrowright', 'right'], ['mod+alt+arrowup', 'top'], ['mod+alt+arrowdown', 'bottom'], ['mod+alt+c', 'hcenter'], ['mod+alt+m', 'vcenter']].forEach(([c, m]) => R.register(c, 'Align ' + m, () => api.align(m), 'Align'));
  R.register('mod+alt+h', 'Distribute horizontally', () => api.distribute('x'), 'Align').register('mod+alt+v', 'Distribute vertically', () => api.distribute('y'), 'Align');
  R.register('mod+]', 'Bring forward', () => api.zorder('forward'), 'Layer').register('mod+[', 'Send backward', () => api.zorder('backward'), 'Layer').register('mod+shift+]', 'Bring to front', () => api.zorder('front'), 'Layer').register('mod+shift+[', 'Send to back', () => api.zorder('back'), 'Layer');
  if (adapter.remove) { R.register('backspace', 'Delete selection', api.remove, 'Edit').register('delete', 'Delete selection', api.remove, 'Edit'); }
  if (adapter.duplicate) R.register('mod+d', 'Duplicate selection', api.duplicate, 'Edit');
  return api;
}
