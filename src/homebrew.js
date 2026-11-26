// Homebrew's old versions and stale downloads. We never delete these files
// ourselves: Homebrew's own `brew cleanup` knows what's still linked/in use.
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

function findBrew() {
  return BREW_PATHS.find((p) => fs.existsSync(p)) || null;
}

function brew(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Never auto-update or send analytics as a side effect of cleaning
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1' },
    }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}\n${stderr || ''}` }));
  });
}

// "This operation would free approximately 103.3MB of disk space." → bytes
function parseFreed(text) {
  const m = text.match(/(?:would free|freed) approximately ([\d.]+)\s*([KMGT]?B)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// Dry run: how much `brew cleanup` would free. 0 when nothing / no Homebrew.
async function estimate() {
  const bin = findBrew();
  if (!bin) return { bin: null, bytes: 0 };
  const { out } = await brew(bin, ['cleanup', '-n'], 30000);
  return { bin, bytes: parseFreed(out) };
}

// The real thing. Resolves { ok, bytes, error }.
async function cleanup() {
  const bin = findBrew();
  if (!bin) return { ok: false, bytes: 0, error: '没有找到 Homebrew' };
  const { err, out } = await brew(bin, ['cleanup'], 180000);
  if (err) return { ok: false, bytes: parseFreed(out), error: err.killed ? 'Homebrew 清理超时' : 'Homebrew 清理出错' };
  return { ok: true, bytes: parseFreed(out) };
}

// Where Homebrew keeps installed versions (for "show in Finder")
function cellarPath() {
  const bin = findBrew();
  return bin ? bin.replace(/\/bin\/brew$/, '/Cellar') : '/opt/homebrew/Cellar';
}

module.exports = { findBrew, estimate, cleanup, parseFreed, cellarPath };
