// Index of installed apps, built from Spotlight, so cache folders can be
// matched back to the app that owns them.
const { execFile } = require('node:child_process');
const path = require('node:path');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : stdout);
    });
  });
}

// Returns { byId: Map<bundleId(lowercase), appInfo>, byName: Map<name(lowercase), appInfo> }
async function buildAppIndex() {
  const out = await run('mdfind', ["kMDItemContentType == 'com.apple.application-bundle'"]);
  const paths = out.split('\n').filter(Boolean);
  const byId = new Map();
  const byName = new Map();

  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const ids = (await run('mdls', ['-raw', '-name', 'kMDItemCFBundleIdentifier', ...chunk])).split('\0');
    chunk.forEach((appPath, j) => {
      const name = path.basename(appPath, '.app');
      const id = ids[j] && ids[j] !== '(null)' ? ids[j] : null;
      const info = { path: appPath, name, bundleId: id };
      if (id && !byId.has(id.toLowerCase())) byId.set(id.toLowerCase(), info);
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), info);
    });
  }
  return { byId, byName };
}

// Match a ~/Library/Caches folder name to an installed app.
// "com.foo.bar.ShipIt" → tries com.foo.bar.ShipIt, then com.foo.bar.
// Never shortens below three parts, so "com.foo" can't match every foo app.
function matchApp(folderName, index) {
  const lower = folderName.toLowerCase();
  if (lower.includes('.')) {
    const parts = lower.split('.');
    for (let n = parts.length; n >= Math.min(3, parts.length); n--) {
      const hit = index.byId.get(parts.slice(0, n).join('.'));
      if (hit) return hit;
    }
    return null;
  }
  const exact = index.byName.get(lower);
  if (exact) return exact;
  // Vendor-named folders, e.g. "Google" → "Google Chrome"
  for (const [name, info] of index.byName) {
    if (name.startsWith(lower + ' ')) return info;
  }
  return null;
}

module.exports = { buildAppIndex, matchApp };
