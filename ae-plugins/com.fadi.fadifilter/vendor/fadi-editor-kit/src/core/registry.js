// ONE shortcut registry: handlers and the `?` cheat sheet are generated from the same table.
const SYM = { BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' };
// Shifted symbols arrive as other characters ('}' for shift+]), so punctuation and digits are read from e.code. Register them as e.g. 'mod+shift+]' or 'shift+/'.
export const normalizeCombo = e => { const sym = SYM[e.code] || (/^Digit\d$/.test(e.code) ? e.code.slice(5) : null), k = sym || (e.key === ' ' ? 'space' : e.key.toLowerCase()), named = sym || k.length > 1 || /[a-z]/.test(k);
  return (e.metaKey || e.ctrlKey ? 'mod+' : '') + (e.shiftKey && named ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + k; };
export const keycap = c => c.replace('mod+', '⌘').replace('shift+', '⇧').replace('alt+', '⌥').replace('arrowleft', '←').replace('arrowright', '→').replace('arrowup', '↑').replace('arrowdown', '↓').replace('space', 'Space').replace('backspace', '⌫').replace('escape', 'Esc').replace('delete', '⌦');
export function createRegistry({ target = window, isEditing = defaultIsEditing } = {}) {
  const rows = [];
  const api = {
    register(combo, desc, fn, group = 'General') { const i = rows.findIndex(r => r.combo === combo); if (i >= 0) rows.splice(i, 1); rows.push({ combo, desc, fn, group }); return api; },   // later registration wins
    unregister(combo) { const i = rows.findIndex(r => r.combo === combo); if (i >= 0) rows.splice(i, 1); },
    rows: () => rows.slice(),
    attach() { target.addEventListener('keydown', e => { const c = normalizeCombo(e), r = rows.find(x => x.combo === c); if (!r) return; if (isEditing() && !c.startsWith('mod+') && c !== 'escape') return; e.preventDefault(); r.fn(e); }); return api; },
    sheetHTML() { const g = {}; rows.forEach(r => (g[r.group] ||= []).push(r)); return Object.entries(g).map(([n, a]) => ({ group: n, items: a.map(r => ({ desc: r.desc, key: keycap(r.combo) })) })); },
  };
  return api;
}
function defaultIsEditing() { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(a.type)) || a.isContentEditable); }
