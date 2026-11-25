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

// Returns {
//   byId:      Map<bundleId, app>          "com.openai.codex"
//   byName:    Map<app name, app>          "chatgpt"
//   byLastSeg: Map<last bundle id part, app>  "codex" (from com.openai.codex)
// } — all keys lowercase.
async function buildAppIndex() {
  const out = await run('mdfind', ["kMDItemContentType == 'com.apple.application-bundle'"]);
  const paths = out.split('\n').filter(Boolean);
  const byId = new Map();
  const byName = new Map();
  const byLastSeg = new Map();

  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const ids = (await run('mdls', ['-raw', '-name', 'kMDItemCFBundleIdentifier', ...chunk])).split('\0');
    chunk.forEach((appPath, j) => {
      const name = path.basename(appPath, '.app');
      const id = ids[j] && ids[j] !== '(null)' ? ids[j] : null;
      addApp({ byId, byName, byLastSeg }, { path: appPath, name, bundleId: id });
    });
  }
  return { byId, byName, byLastSeg };
}

function addApp(index, info) {
  const id = info.bundleId && info.bundleId.toLowerCase();
  if (id && !index.byId.has(id)) index.byId.set(id, info);
  const name = info.name.toLowerCase();
  if (!index.byName.has(name)) index.byName.set(name, info);
  if (id && id.split('.').length >= 3) {
    const last = id.split('.').pop();
    if (!index.byLastSeg.has(last)) index.byLastSeg.set(last, info);
  }
}

// Match a ~/Library/Caches folder name to an installed app, or null.
function matchApp(folderName, index) {
  const lower = folderName.toLowerCase();

  // Bundle-id style: "com.foo.bar.ShipIt" → com.foo.bar.ShipIt, then com.foo.bar.
  // Never shortens below three parts, so "com.foo" can't match every foo app.
  if (lower.includes('.')) {
    const parts = lower.split('.');
    for (let n = parts.length; n >= Math.min(3, parts.length); n--) {
      const hit = index.byId.get(parts.slice(0, n).join('.'));
      if (hit) return hit;
    }
    return null;
  }

  // Plain names
  const exact = index.byName.get(lower);
  if (exact) return exact;
  // "Codex" → the app whose bundle id ends in ".codex" (ChatGPT.app is com.openai.codex)
  const bySeg = index.byLastSeg && index.byLastSeg.get(lower);
  if (bySeg) return bySeg;
  for (const [name, info] of index.byName) {
    // Vendor-named folder: "Google" → "Google Chrome"
    if (name.startsWith(lower + ' ')) return info;
    // App name + a new capitalised word: "LarkShell" → "Lark", but not
    // "Homebrew" → "Home". Short names skipped to avoid accidents.
    if (name.length >= 4 && lower.startsWith(name) && /[A-Z0-9_-]/.test(folderName[name.length])) return info;
  }
  return null;
}

// Paths of .app bundles that currently have a running process.
async function runningAppPaths() {
  const out = await run('ps', ['-axo', 'comm=']);
  const running = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^(.*?\.app)\/Contents\//);
    if (m) running.add(m[1]);
  }
  return running;
}

module.exports = { buildAppIndex, matchApp, addApp, runningAppPaths };
