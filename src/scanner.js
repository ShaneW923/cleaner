// Cache scanning and trashing logic. No UI code here, so the interface can be
// redesigned later without touching this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildAppIndex, matchApp, runningAppPaths } = require('./apps');
const { advise, isSystem, TOOLS } = require('./advisor');
const { analyzeContents } = require('./contents');
const { CACHES_DIR, LOGS_DIR, OWN_LOG_DIR, CHILD_ROOTS, EXTRA_TARGETS, presetFor, isAllowedTarget } = require('./locations');
const homebrew = require('./homebrew');

const CONTENT_MIN_BYTES = 20 * 1000 * 1000;

// Which file's Finder icon to show for each kind of row.
const ICONS = {
  tool: '/System/Applications/Utilities/Terminal.app',
  system: '/System/Applications/System Settings.app',
};

const CONCURRENCY = 6;

// Size of a folder in bytes, via `du` (fast, handles APFS sizes the same way
// Finder does). `partial` is true when some subfolders couldn't be read.
function folderSize(target, procs) {
  return new Promise((resolve) => {
    const child = spawn('du', ['-sk', target]);
    procs.add(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      procs.delete(child);
      const kb = parseInt(out.split('\t')[0], 10);
      resolve({ bytes: Number.isFinite(kb) ? kb * 1024 : 0, partial: err.length > 0 });
    });
  });
}

function isAppleSystem(name) {
  return name.toLowerCase().startsWith('com.apple.');
}

// Every folder to measure: first-level folders of each child root, plus the
// fixed extra targets that exist on this Mac.
async function listTargets() {
  const targets = [];
  for (const root of CHILD_ROOTS) {
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (full === OWN_LOG_DIR) continue;
      // Logs: loose .log files count too; elsewhere only folders
      if (e.isDirectory() || (root === LOGS_DIR && e.isFile())) targets.push({ full, folder: e.name, root });
    }
  }
  for (const t of EXTRA_TARGETS) {
    try {
      const st = await fs.lstat(t.path);
      if (st.isDirectory()) targets.push({ full: t.path, folder: t.rel, root: null });
    } catch {}
  }
  return targets;
}

// Scans every target folder.
// onItem(item) is called as each result is ready; onProgress({done,total,current}).
// Returns { cancel(), done: Promise }.
function scanCaches({ onItem, onProgress }) {
  let cancelled = false;
  const procs = new Set();

  const done = (async () => {
    const [dirs, index, running, brewEstimate] = await Promise.all([
      listTargets(),
      buildAppIndex(),
      runningAppPaths(),
      homebrew.estimate().catch(() => ({ bytes: 0 })),
    ]);
    // Unreadable process table → treat every app as possibly running
    const isRunning = (appPath) => (running ? running.has(appPath) : true);
    const total = dirs.length;
    let next = 0;
    let finished = 0;

    async function worker() {
      while (!cancelled && next < dirs.length) {
        const entry = dirs[next++];
        const full = entry.full;
        onProgress({ done: finished, total, current: entry.folder });
        const { bytes, partial } = await folderSize(full, procs);
        if (cancelled) return;
        // Outside ~/Library/Caches it's a known tool location, never an app's
        const preset = presetFor(full);
        const isTool = Boolean((preset && !preset.appMatch) || TOOLS[entry.folder.toLowerCase()]);
        const canMatch = entry.root === CACHES_DIR || (preset && preset.appMatch);
        const app = isTool || !canMatch ? null : matchApp(entry.folder.replace(/\.log$/i, ''), index);
        const base = {
          id: full,
          path: full,
          folder: entry.folder,
          preset,
          bytes,
          partial,
          system: entry.root === CACHES_DIR && isAppleSystem(entry.folder),
          appName: app ? app.name : null,
          appBundleId: app ? app.bundleId : null,
          appPath: app ? app.path : null,
          appRunning: Boolean(app && isRunning(app.path)),
        };
        base.system = entry.root === CACHES_DIR && isSystem(base);
        try { base.mtimeMs = (await fs.stat(full)).mtimeMs; } catch {}
        // Look inside sizeable app / unidentified caches for images and video
        if (!isTool && !(base.system && !app) && bytes >= CONTENT_MIN_BYTES) {
          onProgress({ done: finished, total, current: `${entry.folder}（检查内容）` });
          base.contents = await analyzeContents(full);
          if (cancelled) return;
        }
        finished++;
        const advice = advise(base);
        // "Running" only matters for app caches (e.g. not the Electron download cache)
        if (advice.kind !== 'app') base.appRunning = false;
        await onItem({
          ...base,
          ...advice,
          // Rows merge by this key (same app + same type), and the protect
          // list stores it, so it must stay stable between scans.
          groupKey: base.appPath ? `${base.appPath}|${advice.type}` : full,
          // Finder icon source: the app itself, Terminal for tools,
          // System Settings for macOS, else the folder's own icon.
          iconPath: app ? app.path : ICONS[advice.kind] || full,
        });
        onProgress({ done: finished, total, current: entry.folder });
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Homebrew old versions: measured by `brew cleanup -n`, cleaned by Homebrew
    if (!cancelled && brewEstimate.bytes > 0) {
      const base = { id: 'cmd:homebrew', path: homebrew.cellarPath(), folder: 'Homebrew 旧版本', bytes: brewEstimate.bytes,
        command: 'homebrew', preset: { name: 'Homebrew 旧版本', type: 'oldversion' } };
      await onItem({ ...base, ...advise(base), groupKey: 'cmd:homebrew', iconPath: ICONS.tool });
    }
    return { cancelled, total };
  })();

  return {
    cancel() {
      cancelled = true;
      for (const p of procs) p.kill();
    },
    done,
  };
}

// Only allow cleaning a direct child of ~/Library/Caches or ~/.cache, or one
// of the fixed extra cache folders (see locations.js). Anything else — the
// roots themselves, deeper paths, paths escaping via "..", or symlinks
// pointing elsewhere — is refused.
async function assertSafeCacheTarget(target) {
  const resolved = path.resolve(target);
  if (!isAllowedTarget(resolved)) {
    throw new Error(`拒绝：不在允许清理的位置 (${target})`);
  }
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error(`拒绝：这是一个替身/符号链接 (${target})`);
  return resolved;
}

module.exports = { CACHES_DIR, scanCaches, assertSafeCacheTarget, folderSize };
