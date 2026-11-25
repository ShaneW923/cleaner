const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const { scanCaches, trashCaches } = require('./scanner');

let win;
let currentScan = null;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    title: 'Cleaner',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const iconCache = new Map();
async function appIcon(appPath) {
  if (!appPath) return null;
  if (iconCache.has(appPath)) return iconCache.get(appPath);
  let url = null;
  try {
    const img = await app.getFileIcon(appPath, { size: 'normal' });
    url = img.isEmpty() ? null : img.toDataURL();
  } catch {
    url = null;
  }
  iconCache.set(appPath, url);
  return url;
}

ipcMain.handle('scan:start', async () => {
  if (currentScan) currentScan.cancel();
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  const scan = scanCaches({
    // Awaited by the scanner, so every item is sent before the scan reports done.
    onItem: async (item) => send('scan:item', { ...item, icon: await appIcon(item.appPath) }),
    onProgress: (p) => send('scan:progress', p),
  });
  currentScan = scan;
  try {
    const result = await scan.done;
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (currentScan === scan) currentScan = null;
  }
});

ipcMain.handle('scan:cancel', () => {
  if (currentScan) currentScan.cancel();
});

ipcMain.handle('trash', (_e, paths) => trashCaches(paths, (p) => shell.trashItem(p)));

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
