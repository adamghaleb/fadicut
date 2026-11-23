// Debounced autosave (~800 ms) with write-temp-then-swap, ⌘S flush; plus the TASTE LOG: every committed edit as before/after,
// so the tool's own heuristics can later be retuned from how Adam actually edits.
const safe = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } } };
export function createStore({ key, getState, onSaved = () => {}, delay = 800 }) {
  let timer = null; const write = () => { const s = JSON.stringify(getState()); safe.set(key + '.tmp', s); if (safe.set(key, s)) onSaved(); };
  return { load() { try { return JSON.parse(safe.get(key)); } catch { return null; } }, schedule() { clearTimeout(timer); timer = setTimeout(write, delay); }, flush() { clearTimeout(timer); write(); } };
}
export function createTasteLog({ key, max = 6000, context = () => ({}) }) {
  let rows = []; try { rows = JSON.parse(safe.get(key) || '[]'); } catch { rows = []; }
  return { log(type, detail = {}) { rows.push({ at: new Date().toISOString(), type, ...context(), ...detail }); if (rows.length > max) rows.shift(); safe.set(key, JSON.stringify(rows)); },
    get size() { return rows.length; }, rows: () => rows.slice(), jsonl: () => rows.map(r => JSON.stringify(r)).join('\n'),
    download(name = 'taste.jsonl') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } };
}
