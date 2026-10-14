const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  focusFix: () => ipcRenderer.send('focus-fix'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  // Requêtes Supabase exécutées par le processus principal (réseau fiable, sans restrictions CORS)
  fetch: req => ipcRenderer.invoke('net-fetch', req)
});
