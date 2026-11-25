const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cleaner', {
  startScan: () => ipcRenderer.invoke('scan:start'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  trash: (paths) => ipcRenderer.invoke('trash', paths),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  diskSpace: () => ipcRenderer.invoke('disk'),
  onItem: (fn) => ipcRenderer.on('scan:item', (_e, item) => fn(item)),
  onProgress: (fn) => ipcRenderer.on('scan:progress', (_e, p) => fn(p)),
});
