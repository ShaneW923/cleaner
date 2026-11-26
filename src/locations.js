// Where we look for caches, and the only places anything may be trashed from.
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const CACHES_DIR = path.join(HOME, 'Library', 'Caches');
const DOT_CACHE_DIR = path.join(HOME, '.cache');
const LOGS_DIR = path.join(HOME, 'Library', 'Logs');
// Our own operation log lives here — never offered for cleaning.
const OWN_LOG_DIR = path.join(LOGS_DIR, 'cleaner');

// Folders whose first-level children are each a separate item.
const CHILD_ROOTS = [CACHES_DIR, DOT_CACHE_DIR, LOGS_DIR];

// Single, well-known cache folders outside those roots. Each is trashed as a
// whole, and only these exact paths are allowed.
//   type/level: see advisor.js TYPES; level overrides the type's default
const EXTRA_TARGETS = [
  { rel: '.nvm/.cache', name: 'nvm', type: 'build',
    reason: 'nvm 安装 Node 时下载的源码和编译文件，已经装好的 Node 不受影响' },
  { rel: '.npm/_cacache', name: 'npm', type: 'download' },
  { rel: '.npm/_npx', name: 'npx', type: 'download' },
  { rel: '.yarn/berry/cache', name: 'Yarn', type: 'download' },
  { rel: '.bun/install/cache', name: 'Bun', type: 'download' },
  { rel: '.gradle/caches', name: 'Gradle', type: 'download' },
  { rel: '.cargo/registry/cache', name: 'Cargo', type: 'download' },
  { rel: 'Library/Developer/Xcode/DerivedData', name: 'Xcode DerivedData', type: 'build',
    reason: 'Xcode 编译项目时生成的中间文件，下次编译时重新生成（第一次会慢一些）' },
].map((t) => ({ ...t, path: path.join(HOME, t.rel) }));

// Known children of ~/.cache. Anything else there is treated as a generic tool cache.
const DOT_CACHE_KNOWN = {
  uv: { name: 'uv（Python）', type: 'download' },
  pip: { name: 'pip', type: 'download' },
  'pre-commit': { name: 'pre-commit', type: 'download' },
  puppeteer: { name: 'Puppeteer 浏览器', type: 'download' },
  'ms-playwright': { name: 'Playwright 浏览器', type: 'download' },
  gdown: { name: 'gdown', type: 'download' },
  huggingface: { name: 'Hugging Face', type: 'model' },
  torch: { name: 'PyTorch', type: 'model' },
  'codex-runtimes': { name: 'Codex 运行环境', type: 'runtime' },
};

function presetFor(fullPath) {
  const extra = EXTRA_TARGETS.find((t) => t.path === fullPath);
  if (extra) return extra;
  if (path.dirname(fullPath) === LOGS_DIR) {
    const name = path.basename(fullPath);
    if (/^DiagnosticReports/i.test(name)) return { name: '诊断报告', type: 'crash', appMatch: false };
    if (/^com\.apple\./i.test(name)) return { name: name.replace(/^com\.apple\./i, ''), type: 'system', appMatch: false };
    // A log folder is usually named after its app; let the scanner match it
    return { name: name.replace(/\.log$/i, ''), type: 'log', appMatch: true };
  }
  if (path.dirname(fullPath) === DOT_CACHE_DIR) {
    const name = path.basename(fullPath);
    return DOT_CACHE_KNOWN[name.toLowerCase()] || { name, type: 'toolcache' };
  }
  return null;
}

// A path may be cleaned only if it's a direct child of one of CHILD_ROOTS
// (except our own log folder) or exactly one of EXTRA_TARGETS.
function isAllowedTarget(resolved) {
  if (resolved === OWN_LOG_DIR) return false;
  return CHILD_ROOTS.includes(path.dirname(resolved)) || EXTRA_TARGETS.some((t) => t.path === resolved);
}

module.exports = {
  HOME, CACHES_DIR, DOT_CACHE_DIR, LOGS_DIR, OWN_LOG_DIR, CHILD_ROOTS, EXTRA_TARGETS, presetFor, isAllowedTarget,
};
