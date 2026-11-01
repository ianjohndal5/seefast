# Floating windows per platform

The launcher's bubble is a transparent, frameless, always-on-top 64×64 window that the user drags and that grows
into panels. What each OS allows decides how it behaves. This page records what the app does per platform, what was
verified, and the fallbacks.

## Summary

| | Transparent, frameless | Stays on top | Positions itself | Global shortcut | Tray / menu bar | Mode |
| --- | --- | --- | --- | --- | --- | --- |
| Windows 10/11 | yes | yes | yes | yes | notification area | floating |
| macOS 13+ | yes | yes, also over full-screen Spaces | yes | yes | menu bar (template icon) | floating |
| Linux, X11 | yes with a compositing window manager | yes | yes | yes | needs a StatusNotifier host | floating |
| Linux, Wayland (GNOME, KDE...) | native: yes | **no** | **no** | **no** on GNOME | as X11 | **normal window** (default); floating through XWayland only when chosen |

**What was verified, and how.** On Arch Linux, GNOME on Wayland, Intel Tiger Lake GPU (Mesa), Electron 44.7.2, by a
person looking at the screen: native Wayland windows appear; **no Electron window appears through XWayland at all**,
opaque or transparent. Electron still reports such windows as visible at the right place, and the smoke test's
screenshots come from inside Chromium, so the smoke test passed while nothing was on screen. That is why the floating
bubble is not the default on Wayland any more. The smoke test (`cd app && npm run smoke`) now checks the normal window
by default on Wayland (8 checks) and the bubble with `SEEFAST_WINDOW=floating` (16 checks); neither proves that
pixels reach the screen. The Windows and macOS rows are from the Electron documentation and platform behaviour; they
have not been run on those systems yet.

## What the app does

* **Window.** `frame: false`, `transparent: true`, `resizable: false`, `skipTaskbar: true`, `hasShadow: false`, shown
  with `showInactive()` so the bubble never steals focus from the app the user is in.
* **Always on top.** `setAlwaysOnTop(true, 'screen-saver')` on Windows and Linux; on macOS `type: 'panel'` (an
  NSPanel), level `floating`, and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` so it does not
  disappear behind full-screen Spaces. The Dock icon is hidden in floating mode; the menu bar icon brings the bubble
  back.
* **Morphing.** The window is first resized to the panel's rectangle while still transparent; the renderer animates
  the circle's position, size and corner radius into the panel. The panel opens toward the side of the screen with
  more room and is clamped into the display's work area (never under a taskbar, dock or menu bar). Between two panel
  shapes the window briefly takes the union of both rectangles. Animated `setBounds` is macOS-only, so it is not
  used. With "reduce motion" (OS setting or the app's setting) the change is instant.
* **Drag vs click.** Pointer events with pointer capture in the renderer; more than 5 DIPs of movement is a drag,
  anything else a click. The main process moves the window to follow `screen.getCursorScreenPoint()`, which stays
  correct across monitors with different scale factors where renderer coordinates jump. `-webkit-app-region: drag` is
  not used on the bubble because it swallows clicks.
* **Position memory.** Saved as the display id plus the position as a fraction of that display's work area. On start
  and on `display-added`, `display-removed` and `display-metrics-changed`, the bubble returns to its display, or the
  primary one at the same relative place, and is clamped fully on screen. Size is re-asserted with every `setBounds`
  because Windows can rescale a window that crosses monitors with different scaling.
* **Keyboard and screen readers.** The bubble is a `<button>`: Enter or Space opens; arrow keys move it 10 px
  (Shift: 50 px); right-click or the context-menu key opens the native menu (recent projects, settings, quit). Panels
  are `role="dialog"` with a focused heading; Escape goes back, then collapses; focus returns to the bubble. Runner
  progress is announced in an `aria-live` region.
* **Global shortcut.** `CommandOrControl+Alt+K` by default, configurable in Settings. Where the desktop refuses
  global shortcuts (native Wayland, or a conflict), the setting says so; `seefast-app --toggle` (single instance)
  can be bound to a shortcut in the desktop's own settings.

## Linux and Wayland

Under Wayland, an app cannot set its own position or keep itself above other windows (xdg-shell gives the
compositor full control; layer-shell exists on wlroots and KDE but not GNOME). So under Wayland the app opens as a
normal decorated window with the same panels. Only when the user picks "Floating bubble" (and XWayland is available,
`DISPLAY` set) does it pass `--ozone-platform=x11` and run as an X11 client, where GNOME and KDE honour position and
`_NET_WM_STATE_ABOVE`, on machines where Electron can draw into XWayland windows.

**On Wayland the app opens as a normal window by default.** Settings → Window → "Floating bubble" runs it through
XWayland instead (`--ozone-platform=x11`), where GNOME and KDE honour position and always-on-top, but on some
machines Electron cannot draw into XWayland windows at all, and the app cannot detect that. If the bubble does not
appear, start the app with `SEEFAST_WINDOW=window` (or choose "Normal window" in Settings).

When the floating bubble runs through XWayland, the app starts with hardware acceleration off. On GNOME with an Intel Tiger Lake GPU (Mesa), Electron
44's GPU process crashes three times under XWayland for *any* window (opaque ones too) before Chromium falls back
to software rendering; starting in software rendering avoids the crashes and the delay. Set `SEEFAST_GPU=1` to keep
hardware acceleration where it works. Two startup lines remain and are harmless: a GTK `gtk_widget_get_scale_factor`
assertion Electron prints on Linux, and one `XGetWindowAttributes failed for window 1` from Chromium's software
renderer.

GNOME on Wayland does not let apps grab keys globally, so the default shortcut cannot be registered there; the app
says so at start. Use the bubble's right-click menu, or add a custom shortcut in GNOME Settings that runs the app
with `--toggle`.

Transparency on X11 needs a compositing window manager. Without one the corners of the bubble render black; pick
"Normal window" in Settings.

The tray icon uses the StatusNotifierItem protocol. KDE, XFCE, Cinnamon and most others show it; GNOME needs the
AppIndicator extension. Without a tray, the bubble's right-click menu offers the same items.

## Windows notes

* Transparent windows cannot be resized by the user; the app never asks them to.
* Focus stealing is avoided with `showInactive()`; the folder picker is a normal modal dialog.
* Electron is per-monitor DPI aware (v2): all geometry is in DIPs; the size is re-asserted after moves.
* PowerShell users: npm and pnpm ship `.ps1` shims that the default execution policy blocks. The doctor detects
  `Restricted` / `AllSigned` and suggests `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. The runner never
  goes through PowerShell: it runs `.cmd` shims through `cmd.exe` with checked arguments.

## Smoke test (Linux, XWayland)

`npm run smoke` in `app/` (with `ELECTRON_RUN_AS_NODE` unset, which VS Code's terminal sets):

```
ok   bubble is a 64×64 always-on-top window
ok   dragging moves the bubble
ok   a drag is not a click
ok   a drag past the screen edge keeps the bubble fully visible
ok   still no click after three drags
ok   a click opens the folder picker once
ok   analysis panel opens
ok   panel stays inside the work area
ok   analysis shows projects and requirements
ok   focus moves into the panel
ok   manual guide lists commands with copy buttons
ok   doctor reports results
ok   automated mode dry run finishes without executing
ok   Escape goes back to the overview
ok   Escape collapses back to the bubble where it was
ok   focus returns to the bubble
16/16 checks passed
```

Screenshots of each shape are written to `app/out/smoke/`. Display hot-plugging and mixed-DPI moves are covered by
unit tests of the geometry functions (`test/geometry.test.ts`), not by the smoke test.
