// Selection model + the click rules every design tool shares (checked against PhotoCraft's behaviour, see docs/PHOTOCRAFT-NOTES.md).
//   click unselected            -> replace selection
//   shift/⌘-click               -> add it; on an already-selected object: keep (so shift-drag works) and remove on release if no drag
//   click an already-selected   -> keep the group on pointerdown (so you can drag it); if the pointer never moved, collapse to
//                                  that one object on pointerup (the "click inside a group" rule)
//   click empty                 -> clear (unless shift held)
export function createSelection({ onChange = () => {} } = {}) {
  let ids = new Set(), primary = null, anchor = null; const emit = () => onChange([...ids], primary);
  const api = {
    get ids() { return [...ids]; }, get primary() { return primary; }, get size() { return ids.size; }, has: id => ids.has(id),
    set(list, prim) { ids = new Set(list); primary = prim ?? (ids.has(primary) ? primary : [...ids].pop() ?? null); emit(); },
    add(id) { ids.add(id); primary = id; emit(); }, remove(id) { ids.delete(id); if (primary === id) primary = [...ids].pop() ?? null; emit(); },
    toggle(id) { ids.has(id) ? api.remove(id) : api.add(id); }, clear() { if (!ids.size) return; ids.clear(); primary = null; emit(); },
    selectAll(all) { ids = new Set(all); primary = [...ids].pop() ?? null; emit(); },
    invert(all) { const n = all.filter(i => !ids.has(i)); api.set(n); },
    // pointerdown: returns {collapseOnUp: id|null}
    pointerDown(id, { shift = false, meta = false } = {}) {
      if (id == null) { if (!shift) api.clear(); return { collapseOnUp: null }; }
      if (shift || meta) { if (ids.has(id)) { primary = id; emit(); return { collapseOnUp: null, toggleOffOnUp: id }; } api.add(id); return { collapseOnUp: null }; }   // selected + shift: keep it so it can be dragged; remove on release if the pointer never moved
      if (ids.has(id)) { primary = id; emit(); return { collapseOnUp: ids.size > 1 ? id : null }; }
      api.set([id], id); return { collapseOnUp: null };
    },
    // list behaviour (PhotoCraft layers panel): click replaces, mod-click toggles, shift-click selects the RANGE from the anchor in visual order
    listClick(order, id, { shift = false, meta = false } = {}) { if (shift && anchor != null && order.includes(anchor)) { const a = order.indexOf(anchor), b = order.indexOf(id); api.set(order.slice(Math.min(a, b), Math.max(a, b) + 1), id); } else if (meta) { api.toggle(id); anchor = id; } else { api.set([id], id); anchor = id; } },
    cycle(order, dir = 1) { if (!order.length) return; const i = order.indexOf(primary); api.set([order[(i + dir + order.length) % order.length]], order[(i + dir + order.length) % order.length]); },
  };
  return api;
}
