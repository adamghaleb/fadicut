const clone = value => JSON.parse(JSON.stringify(value));
const minGap = 1 / 255;
export const evenCuts = n => Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
export function normalizeCuts(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.map((value, i) => {
    const lo = i ? sorted[i - 1] + minGap : minGap;
    const hi = 1 - (sorted.length - i) * minGap;
    return sorted[i] = Math.min(hi, Math.max(lo, value));
  });
}
const tone = hex => {
  const [r, g, b] = hex.slice(1).match(/../g).map(x => {
    const v = parseInt(x, 16) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
};
export function paletteColors(colors, count, black, white) {
  const anchors = [...colors].sort((a, b) => tone(a) - tone(b));
  const inner = count - Number(black) - Number(white);
  const result = Array.from({ length: inner }, (_, i) => {
    if (!anchors.length) {
      const v = Math.round(255 * (i + 1) / (inner + 1)).toString(16).padStart(2, '0');
      return '#' + v.repeat(3);
    }
    return anchors[Math.round((anchors.length - 1) * (inner === 1 ? .5 : i / (inner - 1)))];
  });
  return [...(black ? ['#0a0a0e'] : []), ...result, ...(white ? ['#ffffff'] : [])];
}
export function setBoundary(settings, index, value, unsnapped) {
  const lo = (settings.cuts[index - 1] || 0) + minGap;
  const hi = (settings.cuts[index + 1] || 1) - minGap;
  const target = Math.round(value / .05) * .05;
  const snap = Math.abs(target - value) < .018;
  settings.cuts[index] = Math.min(hi, Math.max(lo, !unsnapped && snap ? target : value));
}
export function gradient(settings) {
  const boundaries = [0, ...settings.cuts, 1];
  return 'linear-gradient(90deg, ' + settings.colors.map((c, i) =>
    c + ' ' + boundaries[i] * 100 + '% ' + boundaries[i + 1] * 100 + '%').join(', ') + ')';
}
export function snapshot(settings) { return clone(settings); }
