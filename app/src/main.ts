// SeeFast launcher: a floating bubble that turns into panels. It reads the same plan as the CLI (the analysis
// runs in a worker thread from the same package), makes no network requests, and runs nothing without consent.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runDoctor, runSetup, startTargets, renderSetupMd, renderAction, diffPlans, defaultShell, supportCatalog, displayName, type Plan, type DoctorReport, type Decision, type ConsentRequest } from 'seefast';
import { BUBBLE, bubbleFromPanel, keepOnScreen, panelBounds, restorePosition, savePosition, union, type Anchor, type DisplayInfo, type Rect, type SavedPosition } from './geometry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const APP_ROOT = path.resolve(here, '..');
const SMOKE = process.argv.includes('--smoke');

// ---- Settings and state (in the app's own data folder, never in the analyzed project) -------------------------

interface Settings {
  shortcut: string;
  /** floating: the bubble; window: a normal window (the fallback where floating windows are not possible). */
  windowMode: 'auto' | 'floating' | 'window';
  motion: 'system' | 'reduce';
  shell: 'auto' | 'posix' | 'powershell';
}
interface Recent {
  path: string;
  name: string;
  at: string;
  digest?: string;
}
interface Persisted {
  settings: Settings;
  bubble: SavedPosition | null;
  recent: Recent[];
}

const DEFAULTS: Settings = { shortcut: 'CommandOrControl+Alt+K', windowMode: 'auto', motion: 'system', shell: 'auto' };
const stateFile = () => path.join(app.getPath('userData'), 'launcher-state.json');
function load(): Persisted {
  try {
    const p = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<Persisted>;
    return { settings: { ...DEFAULTS, ...(p.settings ?? {}) }, bubble: p.bubble ?? null, recent: Array.isArray(p.recent) ? p.recent.slice(0, 10) : [] };
  } catch {
    return { settings: { ...DEFAULTS }, bubble: null, recent: [] };
  }
}
let persisted: Persisted;
function persist(): void {
  if (SMOKE) return;
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(persisted, null, 2));
}

// ---- Platform: can this desktop float a window? ------------------------------------------------------------------

/**
 * Linux under Wayland cannot position windows or keep them on top, so on Wayland the app opens as a normal window
 * unless the user asks for the floating bubble, which then runs through XWayland. XWayland is not the default:
 * on some machines Electron cannot draw into XWayland windows at all (GNOME with an Intel Tiger Lake GPU: the window
 * exists but nothing appears), and there is no way to detect that from inside the app.
 * SEEFAST_WINDOW=window|floating overrides the setting (a way back if the bubble does not show).
 */
function chooseMode(settings: Settings): { mode: 'floating' | 'window'; reason: string } {
  const forced = process.env.SEEFAST_WINDOW;
  const choice = forced === 'window' || forced === 'floating' ? forced : settings.windowMode;
  const why = forced === 'window' || forced === 'floating' ? `SEEFAST_WINDOW=${forced}` : 'chosen in settings';
  if (choice === 'window') return { mode: 'window', reason: why };
  if (process.platform === 'linux') {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
    if (wayland && !process.env.DISPLAY) return { mode: 'window', reason: 'Wayland without XWayland: windows cannot float or be positioned' };
    if (wayland && choice !== 'floating') {
      return { mode: 'window', reason: 'Wayland session: apps cannot float or place their own windows. "Floating bubble" tries it through XWayland, which some graphics drivers do not display' };
    }
    if (wayland) {
      app.commandLine.appendSwitch('ozone-platform', 'x11');
      // Under XWayland, Chromium's GPU process crashes on some Mesa drivers (seen on Intel Tiger Lake / GNOME:
      // three crashes, then software rendering). Start in software rendering directly; the bubble and panels are
      // light enough. SEEFAST_GPU=1 keeps hardware acceleration for machines where it works.
      if (process.env.SEEFAST_GPU !== '1') app.disableHardwareAcceleration();
      return { mode: 'floating', reason: `${why}: running through XWayland so the bubble can float (if it does not appear, choose "Normal window" or start with SEEFAST_WINDOW=window)` };
    }
  }
  return { mode: 'floating', reason: 'native' };
}

// ---- Window --------------------------------------------------------------------------------------------------------

const PANEL_SIZES: Record<string, { width: number; height: number }> = {
  analysis: { width: 440, height: 640 },
  manual: { width: 520, height: 680 },
  auto: { width: 560, height: 700 },
  doctor: { width: 500, height: 660 },
  settings: { width: 420, height: 540 },
  support: { width: 480, height: 660 },
};

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let mode: { mode: 'floating' | 'window'; reason: string };
let shape: 'bubble' | string = 'bubble';
let anchor: Anchor = 'top-left';
let bubble: Rect;
let panelRect: Rect | null = null;

function displays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));
}

function setRect(r: Rect): void {
  // setBounds with explicit size each time: on Windows a window crossing monitors with different scaling can
  // otherwise come back resized.
  win?.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}

function createWindow(): void {
  bubble = restorePosition(persisted.bubble, displays(), screen.getPrimaryDisplay().id);
  const floating = mode.mode === 'floating';
  win = new BrowserWindow({
    ...(floating ? { ...bubble } : { width: 480, height: 680 }),
    title: 'SeeFast',
    show: false,
    frame: !floating,
    transparent: floating,
    resizable: !floating,
    maximizable: !floating,
    minimizable: !floating,
    fullscreenable: false,
    alwaysOnTop: floating,
    skipTaskbar: floating,
    hasShadow: !floating,
    backgroundColor: floating ? '#00000000' : '#101418',
    ...(floating && process.platform === 'darwin' ? { type: 'panel' } : {}),
    icon: path.join(APP_ROOT, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  if (floating) {
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    // showInactive: the bubble appears without stealing focus from what the user is doing.
    if (floating) win!.showInactive();
    else win!.show();
  });
  void win.loadURL(`app://launcher/renderer/index.html?mode=${mode.mode}`);
}

function toggle(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else mode.mode === 'floating' ? win.showInactive() : win.show();
}

function placeAfterDisplayChange(): void {
  if (!win || mode.mode !== 'floating') return;
  bubble = keepOnScreen(shape === 'bubble' ? bubble : bubbleFromPanel(panelRect ?? bubble, anchor), displays());
  if (shape === 'bubble') setRect(bubble);
  else applyShape(shape);
}

interface RelRect { x: number; y: number; width: number; height: number }
function rel(r: Rect, to: Rect): RelRect {
  return { x: r.x - to.x, y: r.y - to.y, width: r.width, height: r.height };
}
function sameRect(a: Rect | null, b: Rect | null): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

/**
 * Change the window for a new shape. The window first becomes big enough for both the old and the new shape
 * (still transparent), and the renderer animates the shell from `from` to `to` (both relative to the window);
 * then `settle` shrinks the window to the new shape exactly.
 */
function applyShape(kind: string): { mode: string; from: RelRect; to: RelRect; settle: boolean } {
  const size = PANEL_SIZES[kind] ?? PANEL_SIZES.analysis;
  if (mode.mode === 'window' || !win) {
    shape = kind;
    const [w, h] = win?.getContentSize() ?? [size.width, size.height];
    const full = { x: 0, y: 0, width: w, height: h };
    return { mode: mode.mode, from: full, to: full, settle: false };
  }
  const actual = win.getBounds();
  // The user may have dragged the panel by its title bar: the bubble follows the panel's anchored corner.
  if (shape !== 'bubble' && panelRect && !sameRect(actual, panelRect)) bubble = bubbleFromPanel(actual, anchor);
  const fromAbs = shape === 'bubble' ? bubble : actual;
  const wa = screen.getDisplayNearestPoint({ x: bubble.x + BUBBLE / 2, y: bubble.y + BUBBLE / 2 }).workArea;
  const target = panelBounds(bubble, size, wa);
  const windowAbs = shape === 'bubble' ? target.bounds : union(fromAbs, target.bounds);
  setRect(windowAbs);
  anchor = target.anchor;
  panelRect = target.bounds;
  shape = kind;
  return { mode: mode.mode, from: rel(fromAbs, windowAbs), to: rel(target.bounds, windowAbs), settle: !sameRect(windowAbs, target.bounds) };
}

/** Where the bubble goes back to, relative to the current window: where it was, unless the panel was moved. */
function collapseTarget(): RelRect | null {
  if (!win || mode.mode === 'window' || shape === 'bubble') return null;
  const actual = win.getBounds();
  if (panelRect && !sameRect(actual, panelRect)) bubble = bubbleFromPanel(actual, anchor);
  return rel(bubble, actual);
}

// ---- Analysis, doctor, runner ---------------------------------------------------------------------------------------

let current: { root: string; plan: Plan } | null = null;
let doctorReport: DoctorReport | null = null;

function analyzeInWorker(root: string): Promise<Plan> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analyze-worker.js', import.meta.url), { workerData: { root } });
    w.once('message', (m: { plan?: Plan; error?: string }) => (m.plan ? resolve(m.plan) : reject(new Error(m.error))));
    w.once('error', reject);
  });
}

function planCache(root: string): string {
  return path.join(app.getPath('userData'), 'plans', createHash('sha256').update(root).digest('hex').slice(0, 16) + '.json');
}

async function analyzeFolder(root: string): Promise<{ plan?: Plan; changes?: string[]; error?: string; root?: string }> {
  try {
    if (!fs.statSync(root).isDirectory()) return { error: `${root} is not a folder.` };
  } catch {
    return { error: `${root} does not exist.` };
  }
  try {
    const plan = await analyzeInWorker(root);
    current = { root, plan };
    doctorReport = null;
    let changes: string[] | undefined;
    const cache = planCache(root);
    try {
      const before = JSON.parse(fs.readFileSync(cache, 'utf8')) as Plan;
      const d = diffPlans(before, plan);
      if (!d.same) changes = d.lines;
    } catch {
      /* first time */
    }
    if (!SMOKE) {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(plan));
      persisted.recent = [{ path: root, name: path.basename(root), at: new Date().toISOString(), digest: plan.digest }, ...persisted.recent.filter((r) => r.path !== root)].slice(0, 10);
      persist();
      rebuildTrayMenu();
    }
    return { plan, changes, root };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const pendingConsent = new Map<number, (d: Decision) => void>();
let consentSeq = 0;
let runAbort: AbortController | null = null;
let startAbort: AbortController | null = null;

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function shellKind(): 'posix' | 'powershell' {
  return persisted.settings.shell === 'auto' ? defaultShell() : persisted.settings.shell;
}

// ---- IPC ------------------------------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('info', () => ({
    mode: mode.mode, modeReason: mode.reason, platform: process.platform, version: app.getVersion(), settings: persisted.settings,
    shell: shellKind(), recent: persisted.recent, smoke: SMOKE,
  }));
  ipcMain.handle('pick-folder', async () => {
    if (SMOKE) return smokePick();
    const r = await dialog.showOpenDialog({ title: 'Choose a project folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('analyze', (_e, root: string) => analyzeFolder(root));
  ipcMain.handle('shape', (_e, kind: string) => applyShape(kind));
  ipcMain.handle('collapse-target', () => collapseTarget());
  ipcMain.handle('settle', () => {
    if (win && panelRect && shape !== 'bubble') setRect(panelRect);
  });
  ipcMain.handle('collapse', () => {
    if (mode.mode === 'window') {
      win?.minimize();
      return;
    }
    shape = 'bubble';
    panelRect = null;
    bubble = keepOnScreen(bubble, displays());
    setRect(bubble);
  });
  // Drag: the main process follows the cursor itself (screen.getCursorScreenPoint), which stays correct across
  // monitors with different scaling, where renderer coordinates can jump.
  let dragFrom: { cursor: Electron.Point; win: Rect } | null = null;
  ipcMain.on('drag', (_e, phase: 'start' | 'move' | 'end', sx?: number, sy?: number) => {
    if (!win || mode.mode !== 'floating' || shape !== 'bubble') return;
    // The smoke test drives synthetic pointer events, which do not move the OS cursor: use their coordinates.
    const cur = SMOKE && typeof sx === 'number' && typeof sy === 'number' ? { x: sx, y: sy } : screen.getCursorScreenPoint();
    if (phase === 'start') dragFrom = { cursor: cur, win: { ...bubble } };
    else if (dragFrom && phase === 'move') {
      bubble = { x: dragFrom.win.x + cur.x - dragFrom.cursor.x, y: dragFrom.win.y + cur.y - dragFrom.cursor.y, width: BUBBLE, height: BUBBLE };
      setRect(bubble);
    } else if (dragFrom && phase === 'end') {
      dragFrom = null;
      bubble = keepOnScreen(bubble, displays());
      setRect(bubble);
      persisted.bubble = savePosition(bubble, displays());
      persist();
    }
  });
  ipcMain.on('nudge', (_e, dx: number, dy: number) => {
    if (!win || mode.mode !== 'floating' || shape !== 'bubble') return;
    bubble = keepOnScreen({ ...bubble, x: bubble.x + dx, y: bubble.y + dy }, displays());
    setRect(bubble);
    persisted.bubble = savePosition(bubble, displays());
    persist();
  });
  ipcMain.handle('copy', (_e, text: string) => {
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.handle('doctor', async () => {
    if (!current) return null;
    doctorReport = await runDoctor(current.plan, { root: current.root });
    return doctorReport;
  });
  // What the analyzer can read: built from its own tables and recipe/knowledge files, not from any project.
  ipcMain.handle('support', () => {
    const cat = supportCatalog();
    return { ...cat, services: cat.services.map((s) => ({ ...s, title: displayName(s.name) })) };
  });
  ipcMain.handle('render-action', (_e, action, sh?: 'posix' | 'powershell') => renderAction(action, sh ?? shellKind()));
  ipcMain.handle('write-setup-md', async () => {
    if (!current) return { error: 'No project analyzed.' };
    const file = path.join(current.root, 'SETUP.md');
    const exists = fs.existsSync(file);
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question', buttons: ['Write SETUP.md', 'Cancel'], defaultId: 1, cancelId: 1,
      message: exists ? 'Replace SETUP.md in the project folder?' : 'Write SETUP.md into the project folder?',
      detail: file,
    });
    if (response !== 0) return { cancelled: true };
    if (exists && !/^# Setting up /.test(fs.readFileSync(file, 'utf8'))) return { error: 'SETUP.md exists and was not written by SeeFast; not overwriting it.' };
    fs.writeFileSync(file, renderSetupMd(current.plan));
    return { file };
  });
  ipcMain.handle('run-setup', async (_e, opts: { dryRun: boolean; includeOptional: boolean; allowOutside: boolean; approveAll: boolean; resume: boolean; only?: string[] }) => {
    if (!current || runAbort) return { error: 'Nothing to run, or a run is in progress.' };
    runAbort = new AbortController();
    try {
      const res = await runSetup(current.plan, {
        root: current.root, dryRun: opts.dryRun, includeOptional: opts.includeOptional, allowOutside: opts.allowOutside, approveAll: opts.approveAll,
        resume: opts.resume, only: opts.only, signal: runAbort.signal, shell: shellKind(),
        consent: (req: ConsentRequest) =>
          req.reason === 'optional' && !opts.includeOptional
            ? Promise.resolve<Decision>('skip')
            : new Promise<Decision>((resolve) => {
            const id = ++consentSeq;
            pendingConsent.set(id, resolve);
            send('runner', { type: 'consent', id, step: req.step.id, command: req.command, reason: req.reason });
          }),
        onEvent: (e) => send('runner', e.type === 'step-start' || e.type === 'step-end' || e.type === 'output' || e.type === 'manual' ? { ...e, step: e.step.id } : e),
      });
      return res;
    } finally {
      runAbort = null;
      for (const [, resolve] of pendingConsent) resolve('quit');
      pendingConsent.clear();
    }
  });
  ipcMain.on('consent', (_e, id: number, d: Decision) => {
    pendingConsent.get(id)?.(d);
    pendingConsent.delete(id);
  });
  ipcMain.on('stop', () => {
    runAbort?.abort();
    startAbort?.abort();
    for (const [, resolve] of pendingConsent) resolve('quit');
    pendingConsent.clear();
  });
  ipcMain.handle('start-app', async () => {
    if (!current || startAbort) return { error: 'Nothing to start, or already running.' };
    startAbort = new AbortController();
    try {
      return await startTargets(current.plan, {
        root: current.root, signal: startAbort.signal,
        onEvent: (e) => send('start', 'target' in e ? { ...e, target: e.target.id } : e),
      });
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      startAbort = null;
    }
  });
  ipcMain.handle('save-settings', (_e, s: Partial<Settings>) => {
    const next = { ...persisted.settings, ...s };
    if (s.shortcut && s.shortcut !== persisted.settings.shortcut) {
      globalShortcut.unregisterAll();
      const ok = registerShortcut(next.shortcut);
      if (!ok) {
        registerShortcut(persisted.settings.shortcut);
        return { error: `Could not register ${s.shortcut}; another app may use it, or this desktop does not allow global shortcuts.` };
      }
    }
    persisted.settings = next;
    persist();
    return { settings: next, restartNeeded: s.windowMode !== undefined };
  });
  ipcMain.handle('forget-recent', () => {
    persisted.recent = [];
    persist();
    rebuildTrayMenu();
  });
  ipcMain.on('context-menu', () => {
    Menu.buildFromTemplate(menuTemplate()).popup({ window: win! });
  });
  ipcMain.handle('open-path', (_e, p: string) => {
    if (current && (p === current.root || p.startsWith(current.root + path.sep))) return shell.openPath(p);
    return 'refused';
  });
}

// ---- Tray, shortcut, menus ----------------------------------------------------------------------------------------

function menuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: win?.isVisible() ? 'Hide the bubble' : 'Show the bubble', click: toggle },
    { label: 'Analyze a folder…', click: () => send('command', { type: 'pick' }) },
    {
      label: 'Recent projects',
      enabled: persisted.recent.length > 0,
      submenu: persisted.recent.map((r) => ({ label: `${r.name}  —  ${r.path}`, click: () => send('command', { type: 'analyze', path: r.path }) })),
    },
    { type: 'separator' },
    { label: 'Settings', click: () => send('command', { type: 'settings' }) },
    { label: 'Quit SeeFast', role: 'quit' },
  ];
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function registerShortcut(acc: string): boolean {
  try {
    return globalShortcut.register(acc, toggle);
  } catch {
    return false;
  }
}

// ---- Startup --------------------------------------------------------------------------------------------------------

// Chromium prints internal ERROR lines on Linux that are harmless (a GTK scale-factor assertion, the software
// renderer's first XGetWindowAttributes call). Keep the terminal quiet unless SEEFAST_DEBUG=1.
if (process.env.SEEFAST_DEBUG !== '1') app.commandLine.appendSwitch('log-level', '3');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  persisted = load();
  mode = chooseMode(persisted.settings);
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--toggle')) toggle();
    const folder = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory());
    if (folder) send('command', { type: 'analyze', path: path.resolve(folder) });
  });
  app.whenReady().then(() => {
    // The app's own files only, over app://; every other request is cancelled: the UI makes no network requests.
    protocol.handle('app', (req) => {
      const url = new URL(req.url);
      const file = path.normalize(path.join(APP_ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(APP_ROOT + path.sep) || !/^(renderer|out|assets)[\\/]/.test(path.relative(APP_ROOT, file))) return new Response('not found', { status: 404 });
      try {
        const type = MIME[path.extname(file)] ?? 'application/octet-stream';
        return new Response(fs.readFileSync(file), { headers: { 'content-type': type } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: !/^(app|devtools|data|blob):/.test(details.url) });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    if (process.platform === 'darwin' && mode.mode === 'floating') app.dock?.hide();
    registerIpc();
    createWindow();
    const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('SeeFast');
    tray.on('click', toggle);
    rebuildTrayMenu();
    if (!registerShortcut(persisted.settings.shortcut)) {
      const wayland = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY);
      console.warn(
        `SeeFast: the global shortcut ${persisted.settings.shortcut} could not be registered` +
          (wayland
            ? ' (Wayland desktops such as GNOME do not let apps grab keys globally). Use the bubble or its right-click menu, or add a custom shortcut in your desktop settings that runs this app with --toggle.'
            : ' (another app may use it). Pick another one in Settings.'),
      );
    }
    screen.on('display-added', placeAfterDisplayChange);
    screen.on('display-removed', placeAfterDisplayChange);
    screen.on('display-metrics-changed', placeAfterDisplayChange);
    const folderArg = process.argv.slice(1).find((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a) && fs.statSync(a).isDirectory() && path.resolve(a) !== APP_ROOT);
    if (folderArg) win!.webContents.once('did-finish-load', () => send('command', { type: 'analyze', path: path.resolve(folderArg) }));
    if (SMOKE) void import('./smoke.js').then((m) => m.runSmoke({ win: win!, getBubble: () => bubble, getShape: () => shape, appRoot: APP_ROOT, mode: mode.mode }));
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}

// In smoke mode the folder picker answers with a fixture, and counts how often it was opened.
export const smokeState = { picks: 0 };
function smokePick(): string {
  smokeState.picks++;
  return path.resolve(APP_ROOT, '..', 'fixtures', 'laravel-next-monorepo');
}
