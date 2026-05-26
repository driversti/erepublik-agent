// CommonJS preload script. Electron 31's preload mechanism does not support
// ESM without extra configuration, so we keep this one file as plain CJS.
// The rest of the electron/ tree stays ESM. See electron/preload.ts (deleted)
// in git history for the previous ESM version that silently failed to load.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Step 1 commit
  saveConfig: (values) => ipcRenderer.invoke('wizard:saveConfig', values),
  // Step 2 trigger + stream
  startBootstrap: () => ipcRenderer.invoke('wizard:startBootstrap'),
  onBootstrapOutput: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('wizard:bootstrapOutput', listener);
    return () => ipcRenderer.removeListener('wizard:bootstrapOutput', listener);
  },
  // Step 3 finalization
  finish: (opts) => ipcRenderer.invoke('wizard:finish', opts),
  // Legacy importer
  pickLegacyFolder: () => ipcRenderer.invoke('wizard:pickLegacyFolder'),
  importLegacy: (folder) => ipcRenderer.invoke('wizard:importLegacy', folder),
  onImportProgress: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('wizard:importProgress', listener);
    return () => ipcRenderer.removeListener('wizard:importProgress', listener);
  },
  // Update notifications
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  restartNow: () => ipcRenderer.invoke('update:restartNow'),
  onUpdateReady: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('update:ready', listener);
    return () => ipcRenderer.removeListener('update:ready', listener);
  },
});

// Confirm load via console — visible in DevTools if it ran.
console.log('[preload] electronAPI exposed on window');
