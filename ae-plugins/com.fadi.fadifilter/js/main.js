import { createHistory, createRegistry, createStore, copyObjects, pasteObjects } from '../vendor/fadi-editor-kit/src/index.js';
import { cutoffs } from './histogram.js';
import { evenCuts, normalizeCuts, paletteColors, setBoundary, gradient, snapshot } from './ramp.js';
import { palettes } from './palettes.js';
const el = id => document.getElementById(id);
const initial = { method: 'M2', palette: 'grey', count: 5, softness: 0, black: true, white: true };
let state = { settings: { ...initial, colors: paletteColors([], 5, true, true), cuts: evenCuts(5) }, presets: {} };
let selectedBoundary = 0;
const say = msg => el('status').textContent = msg;
const store = createStore({ key: 'fadi-filter.v1', getState: () => state });
state = store.load() || state;
const history = createHistory({ getState: () => state, setState: next => state = next, onChange: () => { store.schedule(); render(); } });
const edit = (label, fn) => history.do(label, () => fn(state.settings));
const bridge = window.__adobe_cep__ ? new CSInterface() : null;
const host = statement => new Promise((resolve, reject) => {
  if (!bridge) return reject(Error('Open this panel in After Effects to run this action'));
  bridge.evalScript(statement, result => result === 'EvalScript error.' || result.startsWith('ERROR:')
    ? reject(Error(result)) : resolve(result));
});
for (const palette of [{ id: 'grey' }, ...palettes, { id: 'custom' }])
  el('palette').add(new Option(palette.id === 'grey' ? 'Greyscale' : palette.id, palette.id));

function rebuild(settings) {
  const colors = settings.palette === 'custom' ? settings.colors : palettes.find(p => p.id === settings.palette)?.colors || [];
  settings.colors = paletteColors(colors, settings.count, settings.black, settings.white);
  if (settings.cuts.length !== settings.count - 1) settings.cuts = evenCuts(settings.count);
}

function drawRamp(settings) {
  const ramp = el('ramp');
  ramp.style.background = gradient(settings);
  ramp.replaceChildren(...settings.cuts.map((cut, index) => {
    const button = document.createElement('button');
    button.style.left = cut * 100 + '%';
    button.title = 'Boundary ' + (index + 1) + ' · Drag or use arrow keys';
    button.setAttribute('aria-label', button.title);
    button.onfocus = () => selectedBoundary = index;
    button.onpointerdown = event => {
      const gesture = history.gesture('Move boundary');
      const rect = ramp.getBoundingClientRect();
      button.setPointerCapture(event.pointerId);
      const move = next => {
        setBoundary(settings, index, (next.clientX - rect.left) / rect.width, next.altKey);
        button.style.left = settings.cuts[index] * 100 + '%';
        ramp.style.background = gradient(settings);
      };
      const end = () => { button.onpointermove = null; gesture.end(); };
      button.onpointermove = move;
      button.onpointerup = end;
      button.onpointercancel = end;
    };
    return button;
  }));
}
function render() {
  const s = state.settings;
  for (const key of ['method', 'palette', 'count', 'softness']) el(key).value = s[key];
  el('count').disabled = s.method === 'M7';
  for (const key of ['black', 'white']) el(key).checked = s[key];
  drawRamp(s);
  el('colors').replaceChildren(...s.colors.map((color, i) => {
    const field = document.createElement('input');
    field.type = 'color';
    field.value = color;
    field.title = 'Band ' + (i + 1) + ' color';
    field.setAttribute('aria-label', field.title);
    field.disabled = (i === 0 && s.black) || (i === s.colors.length - 1 && s.white);
    field.onchange = () => edit('Change color', next => { next.palette = 'custom'; next.colors[i] = field.value; });
    return field;
  }));
  el('preset').replaceChildren(new Option('Choose preset…', ''), ...Object.keys(state.presets).sort().map(name => new Option(name, name)));
}

for (const key of ['method', 'palette', 'count', 'softness', 'black', 'white']) {
  el(key).onchange = () => edit('Change ' + key, s => {
    const field = el(key);
    s[key] = field.type === 'checkbox' ? field.checked : field.type === 'number'
      ? Math.min(Number(field.max), Math.max(Number(field.min), Math.round(Number(field.value)))) : field.value;
    if (s.method === 'M7') s.count = 2;
    else if (key === 'method' && s.count === 2) s.count = 5;
    if (key !== 'softness') rebuild(s);
  });
}
el('save').onclick = () => {
  const name = el('name').value.trim();
  if (!name) return say('Enter a preset name');
  history.do('Save preset', () => { state.presets = { ...state.presets, [name]: snapshot(state.settings) }; });
  say('Saved ' + name);
};
el('preset').onchange = () => {
  const name = el('preset').value;
  if (name) history.do('Load preset', () => { state.settings = snapshot(state.presets[name]); });
};
async function run(button, action) {
  button.disabled = true;
  try { await action(); }
  catch (error) { say(error.message); }
  finally { button.disabled = false; }
}
el('analyze').onclick = () => run(el('analyze'), async () => {
  say('Sampling the selected layer…');
  const histogram = (await host('fadiFilter_histogram()')).split(',').map(Number);
  if (histogram.length !== 256 || histogram.some(value => !Number.isFinite(value)))
    throw Error('After Effects did not return a tonal sample');
  edit('Analyze frame', s => { s.cuts = normalizeCuts(cutoffs(histogram, s.count, s.method)); });
  say('Cutoffs sampled from the current frame');
});
el('apply').onclick = () => run(el('apply'), async () => {
  const { cuts, colors, softness, method } = state.settings;
  say(await host('fadiFilter_apply(' + [cuts, colors, softness / 100, method].map(x => JSON.stringify(x)).join(',') + ')'));
});
const shortcuts = createRegistry().register('mod+z', 'Undo', () => history.undo())
  .register('mod+shift+z', 'Redo', () => history.redo())
  .register('mod+s', 'Save settings', () => { store.flush(); say('Settings saved'); })
  .register('mod+c', 'Copy settings', () => copyObjects('fadi-filter', state.settings))
  .register('mod+v', 'Paste settings', async () => {
    const next = await pasteObjects('fadi-filter');
    if (next?.cuts?.length === next?.colors?.length - 1) history.do('Paste settings', () => { state.settings = next; });
  })
  .register('arrowleft', 'Nudge boundary left', () => nudge(-1))
  .register('arrowright', 'Nudge boundary right', () => nudge(1))
  .register('shift+/', 'Shortcuts', showHelp).attach();
function nudge(dir) {
  const i = selectedBoundary;
  if (i >= state.settings.cuts.length) return;
  edit('Nudge boundary', s => setBoundary(s, i, s.cuts[i] + .01 * dir, true));
  el('ramp').children[i]?.focus();
}
function showHelp() {
  const dialog = el('shortcuts');
  dialog.textContent = shortcuts.sheetHTML().flatMap(group => group.items)
    .map(row => row.key + '  ' + row.desc).join('\n');
  dialog.style.whiteSpace = 'pre-line';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => dialog.close();
  dialog.append(document.createElement('br'), close);
  if (!dialog.open) dialog.showModal();
}
el('help').onclick = showHelp;
render();
