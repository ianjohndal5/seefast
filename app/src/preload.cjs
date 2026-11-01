// The renderer's only bridge to the app: a small, explicit API. No Node access in the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cr', {
  info: () => ipcRenderer.invoke('info'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  analyze: (root) => ipcRenderer.invoke('analyze', String(root)),
  shape: (kind) => ipcRenderer.invoke('shape', String(kind)),
  collapse: () => ipcRenderer.invoke('collapse'),
  collapseTarget: () => ipcRenderer.invoke('collapse-target'),
  settle: () => ipcRenderer.invoke('settle'),
  drag: (phase, x, y) => ipcRenderer.send('drag', phase, x, y),
  nudge: (dx, dy) => ipcRenderer.send('nudge', Number(dx), Number(dy)),
  copy: (text) => ipcRenderer.invoke('copy', String(text)),
  doctor: () => ipcRenderer.invoke('doctor'),
  support: () => ipcRenderer.invoke('support'),
  renderAction: (action, shell) => ipcRenderer.invoke('render-action', action, shell),
  writeSetupMd: () => ipcRenderer.invoke('write-setup-md'),
  runSetup: (opts) => ipcRenderer.invoke('run-setup', opts),
  consent: (id, decision) => ipcRenderer.send('consent', Number(id), String(decision)),
  stop: () => ipcRenderer.send('stop'),
  startApp: () => ipcRenderer.invoke('start-app'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  forgetRecent: () => ipcRenderer.invoke('forget-recent'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  openPath: (p) => ipcRenderer.invoke('open-path', String(p)),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, cb) => {
    if (!['runner', 'start', 'command'].includes(channel)) return () => {};
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
