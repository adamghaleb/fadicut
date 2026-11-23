// Snapshot undo/redo. Every mutation = one entry; continuous gestures (drag, resize, slider) coalesce into ONE entry.
// state is any JSON-serialisable object you own; the kit never inspects it.
export function createHistory({ getState, setState, cap = 400, onChange = () => {} }) {
  const past = [], future = [], snap = () => JSON.stringify(getState());
  let open = null;                                   // the one open gesture, if any
  const api = {
    begin(label = '') { past.push(snap()); if (past.length > cap) past.shift(); future.length = 0; return label; },
    gesture(label) { if (open) return open; api.begin(label); const before = snap(); open = { label, before, end() { open = null; const changed = snap() !== before; if (!changed) { past.pop(); } onChange('gesture:' + label, changed); return changed; } }; return open; },
    undo() { if (!past.length) return false; future.push(snap()); setState(JSON.parse(past.pop())); onChange('undo'); return true; },
    redo() { if (!future.length) return false; past.push(snap()); setState(JSON.parse(future.pop())); onChange('redo'); return true; },
    do(label, fn) { api.begin(label); fn(); onChange('do:' + label, true); },
    get depth() { return past.length; }, get redoDepth() { return future.length; },
  };
  return api;
}
