const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  focusFix: () => ipcRenderer.send('focus-fix'),
  getVersion: () => ipcRenderer.invoke('app-version')
});
