// Does the actual cleaning. The UI only says *which* rows; everything else —
// delete permanently or move to Trash, and whether it's still safe right now —
// is decided here from the scanner's own records.
//
// Gates, checked at the moment of cleaning (not just at scan time):
//   1. Protect list must be readable, and the row must not be on it
//   2. The owning app must not be running (or "can't tell" → skip)
//   3. Path must still be an allowed location, exist, and not be a symlink
//   4. It must not have grown a lot since the scan (something's using it)
// Then: "recommend" rows are deleted permanently, the rest go to the Trash.
const fs = require('node:fs/promises');
const { assertSafeCacheTarget } = require('./scanner');

const GROWTH_LIMIT = { ratio: 0.25, bytes: 100e6 };

function grewTooMuch(before, now) {
  return now - before > Math.max(before * GROWTH_LIMIT.ratio, GROWTH_LIMIT.bytes);
}

// items: scanner records for the rows the user picked (each has path, bytes,
//   level, appPath?, appName?, groupKey, command?)
// deps: {
//   protect: { ok, ids, error },        — from protect.load()
//   runningApps(): Set | null,          — null = couldn't tell
//   sizeOf(path): bytes,
//   trash(path), remove(path),
//   runCommand(name): { ok, bytes, error },
// }
// Returns [{ path, groupKey, action: deleted|trashed|command|skipped|failed, bytes, reason }]
async function clean(items, deps) {
  const results = [];
  const push = (it, action, reason, bytes = it.bytes) =>
    results.push({ path: it.path, groupKey: it.groupKey, action, bytes, reason });

  if (!deps.protect.ok) {
    for (const it of items) push(it, 'skipped', `${deps.protect.error}，为了安全没有清理`);
    return results;
  }
  const protectedIds = new Set(deps.protect.ids);
  const running = await deps.runningApps();

  for (const it of items) {
    if (protectedIds.has(it.groupKey)) { push(it, 'skipped', '在保护名单里'); continue; }

    if (it.appPath) {
      if (running === null) { push(it, 'skipped', `无法确认 ${it.appName} 是否在运行`); continue; }
      if (running.has(it.appPath)) { push(it, 'skipped', `${it.appName} 正在运行，请先退出`); continue; }
    }

    if (it.command) {
      try {
        const r = await deps.runCommand(it.command);
        if (r.ok) push(it, 'command', '', r.bytes || it.bytes);
        else push(it, 'failed', r.error, 0);
      } catch (e) {
        push(it, 'failed', e.message, 0);
      }
      continue;
    }

    let safe;
    try {
      safe = await assertSafeCacheTarget(it.path);
    } catch (e) {
      push(it, 'skipped', e.code === 'ENOENT' ? '已经不存在了' : e.message, 0);
      continue;
    }
    const now = await deps.sizeOf(safe);
    if (grewTooMuch(it.bytes, now)) {
      push(it, 'skipped', '扫描后变大了很多，可能正在被使用', now);
      continue;
    }
    try {
      if (it.level === 'recommend') { await deps.remove(safe); push(it, 'deleted', '', now); }
      else { await deps.trash(safe); push(it, 'trashed', '', now); }
    } catch (e) {
      push(it, 'failed', e.message, 0);
    }
  }
  return results;
}

// Permanent delete. Only ever called on a path that passed assertSafeCacheTarget.
async function removePath(p) {
  await fs.rm(p, { recursive: true, force: false, maxRetries: 2 });
}

module.exports = { clean, removePath, grewTooMuch };
