// Cache scanning and trashing logic. No UI code here, so the interface can be
// redesigned later without touching this file.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildAppIndex, matchApp } = require('./apps');

const CACHES_DIR = path.join(os.homedir(), 'Library', 'Caches');
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

// Scans ~/Library/Caches one top-level folder at a time.
// onItem(item) is called as each result is ready; onProgress({done,total,current}).
// Returns { cancel(), done: Promise }.
function scanCaches({ onItem, onProgress }) {
  let cancelled = false;
  const procs = new Set();

  const done = (async () => {
    const [entries, index] = await Promise.all([
      fs.readdir(CACHES_DIR, { withFileTypes: true }),
      buildAppIndex(),
    ]);
    const dirs = entries.filter((e) => e.isDirectory());
    const total = dirs.length;
    let next = 0;
    let finished = 0;

    async function worker() {
      while (!cancelled && next < dirs.length) {
        const entry = dirs[next++];
        const full = path.join(CACHES_DIR, entry.name);
        onProgress({ done: finished, total, current: entry.name });
        const { bytes, partial } = await folderSize(full, procs);
        if (cancelled) return;
        finished++;
        const app = matchApp(entry.name, index);
        const system = isAppleSystem(entry.name);
        onItem({
          id: entry.name,
          path: full,
          folder: entry.name,
          bytes,
          partial,
          system,
          appName: app ? app.name : null,
          appPath: app ? app.path : null,
          appFound: Boolean(app) || system,
        });
        onProgress({ done: finished, total, current: entry.name });
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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

// Only allow trashing a direct child of ~/Library/Caches. Anything else —
// the Caches folder itself, deeper paths, paths escaping via "..", or
// symlinks pointing elsewhere — is refused.
async function assertSafeCacheTarget(target) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== CACHES_DIR) {
    throw new Error(`拒绝：不在缓存文件夹第一层 (${target})`);
  }
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error(`拒绝：这是一个替身/符号链接 (${target})`);
  return resolved;
}

// trashFn is Electron's shell.trashItem (moves to Trash, never deletes).
async function trashCaches(paths, trashFn) {
  const results = [];
  for (const p of paths) {
    try {
      const safe = await assertSafeCacheTarget(p);
      await trashFn(safe);
      results.push({ path: p, ok: true });
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { CACHES_DIR, scanCaches, trashCaches, assertSafeCacheTarget };
