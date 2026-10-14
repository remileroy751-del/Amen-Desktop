const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_TITLE = 'Collège AMEN — AMEN-CONNECT Admin';
const ICON = path.join(__dirname, 'renderer', 'amen_logo.png');

app.setAppUserModelId('com.collegeamen.amenconnect.admin');

let mainWindow = null;

// ---------- mémorisation de la taille / position de la fenêtre ----------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return {}; }
}

function saveState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (_) { /* sans gravité */ }
}

function boundsVisible(s) {
  if (typeof s.x !== 'number' || typeof s.y !== 'number') return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return s.x >= a.x - 50 && s.y >= a.y - 50 && s.x < a.x + a.width - 100 && s.y < a.y + a.height - 100;
  });
}

// ---------- fenêtre principale ----------
function createWindow() {
  const st = loadState();
  const opts = {
    width: st.width || 1366,
    height: st.height || 840,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#FBF7F0',
    title: APP_TITLE,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  };
  if (boundsVisible(st)) { opts.x = st.x; opts.y = st.y; }

  mainWindow = new BrowserWindow(opts);
  if (st.maximized !== false) mainWindow.maximize(); // maximisée par défaut

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('page-title-updated', e => e.preventDefault());
  mainWindow.on('close', () => saveState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Fenêtres ouvertes par la page (impression des codes d'accès : about:blank)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 720,
          icon: ICON,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Empêche la fenêtre de quitter l'application (liens externes -> navigateur)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- menu en français ----------
function buildMenu() {
  const template = [
    {
      label: 'Fichier',
      submenu: [
        { label: 'Actualiser', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.reload() },
        { type: 'separator' },
        { label: 'Quitter', accelerator: 'Alt+F4', click: () => app.quit() }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'zoomIn', label: 'Zoom avant', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut', label: 'Zoom arrière', accelerator: 'CmdOrCtrl+-' },
        { role: 'resetZoom', label: 'Zoom normal', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Outils de développement' }])
      ]
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'À propos',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'À propos',
            message: 'Collège AMEN — AMEN-CONNECT',
            detail: 'Interface Super Admin Direction\nVersion bureau ' + app.getVersion() + '\nFonctionne aussi hors connexion : synchronisation automatique avec Supabase au retour d\u2019Internet.',
            icon: ICON,
            buttons: ['OK']
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lancement ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Aucune permission spéciale (caméra, micro, géolocalisation...) n'est nécessaire.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    // Export PDF : boîte « Enregistrer sous », puis ouverture du dossier.
    session.defaultSession.on('will-download', (_e, item) => {
      item.once('done', (_ev, state) => {
        if (state === 'completed') shell.showItemInFolder(item.getSavePath());
      });
    });

    ipcMain.handle('app-version', () => app.getVersion());
    // Correctif Windows : les champs de saisie perdent parfois le focus après alert()/confirm().
    ipcMain.on('focus-fix', e => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) { w.blur(); w.focus(); }
    });

    buildMenu();
    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
