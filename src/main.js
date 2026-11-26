const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { scanCaches, folderSize } = require('./scanner');
const { runningAppPaths } = require('./apps');
const cleaner = require('./cleaner');
const protect = require('./protect');
const oplog = require('./oplog');
const homebrew = require('./homebrew');

let win;
let currentScan = null;
// Scanner records from the latest scan, by groupKey. Cleaning works only from
// these — the UI sends row keys, never paths.
let lastScan = new Map();

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
  const records = new Map();
  lastScan = records;
  const scan = scanCaches({
    // Awaited by the scanner, so every item is sent before the scan reports done.
    onItem: async (item) => {
      if (!records.has(item.groupKey)) records.set(item.groupKey, []);
      records.get(item.groupKey).push(item);
      send('scan:item', { ...item, icon: await appIcon(item.iconPath) });
    },
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

async function diskFree() {
  try {
    const s = await fs.statfs('/');
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

// Clean the rows with these group keys. Returns per-folder results plus the
// free space measured before and after (the real amount released).
ipcMain.handle('clean', async (_e, keys) => {
  const items = (Array.isArray(keys) ? keys : []).flatMap((k) => lastScan.get(k) || []);
  const before = await diskFree();
  const procs = new Set();
  const results = await cleaner.clean(items, {
    protect: await protect.load(protectFile(), legacyIgnoredFile()),
    runningApps: runningAppPaths,
    sizeOf: async (p) => (await folderSize(p, procs)).bytes,
    trash: (p) => shell.trashItem(p),
    remove: cleaner.removePath,
    runCommand: async (name) => (name === 'homebrew' ? homebrew.cleanup() : { ok: false, error: '未知命令' }),
  });
  try { await oplog.append(results); } catch {}
  const after = await diskFree();
  // Drop cleaned folders from the records so they can't be cleaned twice
  for (const r of results) {
    if (['deleted', 'trashed', 'command'].includes(r.action)) {
      const list = (lastScan.get(r.groupKey) || []).filter((it) => it.path !== r.path);
      list.length ? lastScan.set(r.groupKey, list) : lastScan.delete(r.groupKey);
    }
  }
  return {
    results,
    disk: after,
    freedMeasured: before && after ? Math.max(0, after.free - before.free) : null,
    logFile: oplog.LOG_FILE,
  };
});

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

// Protect list (formerly "ignore"): kept in the app's data folder,
// ~/Library/Application Support/cleaner/protected.json
const protectFile = () => path.join(app.getPath('userData'), 'protected.json');
const legacyIgnoredFile = () => path.join(app.getPath('userData'), 'ignored.json');
ipcMain.handle('protect:load', () => protect.load(protectFile(), legacyIgnoredFile()));
ipcMain.handle('protect:save', (_e, ids) => protect.save(protectFile(), ids));

// Free / total space on the startup disk.
ipcMain.handle('disk', diskFree);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
