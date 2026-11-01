// SeeFast launcher UI. Everything shown comes from the plan; text from the analyzed project is only ever set as
// text (never as HTML). The page talks to the app only through window.cr (preload.cjs).
import { PressTracker } from '../out/geometry.js';

const cr = window.cr;
const $ = (id) => document.getElementById(id);
const shell = $('shell');
const bubbleBtn = $('bubble');
const panel = $('panel');
const content = $('content');
const dock = $('dock');
const live = $('live');

/** Create an element: h('div.card', { onclick }, child, 'text'). Strings become text nodes. */
function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Static markup only (icons and the character): never project text. */
function fromMarkup(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

// ---- Icons and the character ------------------------------------------------------------------------------------

const PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  gear: '<path d="M10.33 5.30L10.66 2.49L13.34 2.49L13.67 5.30A6.9 6.9 0 0 1 15.55 6.09L17.78 4.33L19.67 6.22L17.91 8.45A6.9 6.9 0 0 1 18.70 10.33L21.51 10.66L21.51 13.34L18.70 13.67A6.9 6.9 0 0 1 17.91 15.55L19.67 17.78L17.78 19.67L15.55 17.91A6.9 6.9 0 0 1 13.67 18.70L13.34 21.51L10.66 21.51L10.33 18.70A6.9 6.9 0 0 1 8.45 17.91L6.22 19.67L4.33 17.78L6.09 15.55A6.9 6.9 0 0 1 5.30 13.67L2.49 13.34L2.49 10.66L5.30 10.33A6.9 6.9 0 0 1 6.09 8.45L4.33 6.22L6.22 4.33L8.45 6.09A6.9 6.9 0 0 1 10.33 5.30Z"/><circle cx="12" cy="12" r="2.9"/>',
  minus: '<path d="M6 12h12"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M7 7l10 10M17 7L7 17"/>',
  dash: '<path d="M7 12h10"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
  code: '<path d="M8.5 8L4.5 12l4 4M15.5 8l4 4-4 4"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9M10 5H5v14h14v-5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 21H20"/><path d="M8.5 7.5h7M8.5 11h5"/>',
  wand: '<path d="M4 20l11-11"/><path d="M14 4l1 2.5L17.5 7.5 15 8.5 14 11l-1-2.5L10.5 7.5 13 6.5z"/><path d="M19 13l.6 1.4 1.4.6-1.4.6L19 17l-.6-1.4-1.4-.6 1.4-.6z"/>',
  steth: '<path d="M6 3.5v6a5 5 0 0 0 10 0v-6"/><path d="M11 14.5v1.5a4.5 4.5 0 0 0 9 0v-2"/><circle cx="20" cy="12" r="1.8"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.2M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  spinner: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  file: '<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12.5l8-8M16 7.5l2 2"/>',
};
function icon(name, cls = 'ico') {
  return fromMarkup(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ''}</svg>`);
}

// SeeFast's character: an armored sphere robot with one camera eye (it *sees* what a project needs).
// Moods are pure CSS (style.css, .mascot[data-mood]): the eye's glow color, shutter lids, a spinning light ring.
const MASCOT = `
<svg class="mascot" viewBox="0 0 64 64" aria-hidden="true">
  <rect class="module" x="2.4" y="22.5" width="9.6" height="19" rx="3.6"/><rect class="module" x="52" y="22.5" width="9.6" height="19" rx="3.6"/>
  <rect class="glow" x="4.6" y="27.2" width="2.4" height="9.6" rx="1.2"/><rect class="glow" x="57" y="27.2" width="2.4" height="9.6" rx="1.2"/>
  <circle class="shade" cx="32" cy="32.5" r="25.5"/>
  <circle class="shell" cx="30" cy="30" r="23"/>
  <path class="seam" d="M14.4 31.5H7M49.6 31.5H57M20.4 44.5l-5.6 5.8M43.6 44.5l5.6 5.8"/>
  <circle class="seam" cx="32" cy="31.5" r="17.6"/>
  <path class="gleam" d="M11.5 24.5c1.6-5.2 5-9.6 9.6-12.6"/>
  <rect class="glow" x="13.2" y="17" width="2.4" height="6.4" rx="1.2" transform="rotate(40 14.4 20.2)"/>
  <rect class="glow" x="48.4" y="17" width="2.4" height="6.4" rx="1.2" transform="rotate(-40 49.6 20.2)"/>
  <circle class="rivet" cx="16.4" cy="40.6" r="1"/><circle class="rivet" cx="47.6" cy="40.6" r="1"/><circle class="rivet" cx="26.6" cy="10.4" r="1"/><circle class="rivet" cx="37.4" cy="10.4" r="1"/>
  <rect class="vent" x="24.6" y="52" width="14.8" height="5.2" rx="2.6"/>
  <rect class="glow" x="27.4" y="53.8" width="9.2" height="1.6" rx=".8"/>
  <circle class="outline" cx="32" cy="32.5" r="25.5"/>
  <circle class="housing" cx="32" cy="31.5" r="14"/>
  <rect class="notch" x="29.4" y="18.1" width="5.2" height="1.7" rx=".85"/>
  <circle class="lights" cx="32" cy="31.5" r="11.4"/>
  <g class="lens">
    <circle class="glass" cx="32" cy="31.5" r="9.5"/>
    <g class="pupils">
      <circle class="halo" cx="32" cy="31.5" r="7.6"/>
      <circle class="iris" cx="32" cy="31.5" r="5.8"/>
      <circle class="glow" cx="32" cy="31.5" r="3.7"/>
      <circle class="core" cx="32" cy="31.5" r="1.8"/>
      <circle class="glint" cx="35.1" cy="28.1" r="1.9"/><circle class="glint small" cx="28.9" cy="34.7" r=".85"/>
    </g>
    <path class="sheen" d="M25.2 28.6a7.6 7.6 0 0 1 4.2-4.6"/>
  </g>
  <g class="lid-happy"><path class="lid" d="M20.4 35.7Q32 23 43.6 35.7A12.3 12.3 0 0 1 20.4 35.7z"/><path class="lid-edge" d="M20.4 35.7Q32 23 43.6 35.7"/></g>
  <g class="lid-worried"><path class="lid" d="M20.8 26.5Q32 18.5 43.2 26.5A12.3 12.3 0 0 0 20.8 26.5z"/><path class="lid-edge" d="M20.8 26.5Q32 18.5 43.2 26.5"/></g>
</svg>`;
function mascot(mood = 'idle', extra = '') {
  const el = fromMarkup(MASCOT);
  el.dataset.mood = mood;
  if (extra) el.classList.add(...extra.split(' '));
  return el;
}

bubbleBtn.prepend(mascot('idle'));
$('bar-mascot').append(mascot('idle'));
$('back').append(icon('back'));
$('settings-btn').append(icon('gear'));
$('collapse').append(icon('minus'));
const setMood = (mood) => {
  for (const m of [bubbleBtn.querySelector('.mascot'), $('bar-mascot').querySelector('.mascot')]) if (m) m.dataset.mood = mood;
};

// ---- State and words ----------------------------------------------------------------------------------------------

const state = { info: null, plan: null, root: null, view: null, shell: 'posix', doctor: null, changes: null, run: null, error: null };
const say = (msg) => { live.textContent = ''; requestAnimationFrame(() => (live.textContent = msg)); };
const LABEL = {
  node: 'Node.js', php: 'PHP', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby', java: 'Java', dotnet: '.NET', deno: 'Deno', elixir: 'Elixir',
  composer: 'Composer', pnpm: 'pnpm', yarn: 'Yarn', npm: 'npm', bun: 'Bun', uv: 'uv', poetry: 'Poetry', docker: 'Docker', git: 'Git', 'git-lfs': 'Git LFS', make: 'make', just: 'just',
  mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis', mariadb: 'MariaDB', mongodb: 'MongoDB', mailpit: 'Mailpit', meilisearch: 'Meilisearch', memcached: 'Memcached',
};
const label = (n) => LABEL[n] ?? n;
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const ref = (e) => (e.line ? `${e.file}:${e.line}` : e.file);
const versionOf = (r) => {
  const parts = [];
  if (r.rangeText && r.rangeText !== 'any') parts.push(r.rangeText);
  if (r.recommended && r.recommended !== r.rangeText) parts.push(parts.length ? `· ${r.recommended}` : r.recommended);
  return parts.join(' ');
};
const confTag = (c) => (c === 'high' ? null : h(`span.tag.${c === 'medium' ? 'likely' : 'guess'}`, { title: c === 'medium' ? 'Likely: inferred, not stated by the project' : 'A guess: check it' }, c === 'medium' ? 'likely' : 'guess'));

// ---- Shape changes --------------------------------------------------------------------------------------------

const morphMs = () => (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion') ? 0 : 380);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Place the shell inside the window; `instant` skips the transition (used before and after a morph). */
function place(r, instant) {
  if (instant) shell.classList.add('instant');
  shell.style.setProperty('--x', `${r.x}px`);
  shell.style.setProperty('--y', `${r.y}px`);
  shell.style.setProperty('--w', `${r.width}px`);
  shell.style.setProperty('--h', `${r.height}px`);
  if (instant) {
    void shell.offsetWidth;
    shell.classList.remove('instant');
  }
}
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function open(view) {
  const wasBubble = shell.dataset.state === 'bubble';
  const r = await cr.shape(view);
  if (r.mode === 'window') {
    render(view);
    return $('panel-title').focus();
  }
  place(r.from, true);
  render(view);
  panel.hidden = false;
  if (wasBubble) await frame();
  shell.dataset.state = 'panel';
  place(r.to, false);
  await wait(morphMs());
  if (r.settle) {
    await cr.settle();
    place({ x: 0, y: 0, width: r.to.width, height: r.to.height }, true);
  }
  $('panel-title').focus();
}

async function collapse() {
  if (state.info?.mode === 'window') return cr.collapse();
  const target = await cr.collapseTarget();
  if (target) place(target, false);
  shell.dataset.state = 'bubble';
  await wait(morphMs());
  panel.hidden = true;
  await cr.collapse();
  place({ x: 0, y: 0, width: 64, height: 64 }, true);
  bubbleBtn.focus();
}

// ---- Bubble: click vs drag, keyboard, drop -------------------------------------------------------------------

const press = new PressTracker();
let raf = 0;
bubbleBtn.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  bubbleBtn.setPointerCapture(e.pointerId);
  press.down(e.screenX, e.screenY);
});
bubbleBtn.addEventListener('pointermove', (e) => {
  if (!bubbleBtn.hasPointerCapture(e.pointerId)) return;
  if (press.move(e.screenX, e.screenY)) {
    bubbleBtn.classList.add('dragging');
    cr.drag('start', press.startX, press.startY);
    cr.drag('move', e.screenX, e.screenY);
  } else if (press.dragging && !raf) {
    const x = e.screenX;
    const y = e.screenY;
    raf = requestAnimationFrame(() => {
      raf = 0;
      cr.drag('move', x, y);
    });
  }
});
bubbleBtn.addEventListener('pointerup', (e) => {
  if (bubbleBtn.hasPointerCapture(e.pointerId)) bubbleBtn.releasePointerCapture(e.pointerId);
  const r = press.up();
  bubbleBtn.classList.remove('dragging');
  if (r === 'drag-end') cr.drag('end', e.screenX, e.screenY);
  else if (r === 'click') activate();
});
bubbleBtn.addEventListener('pointercancel', () => {
  if (press.up() === 'drag-end') cr.drag('end');
  bubbleBtn.classList.remove('dragging');
});
// Keyboard: Enter/Space activate (the browser turns them into a click with detail 0); arrows move the bubble.
bubbleBtn.addEventListener('click', (e) => { if (e.detail === 0) activate(); });
bubbleBtn.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 50 : 10;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    cr.nudge(d[0], d[1]);
  }
});
bubbleBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); cr.contextMenu(); });
for (const target of [bubbleBtn, document.body]) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); bubbleBtn.classList.add('drop'); document.querySelector('.drop')?.classList.add('over'); });
  target.addEventListener('dragleave', () => { bubbleBtn.classList.remove('drop'); document.querySelector('.drop')?.classList.remove('over'); });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    bubbleBtn.classList.remove('drop');
    const f = e.dataTransfer?.files?.[0];
    const p = f ? cr.pathForFile(f) : '';
    if (p) analyzeFolder(p);
  });
}

async function activate() {
  if (state.plan) return open('analysis');
  const folder = await cr.pickFolder();
  if (folder) analyzeFolder(folder);
}

async function pickAndAnalyze() {
  const f = await cr.pickFolder();
  if (f) analyzeFolder(f);
}

async function analyzeFolder(folder) {
  bubbleBtn.classList.add('busy');
  setMood('busy');
  if (state.view === 'home') render('home', { busy: true });
  say('Looking at ' + folder);
  const r = await cr.analyze(folder);
  bubbleBtn.classList.remove('busy');
  if (r.error) {
    state.plan = null;
    state.error = r.error;
    setMood('worried');
    say('Analysis failed: ' + r.error);
    return open('analysis');
  }
  Object.assign(state, { plan: r.plan, root: r.root, changes: r.changes ?? null, doctor: null, error: null, run: null, qs: null });
  const qs = await cr.quickStart(state.shell).catch(() => null);
  if (qs) state.qs = { shell: state.shell, data: qs };
  say(`Analyzed ${r.plan.meta.rootName}: ${plural(r.plan.summary.projects, 'project')}, ${plural(r.plan.summary.steps, 'step')}.`);
  open('analysis');
}

// ---- Panel chrome ----------------------------------------------------------------------------------------------------

$('collapse').addEventListener('click', collapse);
$('settings-btn').addEventListener('click', () => open('settings'));
const home = () => (state.plan || state.error ? 'analysis' : 'home');
// "What I can read" goes back to the screen it was opened from (home, overview or settings).
const backTarget = () => (state.view === 'support' && state.returnTo ? state.returnTo : home());
$('back').addEventListener('click', () => open(backTarget()));
function openSupport() {
  if (state.view !== 'support') state.returnTo = state.view;
  open('support');
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || shell.dataset.state !== 'panel') return;
  e.preventDefault();
  if (state.view === 'support' || (state.view !== 'analysis' && state.view !== 'home' && (state.plan || state.error))) open(backTarget());
  else if (state.info?.mode !== 'window') collapse();
});

function setTitle(title, sub) {
  $('panel-title').textContent = title;
  $('panel-sub').textContent = sub ?? '';
  $('back').hidden = state.view === 'analysis' || state.view === 'home';
}

let renderSeq = 0;
function render(view, opts) {
  const seq = ++renderSeq;
  // Refreshing the same view (runner events, toggles) keeps the scroll position and does not replay the entrance
  // animations; a new view starts at the top.
  const same = state.view === view;
  const keep = same ? content.scrollTop : 0;
  content.classList.toggle('still', same);
  state.view = view;
  content.replaceChildren();
  dock.replaceChildren();
  dock.hidden = true;
  const done = ({ home: viewHome, analysis: viewAnalysis, manual: viewGuide, auto: viewAuto, doctor: viewDoctor, settings: viewSettings, support: viewSupport }[view] ?? viewHome)(opts);
  const restore = () => { if (seq === renderSeq) content.scrollTop = keep; };
  if (done && typeof done.then === 'function') done.then(restore);
  else restore();
}

function copyButton(text, what = 'command', label = 'Copy') {
  const b = h('button.copy', { type: 'button', 'aria-label': `Copy ${what}` }, icon('copy'), label);
  b.addEventListener('click', async () => {
    await cr.copy(text);
    b.replaceChildren(icon('check'), 'Copied');
    b.classList.add('done');
    say(`Copied ${what}`);
    setTimeout(() => { b.replaceChildren(icon('copy'), label); b.classList.remove('done'); }, 1400);
  });
  return b;
}

function evidenceList(list) {
  if (!list?.length) return null;
  return h('ul.ev', list.slice(0, 6).map((e) => h('li', h(`span.role.${e.role}`, e.role === 'basis' ? 'because' : e.role === 'supports' ? 'agrees' : 'disagrees'), h('code', ref(e)), ' ', e.detail)));
}

function section(title, iconName, ...children) {
  return h('section.pop', h('h2', iconName ? icon(iconName) : null, title), ...children);
}

// ---- Views ------------------------------------------------------------------------------------------------------------

function viewHome(opts = {}) {
  setTitle('SeeFast', 'Offline · reads the project, runs nothing');
  setMood(opts.busy ? 'busy' : 'idle');
  const drop = h('div.drop',
    h('div.muted.small', 'Drop a project folder here, or'),
    h('button.btn.go', { type: 'button', onclick: pickAndAnalyze }, icon('folder'), 'Choose a project folder'),
    h('button.linkish', { type: 'button', onclick: openSupport }, 'Which languages can you read?'));
  content.append(h('div.home.pop',
    mascot(opts.busy ? 'busy' : 'idle', 'bob'),
    h('p.hello', opts.busy ? 'Having a look…' : 'Hi! Show me a project.'),
    h('p', opts.busy ? 'Reading its files. Nothing runs.' : "I'll read its files and tell you what it needs to run. Nothing gets executed."),
    opts.busy ? null : drop));
  if (!opts.busy && state.info?.recent?.length) {
    content.append(section('Recent projects', 'refresh', h('div.recent', state.info.recent.slice(0, 5).map((r) =>
      h('button.recent-item', { type: 'button', onclick: () => analyzeFolder(r.path) }, icon('folder'), h('span', h('strong', r.name), h('span.p', r.path)))))));
  }
}

function heroFor(p) {
  const warnings = p.conflicts.filter((c) => c.severity === 'warning');
  const missing = state.doctor?.summary.missingRequired ?? 0;
  if (!p.projects.length) return { tone: 'bad', mood: 'worried', headline: "I couldn't find a project here", line: 'No package.json, composer.json, go.mod, Makefile… in this folder.' };
  const stack = [...new Set(p.projects.flatMap((x) => x.frameworks.map((f) => f.name)))];
  const what = stack.length ? stack.join(' + ') : [...new Set(p.projects.flatMap((x) => x.ecosystems.filter((e) => e !== 'generic').map(label)))].join(' + ') || 'A project';
  const steps = p.steps.filter((s) => !s.optional).length;
  const line = `${what} · ${plural(steps, 'step')}${p.services.filter((s) => !s.optional).length ? ` · ${plural(p.services.filter((s) => !s.optional).length, 'service')}` : ''}`;
  if (state.doctor && missing) return { tone: 'bad', mood: 'worried', headline: `${plural(missing, 'thing')} missing on this machine`, line };
  if (warnings.length) return { tone: 'warn', mood: 'idle', headline: `Almost ready: ${plural(warnings.length, 'thing')} to check`, line };
  if (state.doctor) return { tone: 'good', mood: 'happy', headline: 'Ready to set up!', line: `${line} · this machine has everything` };
  return { tone: 'good', mood: 'happy', headline: 'Ready to set up!', line };
}

function hero(tone, mood, headline, line) {
  return h('div.hero.pop', { dataset: { tone } }, mascot(mood, 'bob'), h('div', h('p.headline', headline), line ? h('p.line', line) : null));
}

function viewAnalysis() {
  if (state.error) {
    setTitle('Hmm, that did not work', '');
    setMood('worried');
    content.append(hero('bad', 'worried', 'I could not read that folder', state.error), h('button.btn.go.wide', { type: 'button', onclick: pickAndAnalyze }, icon('folder'), 'Choose another folder'));
    return;
  }
  const p = state.plan;
  const hr = heroFor(p);
  setTitle(p.meta.rootName, `Read in ${p.meta.durationMs} ms · offline · nothing executed`);
  setMood(hr.mood);
  content.append(hero(hr.tone, hr.mood, hr.headline, hr.line));
  if (!p.projects.length) {
    for (const u of p.unknowns) content.append(h('div.callout', icon('info'), h('span', u.message, u.suggestion ? ' ' + u.suggestion : '')));
    content.append(h('button.btn.wide', { type: 'button', onclick: pickAndAnalyze }, icon('folder'), 'Choose another folder'));
    return;
  }
  if (state.changes) {
    content.append(h('div.callout.info.pop', icon('refresh'), h('div', h('strong', 'Changed since last time'),
      h('details', h('summary', plural(state.changes.length, 'change')), h('ul.ev', state.changes.slice(0, 10).map((l) => h('li', h('code', l))))))));
  }

  // Quick start, README style. Fetched again when the shell was switched in the guide.
  const qs = state.qs?.shell === state.shell ? state.qs.data : null;
  if (qs?.lines.length) content.append(section('Quick start', 'terminal', ...quickStartCard(qs)));
  else if (!qs) loadQuickStart();

  // Projects
  const projs = p.projects;
  const projRow = (x) => {
    const fw = x.frameworks[0];
    const tone = fw?.id === 'laravel' ? 'var(--coral-soft)' : fw?.id === 'nextjs' ? 'var(--sky-soft)' : x.support === 'generic' ? 'var(--sunk)' : 'var(--grape-soft)';
    const badge = h('span.badge', (fw?.name ?? label(x.ecosystems[0] ?? '?')).slice(0, 2));
    badge.style.background = tone;
    const pms = x.packageManagers.map((m) => label(m.name)).join(' + ');
    const deps = x.dependsOn.filter((d) => d.kind === 'runtime').map((d) => `needs ${d.project}`);
    return h('div.proj', badge, h('div', h('div.name', x.root === '.' ? x.name : x.root),
      h('div.meta', [fw ? `${fw.name}${fw.version ? ' ' + fw.version : ''}` : x.ecosystems.map(label).join(' + '), pms, ...deps, x.support === 'generic' ? 'basic support' : ''].filter(Boolean).join(' · '))));
  };
  const projCard = h('div.card', projs.slice(0, 4).map(projRow));
  if (projs.length > 4) projCard.append(h('details', h('summary', `${projs.length - 4} more`), projs.slice(4).map(projRow)));
  content.append(section(projs.length === 1 ? 'Project' : `${projs.length} projects`, 'folder', projCard));

  // What the machine needs
  const doc = state.doctor ? new Map(state.doctor.checks.map((c) => [c.id, c])) : null;
  const dotFor = (id) => {
    const c = doc?.get(id);
    if (!c) return null;
    return h(`span.dot.${c.status === 'ok' ? 'ok' : c.status === 'missing' || c.status === 'wrong-version' ? 'bad' : 'warn'}`, { title: c.message });
  };
  const reqs = p.requirements.filter((r) => !r.optional && r.kind !== 'extension');
  const exts = p.requirements.filter((r) => !r.optional && r.kind === 'extension');
  const svcs = p.services.filter((s) => !s.optional);
  const chips = h('div.chips',
    reqs.map((r) => h('span.chip.tool', { title: r.why }, dotFor(r.id), label(r.name), versionOf(r) ? h('span.v', versionOf(r)) : null, confTag(r.confidence))),
    exts.length ? h('span.chip.tool', { title: exts.map((e) => e.name).join(', ') }, doc ? (exts.every((e) => doc.get(e.id)?.status === 'ok') ? h('span.dot.ok') : h('span.dot.bad')) : null, `${plural(exts.length, 'PHP extension')}`) : null,
    svcs.map((s) => h('span.chip.svc', { title: s.why }, dotFor(s.id), label(s.name), s.version ? h('span.v', s.version) : null, s.provider ? h('span.v', '· Docker') : null, confTag(s.confidence))));
  const optional = [...p.requirements.filter((r) => r.optional).map((r) => label(r.name)), ...p.services.filter((s) => s.optional).map((s) => label(s.name))];
  const missing = state.doctor?.summary.missingRequired ?? 0;
  const needCard = h('div.card', chips,
    optional.length ? h('div.note', h('strong', 'Optional: '), optional.join(', ')) : null,
    h('div.need-foot',
      h('details', h('summary', 'Why these?'),
        exts.length ? h('p.why', h('strong', 'PHP extensions: '), exts.map((e) => e.name).join(', ')) : null,
        h('ul.ev', [...reqs, ...svcs].map((r) => h('li', h('strong', label(r.name) + ': '), r.why)))),
      h('button.btn.small', { type: 'button', onclick: () => open('doctor') }, icon('steth'),
        !state.doctor ? 'Check my machine' : missing ? `${plural(missing, 'thing')} missing: see fixes` : 'Machine checked: all good')));
  content.append(section("You'll need", 'key', needCard));

  // Heads-up
  const warnings = p.conflicts.filter((c) => c.severity === 'warning');
  const notes = [...p.conflicts.filter((c) => c.severity === 'info'), ...p.unknowns];
  if (warnings.length || notes.length) {
    const box = h('div');
    for (const c of warnings.slice(0, 3)) box.append(h('div.callout', icon('alert'), h('span', c.message)));
    const rest = [...warnings.slice(3), ...notes];
    if (rest.length) box.append(h('details', h('summary', plural(rest.length, warnings.length ? 'more note' : 'note')), ...rest.map((x) => h('div.callout.info', icon('info'), h('span', x.message, x.suggestion ? ' ' + x.suggestion : '')))));
    content.append(section('Heads-up', 'alert', box));
  }

  content.append(h('div.center.links', h('button.linkish', { type: 'button', onclick: pickAndAnalyze }, 'Look at another folder'), h('button.linkish', { type: 'button', onclick: openSupport }, 'What can SeeFast read?')));

  // The two ways to set up stay at the bottom of the panel.
  const steps = p.steps.filter((s) => !s.optional).length;
  dock.append(
    h('button.btn.guide', { type: 'button', title: `${plural(steps, 'step')} to copy and run at your own pace`, onclick: () => open('manual') }, icon('book'), 'Guide me'),
    h('button.btn.go', { type: 'button', title: 'SeeFast runs the steps and asks before each command', onclick: () => open('auto') }, icon('wand'), 'Do it for me'));
  dock.hidden = false;
}

// Guide: steps to tick off, with copy buttons.
const doneKey = () => `seefast.done.${state.plan?.digest}`;
function loadDone() {
  try {
    return new Set(JSON.parse(localStorage.getItem(doneKey()) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveDone(set) {
  try {
    localStorage.setItem(doneKey(), JSON.stringify([...set]));
  } catch {
    /* per-viewer convenience only */
  }
}

function flagsOf(s) {
  const f = [];
  if (s.network) f.push(h('span.flag', { title: 'Downloads packages or images' }, icon('globe'), 'downloads'));
  if (s.thirdPartyCode && s.action.type === 'exec') f.push(h('span.flag', { title: 'Runs code from the project or its dependencies' }, icon('code'), 'runs code'));
  if (s.outsideProject) f.push(h('span.flag.outside', { title: 'Changes things outside this folder' }, icon('out'), 'outside this folder'));
  return f.length ? h('div.flags', f) : null;
}

// Rendered commands are cached so re-rendering a view never flashes empty while waiting on the main process.
const cmdCache = new Map();
function commandFor(action) {
  const k = `${state.shell}|${JSON.stringify(action)}`;
  if (!cmdCache.has(k)) cmdCache.set(k, cr.renderAction(action, state.shell));
  return cmdCache.get(k);
}

async function stepCard(s, n, done, onChange) {
  const on = done.has(s.id);
  const li = h('li.step' + (on ? '.done' : ''));
  const num = h('button.num', { type: 'button', title: 'Tick it off' });
  const paint = (isDone) => {
    li.classList.toggle('done', isDone);
    num.replaceChildren(isDone ? icon('check') : String(n));
    num.setAttribute('aria-pressed', String(isDone));
    num.setAttribute('aria-label', `Step ${n}: mark as ${isDone ? 'not done' : 'done'}`);
  };
  paint(on);
  num.addEventListener('click', () => {
    const now = !done.has(s.id);
    now ? done.add(s.id) : done.delete(s.id);
    saveDone(done);
    paint(now);
    onChange();
  });
  li.append(...[num, h('div.step-title', h('span', s.title), confTag(s.confidence)), flagsOf(s)].filter(Boolean));
  if (s.action.type === 'manual') li.append(h('div.callout.info', icon('info'), h('span', s.action.text)));
  else {
    const cmd = await commandFor(s.action);
    li.append(h('div.cmd', s.cwd !== '.' ? h('span.cwd.mono', { title: `Run in ${s.cwd}/` }, s.cwd + '/') : null, h('code', cmd), copyButton(cmd)));
  }
  const fill = s.notes.find((x) => /^Then fill in/.test(x));
  if (fill) li.append(h('div.note', h('strong', 'Then fill in: '), fill.replace(/^Then fill in:?\s*/, '')));
  const names = s.notes.find((x) => /^Names only/.test(x));
  if (names) li.append(h('div.note', h('strong', 'Names only, no values: '), names.replace(/^Names only, no values:\s*/, '')));
  const other = s.notes.filter((x) => x !== fill && x !== names);
  li.append(h('details', h('summary', 'Why?'), h('p.why', s.why), other.length ? h('ul.ev', other.map((x) => h('li', x))) : null, evidenceList(s.evidence)));
  return li;
}

function shellToggle(onChange) {
  const mk = (k, text) => h('button', { type: 'button', 'aria-pressed': String(state.shell === k), onclick: () => { state.shell = k; onChange(); } }, text);
  return h('div.seg', { role: 'group', 'aria-label': 'Command shell' }, mk('posix', 'Mac / Linux'), mk('powershell', 'PowerShell'));
}

// Quick start: `cd`, installs, start, built by the library from the plan. Required steps it leaves out are counted
// in a "more steps first" line; "Copy all" only appears when nothing was left out and one terminal is enough.
async function loadQuickStart() {
  const { plan, shell } = state;
  const data = await cr.quickStart(shell).catch(() => null);
  if (!data || state.plan !== plan || state.shell !== shell) return;
  state.qs = { shell, data };
  if (state.view === 'analysis') render('analysis');
}

function quickStartCard(qs) {
  const bar = h('div.qbar', h('span.dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span.qname', state.shell === 'powershell' ? 'PowerShell' : 'Terminal'),
    qs.text ? copyButton(qs.text, 'all quick start commands', 'Copy all') : null);
  const lines = h('div.qlines');
  for (const l of qs.lines) {
    if (l.kind === 'more-steps') {
      lines.append(h('div.qgap', h('span.qdots', { 'aria-hidden': 'true' }, '⋯'),
        h('span', h('strong', `${plural(l.count, 'more step')} first`), l.what.length ? `: ${l.what.join(', ')}` : ''),
        h('button.linkish', { type: 'button', onclick: () => open('manual') }, 'Guide me')));
    } else if (l.kind === 'terminal') {
      lines.append(h('div.qterm', l.n === 2 ? 'In a second terminal' : `In terminal ${l.n}`));
    } else {
      lines.append(h(`div.ql.is-${l.kind}`, l.title ? { title: l.title } : {},
        h('code', l.text),
        l.kind === 'start' && l.port ? h('span.port', { title: l.portConfidence === 'high' ? 'Where it serves' : 'Where it probably serves' }, `localhost:${l.port}`) : null,
        l.confidence ? confTag(l.confidence) : null,
        lineCopy(l.text)));
    }
  }
  const out = [h('div.qs', { role: 'group', 'aria-label': 'Quick start commands' }, bar, lines)];
  if (qs.noStart) out.push(h('div.note', 'No start command found in the scripts, task files or docs.'));
  else if (qs.moreTargets) out.push(h('div.note', `${plural(qs.moreTargets, 'more start command')} in `, h('button.linkish', { type: 'button', onclick: () => open('manual') }, 'Guide me'), '.'));
  return out;
}

function lineCopy(text) {
  const b = h('button.lcopy', { type: 'button', title: 'Copy', 'aria-label': `Copy: ${text}` }, icon('copy'));
  b.addEventListener('click', async () => {
    await cr.copy(text);
    b.replaceChildren(icon('check'));
    b.classList.add('done');
    say('Copied ' + text);
    setTimeout(() => { b.replaceChildren(icon('copy')); b.classList.remove('done'); }, 1400);
  });
  return b;
}

async function viewGuide() {
  const p = state.plan;
  const required = p.steps.filter((x) => !x.optional);
  const optional = p.steps.filter((x) => x.optional);
  const done = loadDone();
  setTitle('Guide me', `${p.meta.rootName} · copy, run, tick off`);
  const doneText = h('strong');
  const fill = h('i');
  const bar = h('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(required.length), 'aria-label': 'Steps done' }, fill);
  const progress = () => {
    const count = required.filter((s) => done.has(s.id)).length;
    const all = count === required.length && required.length > 0;
    doneText.textContent = all ? 'All done! Time to start it.' : `${count} of ${required.length} done`;
    fill.style.width = `${required.length ? (100 * count) / required.length : 0}%`;
    bar.setAttribute('aria-valuenow', String(count));
    setMood(all ? 'happy' : 'idle');
  };
  progress();
  const seq = renderSeq;
  const frag = document.createDocumentFragment();
  frag.append(h('div.pop.stack', h('div.between', doneText, shellToggle(() => render('manual'))), bar));
  const ol = h('ol.steps');
  for (let i = 0; i < required.length; i++) ol.append(await stepCard(required[i], i + 1, done, progress));
  frag.append(section('Steps', 'book', ol));
  if (optional.length) {
    const ol2 = h('ol.steps');
    for (let i = 0; i < optional.length; i++) ol2.append(await stepCard(optional[i], required.length + i + 1, done, progress));
    frag.append(h('details.pop', h('summary', `Optional extras (${optional.length})`), ol2));
  }
  const runs = p.run.filter((r) => r.primary && (r.kind === 'dev' || r.kind === 'worker'));
  if (runs.length) {
    const box = h('div.card.stack');
    for (const r of runs) {
      const cmd = await commandFor(r.action);
      box.append(h('div', h('div.small', h('strong', r.title), r.ports.length ? h('span.muted', ` → localhost:${r.ports[0].port}`) : null), h('div.cmd', r.cwd !== '.' ? h('span.cwd.mono', { title: `Run in ${r.cwd}/` }, r.cwd + '/') : null, h('code', cmd), copyButton(cmd))));
    }
    frag.append(section('Then start it', 'play', box));
  }
  const vars = p.env.flatMap((e) => e.vars.filter((v) => v.fill === 'user').map((v) => ({ e, v })));
  if (vars.length) {
    frag.append(section('Fill in these values', 'key', h('div.card', h('div.chips', vars.map(({ v }) => h('span.chip', { title: v.note ?? '' }, v.name, v.secret ? h('span.v', '· secret') : null))),
      h('div.note', `In ${[...new Set(vars.map(({ e }) => e.file))].join(', ')}. SeeFast never reads or writes these values.`))));
  }
  frag.append(h('div.center', h('button.btn.small', { type: 'button', onclick: writeSetupMd }, icon('file'), 'Save as SETUP.md')));
  if (seq === renderSeq) content.replaceChildren(frag);
}

async function writeSetupMd() {
  const r = await cr.writeSetupMd();
  if (r.file) say('Wrote ' + r.file);
  else if (r.error) say(r.error);
}

// Do it for me: everything is shown first; nothing runs until you say so.
function runState() {
  return (state.run ??= { statuses: {}, messages: {}, output: '', running: false, consent: null, result: null, current: null, opts: { dryRun: false, includeOptional: false, allowOutside: false, approveAll: false } });
}

function speech(run, p) {
  const n = p.steps.filter((s) => (run.opts.includeOptional || !s.optional)).length;
  const res = run.result;
  if (run.stopping) return ['busy', h('span', h('strong', 'Stopping…'), ' Ending the command that is running. Nothing else will start.')];
  if (run.consent) {
    const asked = p.steps.find((x) => x.id === run.consent.step);
    if (asked?.action.type === 'env-names') return ['idle', h('span', `Want me to create ${asked.action.path} for you? `, h('strong', 'It is highlighted below.'))];
    return ['idle', h('span', 'Can I run this one? ', h('strong', 'It is highlighted below.'))];
  }
  if (run.running) {
    const s = p.steps.find((x) => x.id === run.current);
    return ['busy', h('span', 'Working on ', h('strong', s ? s.title : 'it'), '…', run.approved ? ' I will keep going until every step is done.' : '')];
  }
  if (res?.status === 'success') return ['happy', h('span', h('strong', 'All set!'), ' Your project is ready. Want me to start it?')];
  if (res?.status === 'dry-run') return ['happy', h('span', h('strong', 'Preview done: nothing was executed.'), ' That is everything I would run. Press Start when you are ready.')];
  if (res && (res.status === 'stopped' || res.status === 'declined')) return ['idle', h('span', h('strong', 'Stopped.'), ' Nothing else ran. Press Resume to continue where I left off.')];
  if (res && res.status !== 'success') return ['worried', h('span', h('strong', `Step ${res.failed ?? ''} failed.`), ' The output is below. Fix it, then press Resume and I will continue from there.')];
  return ['idle', h('span', `I'll run these `, h('strong', plural(n, 'command')), ' in this folder. ', run.opts.approveAll ? 'You reviewed them, so I will not ask each time.' : 'I will ask before each one.')];
}

async function viewAuto() {
  const p = state.plan;
  const run = runState();
  const seq = renderSeq;
  setTitle('Do it for me', `${p.meta.rootName} · nothing runs without your OK`);
  // Optional steps are listed when included or once they have a result; the step being asked about always is.
  // Creating the env file from variable names is always offered (it is asked about even when extras are off).
  const offered = (s) => s.action.type === 'env-names';
  const shown = p.steps.filter((s) => !s.optional || offered(s) || run.opts.includeOptional || run.consent?.step === s.id || (run.statuses[s.id] && run.statuses[s.id] !== 'skipped'));
  // Every command is on screen before anything runs (the consent prompt repeats the one about to run). Writing an
  // env file is described by what goes into it rather than by the long shell line that would do the same.
  const describe = (s) => (s.action.type === 'manual' ? s.action.text : offered(s) ? `${s.action.path}: ${plural(s.action.names.length, 'variable name')}, no values` : null);
  const cmds = await Promise.all(shown.map((s) => describe(s) ?? commandFor(s.action)));
  if (seq !== renderSeq) return;
  const [mood, words] = speech(run, p);
  setMood(mood);
  content.append(h('div.say.pop', mascot(mood, run.running ? '' : 'bob'), h('div.words', words)));
  if (!run.result && !run.running) {
    content.append(h('div.callout.pop', icon('alert'), h('span', h('strong', 'Only for projects you trust. '), 'Installing packages runs code written by their authors. Nothing runs as administrator.')));
  }
  const res = run.result;
  const list = h('ol.timeline.pop', { 'aria-label': 'Steps' });
  shown.forEach((s, i) => {
    const st = run.statuses[s.id] ?? '';
    const asking = run.consent?.step === s.id;
    const now = st === 'running';
    const glyph = st === 'done' || st === 'already-done' ? icon('check') : st === 'failed' || st === 'refused' ? icon('cross') : st === 'skipped' || st === 'declined' || st === 'stopped' ? icon('dash') : now ? icon('spinner', 'ico spin') : st ? null : String(i + 1);
    const body = h('div',
      h('div.t', s.title, s.optional ? h('span.tag.likely', 'optional') : null, s.outsideProject ? h('span.tag.guess', 'outside this folder') : null),
      h('code', { title: cmds[i] }, s.cwd !== '.' && s.action.type !== 'manual' ? `${s.cwd}/ ` : '', asking && !offered(s) ? run.consent.command : cmds[i]),
      // The running step says so in words, with a moving bar, a clock and the latest line of output.
      now ? h('div.live', { role: 'status' }, h('div.busybar', { 'aria-hidden': 'true' }),
        h('div.live-line', h('span.clock', run.stopping ? 'Stopping' : 'Running', ' · ', h('span', { dataset: { since: String(run.stepStarted?.[s.id] ?? Date.now()) } }, '0:00')),
          h('span.tail', lastLine(run.output) || 'Starting…'))) : null,
      run.messages[s.id] ? h('div.msg', run.messages[s.id]) : null);
    if (asking && offered(s)) {
      // "Create it for me" or "I'll do it myself": the file gets the names below, commented out, and no values.
      const a = s.action;
      body.append(h('div.ask', { role: 'group', 'aria-label': `Create ${a.path}?` },
        h('span.q', `Create ${a.path} with these names for you? No values are written: you fill them in afterwards.`),
        h('div.files.names', a.names.join('  ')),
        h('button.btn.small.go', { type: 'button', onclick: () => answer('yes') }, icon('file'), 'Create it for me'),
        h('button.btn.small', { type: 'button', onclick: () => answer('skip') }, "I'll do it myself"),
        h('button.btn.small.danger', { type: 'button', onclick: () => answer('quit') }, 'Stop')));
    } else if (asking) {
      const c = run.consent;
      body.append(h('div.ask', { role: 'group', 'aria-label': `Approve ${s.title}` },
        h('span.q', c.reason === 'outside-project' ? 'This one changes things outside this folder. Run it?' : c.reason === 'optional' ? 'This one is optional. Run it?' : c.reason === 'manual' ? 'Do this by hand, then continue.' : 'Run this one?'),
        h('button.btn.small.go', { type: 'button', onclick: () => answer('yes') }, c.reason === 'manual' ? 'Done' : 'Run'),
        h('button.btn.small', { type: 'button', onclick: () => answer('skip') }, 'Skip'),
        c.reason ? null : h('button.btn.small', { type: 'button', onclick: () => answer('all') }, 'Run all the rest'),
        h('button.btn.small.danger', { type: 'button', onclick: () => answer('quit') }, 'Stop')));
    }
    list.append(h('li.tl' + (asking ? '.current' : '') + (now ? '.running' : ''), { dataset: { status: st } }, h('span.st', glyph), body));
  });
  content.append(section(`What I'll run (${shown.length})`, 'terminal', list));

  const sw = (key, title, small, invert = false) => {
    const input = h('input', { type: 'checkbox', role: 'switch', checked: invert ? !run.opts[key] : run.opts[key], disabled: run.running });
    input.addEventListener('change', () => { run.opts[key] = invert ? !input.checked : input.checked; render('auto'); });
    return h('label.switch', input, h('span.txt', title, small ? h('small', small) : null));
  };
  const optional = p.steps.filter((s) => s.optional).length;
  const outsideSteps = p.steps.filter((s) => s.outsideProject);
  const outside = outsideSteps.length > 0;
  const dockerOnly = outside && outsideSteps.every((s) => s.action.type === 'exec' && s.action.argv[0] === 'docker');
  content.append(h('details.pop', { open: run.showOptions }, h('summary', 'Options'), h('div.card.toggles',
    sw('approveAll', 'Ask before each step', 'Off: run the commands above without asking', true),
    optional ? sw('includeOptional', `Include optional extras (${optional})`, 'Seeding demo data, production builds…') : null,
    outside ? sw('allowOutside', dockerOnly ? 'Allow Docker services' : 'Allow changes outside this folder', dockerOnly ? 'Starts containers, which live outside this folder' : outsideSteps.map((s) => s.title).join(', ')) : null)));
  content.lastChild.addEventListener('toggle', (e) => (run.showOptions = e.target.open));

  if (run.output) {
    const failed = res && res.status === 'failed';
    const d = h('details.pop', { open: failed || run.showOutput }, h('summary', 'Terminal output'), h('pre.out', { 'aria-label': 'Command output' }, run.output.slice(-12000)));
    d.addEventListener('toggle', () => (run.showOutput = d.open));
    content.append(d);
  }
  if (run.start) {
    content.append(section('Running', 'play', h('div.card', run.start.map((t) => h('div.proj',
      h(`span.dot.${['responding', 'listening', 'stays-up'].includes(t.level) ? 'ok' : t.level ? 'bad' : 'warn'}`),
      h('div', h('div.name', t.id), h('div.meta', t.detail ?? 'starting…')))))));
  }

  // The buttons stay at the bottom of the panel, whatever the scroll position. While it runs, the dock shows where
  // it is (step x of n, elapsed time, one segment per step) next to Stop.
  if (run.running) {
    const at = shown.findIndex((s) => s.id === run.current);
    const finished = (s) => ['done', 'already-done', 'skipped', 'declined'].includes(run.statuses[s.id]);
    const segs = h('div.segs', { 'aria-hidden': 'true' }, shown.map((s) => h('i' + (finished(s) ? '.done' : run.statuses[s.id] === 'failed' ? '.bad' : s.id === run.current ? '.now' : ''))));
    const where = run.stopping ? 'Stopping…' : run.consent ? 'Waiting for your OK' : at >= 0 ? `Step ${at + 1} of ${shown.length}` : 'Starting…';
    dock.append(h('div.runstat', { role: 'status', 'aria-label': `${where}, ${shown.filter(finished).length} of ${shown.length} steps finished` },
      h('div.top', h('span', where, run.consent && !run.stopping ? h('button.linkish.show', { type: 'button', onclick: () => showAttention('smooth') }, 'Show') : null),
        h('span.clock', { dataset: { since: String(run.startedAt) } }, clock(Date.now() - run.startedAt))), segs));
    dock.append(run.stopping
      ? h('button.btn.danger.stopping', { type: 'button', disabled: true, 'aria-live': 'polite' }, icon('spinner', 'ico spin'), 'Stopping…')
      : h('button.btn.danger', { type: 'button', onclick: stopRun }, icon('stop'), 'Stop'));
  } else {
    if (res && (res.status === 'failed' || res.status === 'declined' || res.status === 'stopped')) dock.append(h('button.btn.go', { type: 'button', onclick: () => startRun(true) }, icon('play'), 'Resume'));
    else if (res?.status === 'success') dock.append(h('button.btn.go', { type: 'button', onclick: startApp }, icon('play'), 'Start the app'));
    else dock.append(h('button.btn.go', { type: 'button', onclick: () => startRun(false) }, icon('play'), 'Start'));
    dock.append(h('button.btn', { type: 'button', title: 'Walk through every step without running anything', onclick: () => startRun(false, true) }, icon('terminal'), 'Preview'));
  }
  dock.hidden = false;
  const o = content.querySelector('pre.out');
  if (o) o.scrollTop = o.scrollHeight;
  tickClocks();
  // Bring the step that needs attention into view once, when it changes; otherwise leave the scroll alone.
  const focusId = run.consent?.step ?? run.current;
  if (focusId && focusId !== run.shownStep) {
    requestAnimationFrame(() => {
      if (seq !== renderSeq) return; // a newer render takes over (and tries again)
      if (showAttention()) run.shownStep = focusId;
    });
  }
}

/** Scroll the step asking for approval (or running) into view; false when it is not on screen yet. */
function showAttention(behavior = 'auto') {
  const el = content.querySelector('.tl.current') ?? content.querySelector('.tl.running');
  el?.scrollIntoView({ block: 'nearest', behavior });
  return Boolean(el);
}

/** m:ss (or h:mm:ss) */
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const hms = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  return hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}` : `${hms[1]}:${String(hms[2]).padStart(2, '0')}`;
}
/** Update every running clock in place (no re-render, so nothing moves). */
function tickClocks() {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = clock(Date.now() - Number(el.dataset.since));
}
let clockTimer = 0;

/** The latest line of output, as a terminal would show it (after carriage returns, without colour codes). */
function lastLine(out) {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].split('\r').filter(Boolean).pop()?.trim() ?? '';
    if (l && !l.startsWith('$ ')) return l;
    if (l.startsWith('$ ')) return '';
  }
  return '';
}
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

function stopRun() {
  const run = state.run;
  if (!run?.running || run.stopping) return;
  run.stopping = true;
  say('Stopping');
  cr.stop();
  render('auto');
}

function answer(d) {
  const c = state.run.consent;
  if (!c) return;
  state.run.consent = null;
  if (d === 'all') state.run.approved = true;
  if (d === 'quit') state.run.stopping = true;
  cr.consent(c.id, d);
  render('auto');
}

async function startRun(resume, dryRun = false) {
  const run = runState();
  Object.assign(run, { running: true, stopping: false, result: null, statuses: resume ? run.statuses : {}, messages: resume ? run.messages : {}, output: resume ? run.output : '', current: null, shownStep: null, startedAt: Date.now(), stepStarted: {}, approved: run.opts.approveAll });
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClocks, 1000);
  render('auto');
  const res = await cr.runSetup({ ...run.opts, dryRun, resume });
  clearInterval(clockTimer);
  run.running = false;
  run.stopping = false;
  run.consent = null;
  run.result = res.error ? { status: 'failed', failed: res.error } : res;
  say(res.status === 'success' ? 'Setup finished' : res.status === 'dry-run' ? 'Preview done: nothing was executed' : `Setup ${res.status ?? 'failed'}`);
  if (state.view === 'auto') render('auto');
}

async function startApp() {
  state.run.start = state.plan.run.filter((r) => r.primary && (r.kind === 'dev' || r.kind === 'worker')).map((r) => ({ id: r.id }));
  render('auto');
  await cr.startApp();
}

/** The runner speaks CLI (flags); say the same thing in terms of this window. */
function friendly(msg) {
  return msg
    .replace(/;? ?\(?use --include-optional\)?/, ': turn on optional extras in Options')
    .replace(/:? ?needs --allow-outside or a separate yes/, ': turn it on in Options, or say yes when asked')
    .replace(/ ?\(use --allow-outside\)/, ' (turn it on in Options)');
}

let renderQueued = false;
function rerenderAuto() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (state.view === 'auto') render('auto'); });
}

cr.on('runner', (e) => {
  const run = state.run;
  if (!run) return;
  if (e.type === 'consent') { run.consent = e; say(`Approval needed: ${e.command}`); }
  else if (e.type === 'step-start') { run.statuses[e.step] = 'running'; run.current = e.step; (run.stepStarted ??= {})[e.step] = Date.now(); run.output += `\n$ ${e.command}\n`; say(`Running ${e.step}`); }
  else if (e.type === 'output') { run.output += e.chunk.replace(ANSI, ''); if (run.output.length > 50000) run.output = run.output.slice(-40000); }
  else if (e.type === 'step-end') {
    // A step ended by Stop is reported as failed with the message "stopped": show it as stopped.
    run.statuses[e.step] = e.status === 'dry-run' ? '' : e.status === 'failed' && e.message === 'stopped' ? 'stopped' : e.status;
    if (e.message) run.messages[e.step] = friendly(e.message);
    if (e.message) run.output += `# ${e.step}: ${e.status} (${e.message})\n`;
  } else if (e.type === 'warning') run.output += `! ${e.message}\n`;
  else if (e.type === 'manual') run.output += `→ ${e.text}\n`;
  rerenderAuto();
});
cr.on('start', (e) => {
  const list = state.run?.start;
  if (!list) return;
  if (e.type === 'ready') { const t = list.find((x) => x.id === e.target); if (t) Object.assign(t, { level: e.level, detail: e.detail }); say(`${e.target}: ${e.level}`); }
  else if (e.type === 'output') state.run.output += e.chunk;
  else if (e.type === 'warning') state.run.output += `! ${e.message}\n`;
  rerenderAuto();
});

async function viewDoctor() {
  setTitle('Check my machine', 'Only fixed, read-only version commands');
  if (!state.doctor) {
    setMood('busy');
    content.append(h('div.home.pop', mascot('busy', 'bob'), h('p.hello', 'Checking this machine…'), h('p', 'Asking your tools for their versions. Nothing gets installed.')));
    state.doctor = await cr.doctor();
    if (state.view === 'doctor') render('doctor');
    return;
  }
  const d = state.doctor;
  const bad = d.checks.filter((c) => c.required && (c.status === 'missing' || c.status === 'wrong-version'));
  const warn = d.checks.filter((c) => c.status === 'warning' || (!c.required && (c.status === 'missing' || c.status === 'wrong-version')));
  const unknown = d.checks.filter((c) => c.status === 'unknown');
  const good = d.checks.filter((c) => c.status === 'ok');
  const machine = `${d.machine.distro ?? d.machine.family} · ${d.machine.platform}/${d.machine.arch}`;
  setTitle('Check my machine', machine);
  setMood(bad.length ? 'worried' : 'happy');
  content.append(bad.length
    ? hero('bad', 'worried', `${plural(bad.length, 'thing')} to fix`, good.length ? `${plural(good.length, 'thing')} already look good.` : machine)
    : hero('good', 'happy', 'This machine has everything!', warn.length ? `${plural(warn.length, 'small thing')} worth a look below.` : machine));
  const fixCard = (c) => h('div.fix', h('div.t', h(`span.dot.${c.required && (c.status === 'missing' || c.status === 'wrong-version') ? 'bad' : 'warn'}`), c.title, !c.required && c.kind !== 'env' && c.kind !== 'port' && c.kind !== 'machine' ? h('span.tag.likely', 'optional') : null),
    h('div.m', c.message), c.advice.map((a) => h('div.cmd', h('code', a), copyButton(a, 'fix'))));
  if (bad.length) content.append(section('Fix these', 'alert', h('div', bad.map(fixCard))));
  if (warn.length) content.append(section('Worth a look', 'info', h('div', warn.map(fixCard))));
  if (good.length) {
    content.append(h('details.pop', h('summary', `${plural(good.length, 'thing')} look good`),
      h('div.chips', { style: null }, good.map((c) => h('span.chip.ok', { title: c.message }, h('span.dot.ok'), c.title)))));
  }
  const notes = [...d.checks.filter((c) => c.status === 'info'), ...unknown];
  if (notes.length) content.append(h('details.pop', h('summary', plural(notes.length, 'note')), notes.map((c) => h('div.note', h('strong', c.title + ': '), c.message))));
  content.append(h('details.pop', h('summary', `Checked with ${plural(d.probes.filter((x) => x.ran).length, 'read-only command')}`),
    h('ul.ev', d.probes.filter((x) => x.ran).map((x) => h('li', h('code', `${x.ok ? '✓' : '✗'} ${x.command}`)))),
    h('div.note', `Fix suggestions come from SeeFast's built-in notes (reviewed ${d.knowledgeBase}). Nothing was installed or downloaded.`)));
  content.append(h('div.center', h('button.btn.small', { type: 'button', onclick: () => { state.doctor = null; render('doctor'); } }, icon('refresh'), 'Check again')));
}

// What I can read: languages, framework recipes, services and the files it looks at. All of it comes from the
// analyzer's own tables and recipe/knowledge files (src/core/support.ts), so new recipes appear here by themselves.
const ECO_BADGE = {
  node: ['JS', 'var(--sun-soft)'], php: ['PHP', 'var(--grape-soft)'], python: ['PY', 'var(--sky-soft)'], go: ['GO', 'var(--sky-soft)'],
  rust: ['RS', 'var(--coral-soft)'], ruby: ['RB', 'var(--coral-soft)'], java: ['JV', 'var(--sun-soft)'], dotnet: ['.N', 'var(--grape-soft)'],
  deno: ['DN', 'var(--mint-soft)'], elixir: ['EX', 'var(--grape-soft)'],
};
const SERVICE_GROUPS = { database: 'Databases', cache: 'Caches', queue: 'Queues', mail: 'Mail', search: 'Search', storage: 'Storage', other: 'Other' };

function ecoBadge(e) {
  const [code, bg] = ECO_BADGE[e.id] ?? [e.name.slice(0, 2).toUpperCase(), 'var(--sunk)'];
  const b = h('span.badge', { 'aria-hidden': 'true' }, code);
  b.style.background = bg;
  return b;
}

async function viewSupport() {
  setTitle('What I can read', 'Languages, frameworks and services');
  const seq = renderSeq;
  state.support ??= await cr.support();
  if (seq !== renderSeq) return;
  const cat = state.support;
  const full = cat.ecosystems.filter((e) => e.depth === 'full');
  const basic = cat.ecosystems.filter((e) => e.depth === 'generic');
  const recipes = cat.ecosystems.flatMap((e) => e.frameworks);
  setMood('happy');
  content.append(h('div.say.pop', mascot('happy', 'bob'), h('div.words',
    'I read ', h('strong', plural(full.length, 'language')), ' in depth, with ', h('strong', plural(recipes.length, 'framework recipe')),
    ', and ', h('strong', `${basic.length} more`), ' the basic way. When I am not sure, I say so.')));

  const row = (k, ...v) => h('div.kv', h('span.k', k), h('div', ...v));
  content.append(section('In depth', 'spark', h('div.stack', full.map((e) => h('div.card.eco',
    h('div.eco-head', ecoBadge(e), h('span.name', e.name), h('span.tag.deep', 'in depth')),
    row('Tools', h('div.chips', e.tools.map((t) => h('span.chip.tool', t)))),
    e.frameworks.length ? row('Recipes', h('div.chips', e.frameworks.map((f) => h('span.chip.fw', { title: f.reviewed ? `Recipe reviewed ${f.reviewed}` : 'Recipe' }, icon('spark'), f.name)))) : null,
    row('Spots it by', h('span.files', e.markers.join(' · '))))))),
    h('p.note', 'Versions, package manager, workspaces, env files, setup steps, how to start it, and what disagrees.'));

  content.append(section('Basic support', 'cube', h('div.eco-grid', basic.map((e) => h('div.eco-tile',
    ecoBadge(e), h('div', h('div.name', e.name), h('div.meta', e.tools.join(' · ')), e.frameworks.length ? h('div.meta', 'Recipes: ' + e.frameworks.map((f) => f.name).join(', ')) : null)))),
    h('p.note', 'Install and run commands from the usual files. Answers are marked likely or guess, and the overview says when a project only has basic support.')));

  const groups = new Map();
  for (const sv of cat.services) groups.set(sv.category, [...(groups.get(sv.category) ?? []), sv]);
  content.append(section(`Services (${cat.services.length})`, 'plug', h('div.card', [...groups].map(([k, list]) =>
    row(SERVICE_GROUPS[k] ?? k, h('div.chips', list.map((sv) => h('span.chip.svc', { title: sv.port ? `Default port ${sv.port}` : '' }, sv.title))))))));

  content.append(h('details.pop', h('summary', 'Where I look'), h('div.card.stack.sources',
    h('div', h('strong', 'Project files'), h('div.files', cat.ecosystems.map((e) => `${e.name}: ${e.markers.join(', ')}`).join('\n'))),
    cat.sources.map((src) => h('div', h('strong', src.title), h('div.files', src.files.join(' · ')))))));
  content.append(h('p.note.center', 'Support grows with recipe files (recipes/*.json) and knowledge files (kb/*.json).'));
}

function viewSettings() {
  const s = state.info.settings;
  setTitle('Settings', `SeeFast ${state.info.version}`);
  setMood('idle');
  const msg = h('div', { role: 'status' });
  const save = async (patch) => {
    const r = await cr.saveSettings(patch);
    if (r.error) { msg.className = 'callout bad'; msg.textContent = r.error; }
    else { state.info.settings = r.settings; msg.className = 'callout good'; msg.textContent = r.restartNeeded ? 'Saved. The window style changes after a restart.' : 'Saved.'; applyMotion(); }
  };
  const field = (lbl, control, help) => h('label.field', h('span', lbl), control, help ? h('span.help', help) : null);
  const select = (key, options) => h('select', { onchange: (e) => save({ [key]: e.target.value }) }, options.map(([v, t]) => h('option', { value: v, selected: s[key] === v }, t)));
  const shortcut = h('input', { type: 'text', value: s.shortcut, spellcheck: 'false' });
  content.append(h('div.card.pop',
    field('Window', select('windowMode', [['auto', 'Automatic'], ['floating', 'Floating bubble'], ['window', 'Normal window']]),
      `Now: ${state.info.mode === 'floating' ? 'floating bubble' : 'normal window'}. ${state.info.modeReason.replace(/\.?$/, '.')} If the bubble ever stays invisible, start SeeFast with SEEFAST_WINDOW=window.`),
    field('Show / hide shortcut', h('div.inline', shortcut, h('button.btn.small', { type: 'button', onclick: () => save({ shortcut: shortcut.value.trim() }) }, 'Save')),
      'For example CommandOrControl+Alt+K. Wayland desktops such as GNOME do not allow global shortcuts.'),
    field('Motion', select('motion', [['system', 'Follow the system'], ['reduce', 'Always calm (no animation)']])),
    field('Commands for', select('shell', [['auto', 'This system'], ['posix', 'Mac / Linux shells'], ['powershell', 'Windows PowerShell']]))),
    msg,
    section('What I can read', 'layers', h('button.recent-item', { type: 'button', onclick: openSupport }, icon('layers'), h('span', h('strong', 'Languages, frameworks and services'), h('span.p', 'Everything SeeFast knows how to read, and how well')))),
    section('Privacy', 'key', h('div.card.small', 'SeeFast only reads files. It never runs project code while looking, never reads .env or key files, and never goes online. Recent projects are kept in this app’s own folder.')),
    h('div.center', h('button.btn.small', { type: 'button', onclick: async () => { await cr.forgetRecent(); state.info.recent = []; say('Recent projects forgotten'); } }, 'Forget recent projects')));
}

function applyMotion() {
  document.documentElement.classList.toggle('reduce-motion', state.info?.settings?.motion === 'reduce');
}

cr.on('command', (c) => {
  if (c.type === 'analyze') analyzeFolder(c.path);
  else if (c.type === 'pick') pickAndAnalyze();
  else if (c.type === 'settings') open('settings');
});

(async () => {
  state.info = await cr.info();
  state.shell = state.info.shell;
  applyMotion();
  if (state.info.mode === 'window') {
    document.body.classList.add('window');
    shell.dataset.state = 'panel';
    panel.hidden = false;
    render('home');
  }
  window.__seefast = { state, open, collapse, analyzeFolder, activate, startRun };
})();
