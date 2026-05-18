import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  saveConfig: (values: unknown) => ipcRenderer.invoke('wizard:saveConfig', values),
  startBootstrap: () => ipcRenderer.invoke('wizard:startBootstrap'),
  onBootstrapOutput: (cb: (data: { stream: 'stdout' | 'stderr' | 'exit'; text?: string; code?: number }) => void) => {
    const listener = (_: unknown, payload: { stream: 'stdout' | 'stderr' | 'exit'; text?: string; code?: number }) => cb(payload);
    ipcRenderer.on('wizard:bootstrapOutput', listener);
    return () => ipcRenderer.removeListener('wizard:bootstrapOutput', listener);
  },
  finish: (opts: { autostart: boolean }) => ipcRenderer.invoke('wizard:finish', opts),
  // Importer (Task 18-19):
  pickLegacyFolder: () => ipcRenderer.invoke('wizard:pickLegacyFolder'),
  importLegacy: (folder: string) => ipcRenderer.invoke('wizard:importLegacy', folder),
  onImportProgress: (cb: (p: { task: string; percent: number }) => void) => {
    const listener = (_: unknown, payload: { task: string; percent: number }) => cb(payload);
    ipcRenderer.on('wizard:importProgress', listener);
    return () => ipcRenderer.removeListener('wizard:importProgress', listener);
  },
});
