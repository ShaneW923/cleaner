const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage } = require('electron');
const path = require('node:path');
const { scanCaches, trashCaches } = require('./scanner');

let win;
let currentScan = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 540,
    title: 'Cleaner',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    // Match the CSS background so there's no white flash on launch
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b19' : '#ece6da',
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
  // app.getFileIcon returns a generic placeholder for most .app bundles on
  // recent macOS; QuickLook thumbnails give the real icon.
  try {
    const img = await nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 });
    if (!img.isEmpty()) url = img.toDataURL();
  } catch {}
  if (!url) {
    try {
      const img = await app.getFileIcon(appPath, { size: 'normal' });
      if (!img.isEmpty()) url = img.toDataURL();
    } catch {}
  }
  iconCache.set(appPath, url);
  return url;
}

ipcMain.handle('scan:start', async () => {
  if (currentScan) currentScan.cancel();
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  const scan = scanCaches({
    // Awaited by the scanner, so every item is sent before the scan reports done.
    onItem: async (item) => send('scan:item', { ...item, icon: await appIcon(item.iconPath) }),
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

// Ignore list: ids of rows the user never wants to see, kept in the app's
// own data folder (~/Library/Application Support/cleaner/ignored.json).
const ignoredFile = () => path.join(app.getPath('userData'), 'ignored.json');
ipcMain.handle('ignored:load', async () => {
  try {
    const ids = JSON.parse(await require('node:fs/promises').readFile(ignoredFile(), 'utf8'));
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
});
ipcMain.handle('ignored:save', async (_e, ids) => {
  const clean = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  await require('node:fs/promises').writeFile(ignoredFile(), JSON.stringify(clean, null, 2));
});

// Free / total space on the startup disk.
ipcMain.handle('disk', async () => {
  try {
    const s = await require('node:fs/promises').statfs('/');
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
