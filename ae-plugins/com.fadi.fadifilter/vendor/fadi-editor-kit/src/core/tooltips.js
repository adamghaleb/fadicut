// Tooltips with keycaps: any element with data-tip="Name|Key". 400 ms delay, hidden during drags.
export function attachTooltips({ delay = 400 } = {}) {
  const tip = document.createElement('div'); tip.style.cssText = 'position:fixed;z-index:9999;background:#111;color:#fff;font:12px "Helvetica Neue",Arial,sans-serif;padding:5px 9px;border-radius:8px;pointer-events:none;white-space:nowrap'; tip.hidden = true; tip.id = 'fk-tip'; document.body.appendChild(tip);
  let t; document.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest('[data-tip]'); clearTimeout(t); if (!el) { tip.hidden = true; return; }
    t = setTimeout(() => { const [n, k] = el.dataset.tip.split('|'); tip.textContent = n; if (k) { const kb = document.createElement('kbd'); kb.textContent = k; kb.style.cssText = 'margin-left:6px;border:1px solid #555;border-radius:4px;padding:0 4px;background:#333;font:11px ui-monospace,Menlo,monospace'; tip.appendChild(kb); } tip.hidden = false; const r = el.getBoundingClientRect(); tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px'; tip.style.top = r.bottom + 8 + 'px'; }, delay); });
  document.addEventListener('pointerdown', () => { tip.hidden = true; clearTimeout(t); }, true);
  return tip;
}
