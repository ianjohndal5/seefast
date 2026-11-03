// Smoke test of the real launcher (electron . --smoke): drives the window with synthetic input, checks that a
// drag is never taken for a click, that panels open inside the work area and collapse back to the bubble, and
// saves a screenshot of every shape to out/smoke/. Exit code 1 if any check fails.
import { app, nativeTheme, screen, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { smokeState } from './main.js';

// The laravel-next-monorepo fixture's quick start, in order (text-transform makes the heading upper case).
const QUICK_START = /Quick start[\s\S]*cd \S*laravel-next-monorepo\/api[\s\S]*composer install[\s\S]*\d+ more steps first[\s\S]*composer run dev[\s\S]*localhost:8000[\s\S]*second terminal[\s\S]*pnpm run dev/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(ctx: { win: BrowserWindow; getBubble: () => { x: number; y: number }; getShape: () => string; appRoot: string; mode: 'floating' | 'window' }): Promise<void> {
  if (ctx.mode === 'window') return runWindowSmoke(ctx);
  const { win } = ctx;
  const outDir = path.join(ctx.appRoot, 'out', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  // Synthetic events need explicit screen coordinates (globalX/Y); the bubble window does not move during the
  // gesture from the page's point of view, so they are computed from the window position at the press.
  let origin = { x: 0, y: 0 };
  const mouse = (type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number) => {
    if (type === 'mouseDown') origin = { x: win.getBounds().x, y: win.getBounds().y };
    win.webContents.sendInputEvent({ type, x, y, globalX: origin.x + x, globalY: origin.y + y, button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}) } as Electron.MouseInputEvent);
  };
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    await waitFor(() => !win.webContents.isLoading() && win.isVisible(), 10000);
    await sleep(600);
    const b0 = win.getBounds();
    check('bubble is a 64×64 always-on-top window', b0.width === 64 && b0.height === 64 && win.isAlwaysOnTop(), JSON.stringify(b0));
    await shot('1-bubble');

    // A drag never opens the folder picker.
    const drag = async (dx: number, dy: number) => {
      mouse('mouseDown', 32, 32);
      await sleep(50);
      mouse('mouseMove', 34, 33); // under the threshold
      await sleep(50);
      for (let i = 1; i <= 10; i++) {
        mouse('mouseMove', 32 + (i * dx) / 10, 32 + (i * dy) / 10);
        await sleep(30);
      }
      mouse('mouseUp', 32 + dx, 32 + dy);
      await sleep(400);
    };
    await drag(-60, 40);
    const b1 = win.getBounds();
    check('dragging moves the bubble', b1.x - b0.x === -60 && b1.y - b0.y === 40, `moved by ${b1.x - b0.x},${b1.y - b0.y}`);
    check('a drag is not a click', smokeState.picks === 0, `folder picker opened ${smokeState.picks} times`);
    await drag(400, 0);
    const edge = win.getBounds();
    const waB = screen.getDisplayMatching(edge).workArea;
    check('a drag past the screen edge keeps the bubble fully visible', edge.x + edge.width === waB.x + waB.width, JSON.stringify(edge));
    await drag(-100, 0);
    const b1b = win.getBounds();
    check('still no click after three drags', smokeState.picks === 0);

    // A click opens the picker; the fixture is analyzed and the bubble becomes the analysis panel.
    mouse('mouseDown', 32, 32);
    await sleep(60);
    mouse('mouseUp', 32, 32);
    const opened = await waitFor(() => ctx.getShape() === 'analysis', 10000);
    await sleep(700);
    check('a click opens the folder picker once', smokeState.picks === 1, `${smokeState.picks}`);
    check('analysis panel opens', opened);
    const p = win.getBounds();
    const wa = screen.getDisplayMatching(p).workArea;
    check('panel stays inside the work area', p.x >= wa.x && p.y >= wa.y && p.x + p.width <= wa.x + wa.width && p.y + p.height <= wa.y + wa.height, `${JSON.stringify(p)} in ${JSON.stringify(wa)}`);
    const text = await js<string>('document.body.innerText');
    check('analysis shows projects and requirements', /api/.test(text) && /You.ll need/i.test(text) && /PHP/.test(text), text.slice(0, 120).replace(/\n/g, ' | '));
    check('focus moves into the panel', (await js<string>('document.activeElement && document.activeElement.id')) === 'panel-title');
    check('the overview has a quick start: cd, installs, the left-out steps, start', QUICK_START.test(text), text.slice(0, 400).replace(/\n/g, ' | '));
    await shot('2-analysis');

    await js(`window.__seefast.open('manual')`);
    await sleep(900);
    const copies = await js<number>(`document.querySelectorAll('button.copy').length`);
    check('manual guide lists commands with copy buttons', copies >= 8, `${copies} copy buttons`);
    await shot('3-manual');

    await js(`window.__seefast.open('doctor')`);
    await waitFor(async () => !/Checking this machine/.test(await js<string>('document.getElementById("content").innerText')), 15000);
    await sleep(500);
    await shot('4-doctor');
    check('doctor reports results', /read-only command/.test(await js<string>('document.getElementById("content").innerText')));

    const fixture = path.resolve(ctx.appRoot, '..', 'fixtures', 'laravel-next-monorepo');
    await js(`window.__seefast.open('auto')`);
    await sleep(800);
    await shot('5-auto');
    await js(`[...document.querySelectorAll('button')].find(b => /Preview/.test(b.textContent)).click()`);
    const dry = await waitFor(async () => /nothing was executed/.test(await js<string>('document.getElementById("content").innerText')), 15000);
    check('automated mode dry run finishes without executing', dry && !fs.existsSync(path.join(fixture, '.seefast')));
    await sleep(300);
    await shot('6-auto-dry-run');

    await js(`window.__seefast.open('settings')`);
    await sleep(800);
    await shot('7-settings');

    // Escape: back to the overview, then collapse to the bubble at the panel's anchored corner.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await sleep(800);
    check('Escape goes back to the overview', ctx.getShape() === 'analysis');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await waitFor(() => ctx.getShape() === 'bubble', 3000);
    await sleep(300);
    const b2 = win.getBounds();
    check('Escape collapses back to the bubble where it was', b2.width === 64 && b2.x === b1b.x && b2.y === b1b.y, `${JSON.stringify(b2)} vs ${JSON.stringify(b1b)}`);
    check('focus returns to the bubble', (await js<string>('document.activeElement && document.activeElement.id')) === 'bubble');
  } catch (e) {
    check('smoke run', false, (e as Error).stack ?? String(e));
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed; screenshots in ${outDir}`);
  app.exit(failed ? 1 : 0);
}

/** Normal-window mode (the default on Linux Wayland): the same panels in a regular window. */
async function runWindowSmoke(ctx: { win: BrowserWindow; getShape: () => string; appRoot: string }): Promise<void> {
  const { win } = ctx;
  const outDir = path.join(ctx.appRoot, 'out', 'smoke-window');
  fs.mkdirSync(outDir, { recursive: true });
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const shot = async (name: string) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const text = () => js<string>('document.body.innerText');
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    await waitFor(() => !win.webContents.isLoading() && win.isVisible());
    await sleep(800);
    const b = win.getBounds();
    check('a normal window opens', win.isVisible() && b.width >= 400 && b.height >= 500 && !win.isAlwaysOnTop(), JSON.stringify(b));
    check('it starts on the folder chooser', /Choose a project folder/.test(await text()));
    await shot('1-home');
    const fixture = path.resolve(ctx.appRoot, '..', 'fixtures', 'laravel-next-monorepo');
    await js(`window.__seefast.analyzeFolder(${JSON.stringify(fixture)})`);
    check('analysis shows projects and requirements', await waitFor(async () => /You.ll need/i.test(await text())));
    check('focus moves to the panel title', (await js<string>('document.activeElement && document.activeElement.id')) === 'panel-title');
    check('the overview has a quick start: cd, installs, the left-out steps, start', QUICK_START.test(await text()), (await text()).slice(0, 400).replace(/\n/g, ' | '));
    check('a quick start with left-out steps offers no "Copy all"', (await js<number>(`[...document.querySelectorAll('.qs button.copy')].length`)) === 0);
    await sleep(700);
    await shot('2-analysis');
    await js(`document.querySelector('.qs')?.scrollIntoView({ block: 'end' })`);
    await sleep(200);
    await shot('2-quick-start');
    await js(`window.__seefast.open('manual')`);
    await sleep(800);
    check('manual guide lists commands with copy buttons', (await js<number>(`document.querySelectorAll('button.copy').length`)) >= 8);
    await shot('3-manual');
    await js(`window.__seefast.open('doctor')`);
    check('doctor reports results', await waitFor(async () => /read-only command/.test(await text()), 15000));
    await shot('4-doctor');
    await js(`window.__seefast.open('auto')`);
    await sleep(600);
    await shot('5-auto');
    await js(`[...document.querySelectorAll('button')].find(b => /Preview/.test(b.textContent)).click()`);
    check('automated mode dry run finishes without executing', (await waitFor(async () => /nothing was executed/.test(await text()), 15000)) && !fs.existsSync(path.join(fixture, '.seefast')));
    await sleep(400);
    await shot('6-auto-dry-run');
    await js(`window.__seefast.open('settings')`);
    await sleep(500);
    await shot('7-settings');
    await js(`window.__seefast.open('support')`);
    check('support screen lists languages, recipes and services', await waitFor(async () => /Basic support/i.test(await text()) && /Laravel/.test(await text()) && /PostgreSQL/.test(await text())));
    await sleep(400);
    await shot('8-support');
    await js(`document.getElementById('content').scrollTop = 1e6`);
    await sleep(300);
    await shot('8-support-end');
    await js(`window.__seefast.open('manual')`);
    await sleep(400);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await sleep(500);
    check('Escape goes back to the overview', ctx.getShape() === 'analysis');
    // Screenshots of both themes (no checks: the same DOM, other colors).
    const other = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
    nativeTheme.themeSource = other;
    for (const v of ['analysis', 'manual', 'auto', 'doctor', 'support']) {
      await js(`window.__seefast.open('${v}')`);
      await sleep(600);
      await shot(`${other}-${v}`);
    }
    await js(`window.__seefast.state.plan = null; window.__seefast.open('home')`);
    await sleep(500);
    await shot(`${other}-home`);
    nativeTheme.themeSource = 'system';
    // Optional: SEEFAST_SMOKE_RUN=<folder> really runs that project's setup (use a throwaway project you trust) to
    // check the running, stopping and stopped states, pressing Stop a few seconds in.
    const runDir = process.env.SEEFAST_SMOKE_RUN;
    if (runDir) {
      await js(`window.__seefast.analyzeFolder(${JSON.stringify(runDir)})`);
      await sleep(800);
      await js(`window.__seefast.open('auto')`);
      await sleep(500);
      await js(`(() => { const s = window.__seefast.state; s.run ??= { statuses: {}, messages: {}, output: '', opts: {} }; s.run.opts.approveAll = true; window.__seefast.startRun(false); })()`);
      check('a real run shows the running step with a clock and progress', await waitFor(async () => /Running · \d:\d\d/.test(await text()) && /Step \d+ of \d+/i.test(await text()), 10000));
      await sleep(3200);
      await shot('run-1-running');
      await js(`[...document.querySelectorAll('#dock button')].find((b) => /Stop/.test(b.textContent)).click()`);
      check('Stop turns into "Stopping…" at once', await waitFor(async () => /Stopping/.test(await js<string>(`document.getElementById('dock').innerText`)), 1000));
      await shot('run-2-stopping');
      check('the run ends as stopped', await waitFor(async () => /Stopped\./.test(await text()), 15000));
      await sleep(300);
      await shot('run-3-stopped');
    }
    // Optional: SEEFAST_SMOKE_CONSENT=<folder> really runs that project's setup asking before each step (use a
    // throwaway project you trust): answers Run to the first prompt and Skip to the rest, and checks that every wait
    // has a visible prompt, that excluded optional steps are not asked about, and that the run finishes.
    const consentDir = process.env.SEEFAST_SMOKE_CONSENT;
    if (consentDir) {
      await js(`window.__seefast.analyzeFolder(${JSON.stringify(consentDir)})`);
      await sleep(800);
      await js(`window.__seefast.open('auto')`);
      await sleep(500);
      await js(`(() => { const s = window.__seefast.state; s.run = null; window.__seefast.open('auto'); })()`);
      await sleep(400);
      await js(`(() => { const s = window.__seefast.state; s.run.opts.approveAll = false; s.run.opts.includeOptional = false; window.__seefast.startRun(false); })()`);
      const asked: string[] = [];
      let stuck = false;
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const st = await js<{ running: boolean; consent: string | null; prompt: boolean }>(`(() => { const r = window.__seefast.state.run; return { running: r.running, consent: r.consent?.step ?? null, prompt: Boolean(document.querySelector('.tl.current .ask')) }; })()`);
        if (!st.running) break;
        if (st.consent) {
          await sleep(300);
          const visible = await js<boolean>(`Boolean(document.querySelector('.tl.current .ask'))`);
          if (!visible) { stuck = true; break; }
          if (!asked.includes(st.consent)) {
            asked.push(st.consent);
            if (asked.length === 1) await shot('consent-1-prompt');
            if (asked.length > 1) await shot(`consent-${asked.length}-prompt`);
            // First prompt: Run. The env file offer: Create it for me. Anything else: Skip.
            await js(`(() => { const bs = [...document.querySelectorAll('.tl.current .ask button')]; (bs.find((b) => /^(${asked.length === 1 ? 'Run' : 'Create it for me|Skip'})$/.test(b.textContent)) ?? bs.find((b) => b.textContent === 'Skip')).click(); })()`);
          }
        }
        await sleep(150);
      }
      const final = await js<{ running: boolean; status: string | null }>(`(() => { const r = window.__seefast.state.run; return { running: r.running, status: r.result?.status ?? null }; })()`);
      check('every "Waiting for your OK" has a visible prompt', !stuck, `asked: ${asked.join(', ')}`);
      check('excluded optional steps are skipped without asking', !asked.some((id) => /build/.test(id)), asked.join(', '));
      check('after Run and Skip the run finishes', !final.running && final.status !== null, JSON.stringify(final));
      const envFile = path.join(consentDir, '.env');
      if (fs.existsSync(path.join(consentDir, '.env.example'))) void 0;
      else {
        const written = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        check('"Create it for me" writes the env file with names only', /^# API_KEY=$/m.test(written) && !/^[A-Z_]+=.+$/m.test(written), JSON.stringify(written));
      }
      await sleep(300);
      await shot('consent-2-finished');
    }
    // Optional: SEEFAST_SMOKE_START=<folder> runs that project's setup, then "Start the app" (use a throwaway project
    // you trust, one whose start fails, such as a net9.0 web app on a machine with only .NET 10): checks that the
    // failure says why, with the last lines it printed, instead of only an exit code.
    const startDir = process.env.SEEFAST_SMOKE_START;
    if (startDir) {
      await js(`window.__seefast.analyzeFolder(${JSON.stringify(startDir)})`);
      await sleep(800);
      await js(`(async () => { window.__seefast.state.run = null; await window.__seefast.open('auto'); window.__seefast.state.run.opts.approveAll = true; void window.__seefast.startRun(false); })()`);
      check('setup finishes before starting', await waitFor(async () => (await js<string | null>('window.__seefast.state.run.result?.status ?? null')) === 'success', 120000));
      await js('window.__seefast.startApp()');
      check('a target that does not start is reported as such', await waitFor(async () => /Did not start/i.test(await text()), 60000));
      await sleep(400);
      const card = await js<{ why: string | null; printed: boolean; speech: string }>(`(() => ({ why: document.querySelector('.proj.failed .why')?.textContent ?? null, printed: Boolean(document.querySelector('.proj.failed pre.out')?.textContent), speech: document.querySelector('.say .words')?.textContent ?? '' }))()`);
      check('the failure says why, or shows what it printed', Boolean(card.why) || card.printed, JSON.stringify(card));
      check('the mascot says it could not start', /couldn't start/.test(card.speech), card.speech);
      await js(`document.querySelector('.proj.failed')?.scrollIntoView({ block: 'start' })`);
      await sleep(300);
      await shot('start-1-failed');
    }
    // Optional: SEEFAST_SMOKE_EXTRA=<folder> also screenshots that project's guide and overview in both shells, and Do it for me (layout checks).
    const extra = process.env.SEEFAST_SMOKE_EXTRA;
    if (extra) {
      await js(`window.__seefast.analyzeFolder(${JSON.stringify(extra)})`);
      await sleep(800);
      for (const sh of ['posix', 'powershell']) {
        await js(`window.__seefast.state.shell = '${sh}'; window.__seefast.open('manual')`);
        await sleep(700);
        await shot(`extra-manual-${sh}`);
        // Back on the overview, the quick start follows the shell picked in the guide.
        await js(`window.__seefast.open('analysis')`);
        await sleep(700);
        await shot(`extra-overview-${sh}`);
      }
      await js(`window.__seefast.state.shell = 'posix'; window.__seefast.open('auto')`);
      await sleep(700);
      await shot('extra-auto');
    }
  } catch (e) {
    check('smoke run', false, (e as Error).stack ?? String(e));
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed (normal window); screenshots in ${outDir}`);
  app.exit(failed ? 1 : 0);
}
