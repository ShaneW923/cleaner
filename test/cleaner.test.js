const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clean, grewTooMuch } = require('../src/cleaner');
const protect = require('../src/protect');
const { parseFreed } = require('../src/homebrew');
const { parseRunning } = require('../src/apps');
const { CACHES_DIR, LOGS_DIR, OWN_LOG_DIR, isAllowedTarget } = require('../src/locations');

const MB = 1e6;

// Real folders inside ~/Library/Caches so the path checks run for real;
// deletion itself goes through recording fakes, so nothing is removed.
async function fixture(name) {
  const dir = path.join(CACHES_DIR, `com.cleaner-test.${name}.${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function deps(over = {}) {
  const calls = { removed: [], trashed: [], commands: [] };
  return {
    calls,
    protect: { ok: true, ids: [] },
    runningApps: async () => new Set(),
    sizeOf: async () => 10 * MB,
    remove: async (p) => calls.removed.push(p),
    trash: async (p) => calls.trashed.push(p),
    runCommand: async (n) => { calls.commands.push(n); return { ok: true, bytes: 5 * MB }; },
    ...over,
  };
}

test('recommended rows are deleted permanently, others go to the Trash', async () => {
  const a = await fixture('a'), b = await fixture('b');
  const d = deps();
  const r = await clean([
    { path: a, groupKey: a, bytes: 10 * MB, level: 'recommend' },
    { path: b, groupKey: b, bytes: 10 * MB, level: 'ok' },
  ], d);
  assert.deepStrictEqual(r.map((x) => x.action), ['deleted', 'trashed']);
  assert.deepStrictEqual([d.calls.removed, d.calls.trashed], [[a], [b]]);
  await fs.rm(a, { recursive: true }); await fs.rm(b, { recursive: true });
});

test('a running app, or not knowing, skips its rows', async () => {
  const a = await fixture('run');
  const row = { path: a, groupKey: a, bytes: 10 * MB, level: 'recommend', appPath: '/Applications/X.app', appName: 'X' };
  let d = deps({ runningApps: async () => new Set(['/Applications/X.app']) });
  assert.match((await clean([row], d))[0].reason, /正在运行/);
  d = deps({ runningApps: async () => null });
  assert.match((await clean([row], d))[0].reason, /无法确认/);
  assert.strictEqual(d.calls.removed.length, 0);
  await fs.rm(a, { recursive: true });
});

test('protected rows are skipped; an unreadable protect list stops everything', async () => {
  const a = await fixture('prot');
  const row = { path: a, groupKey: 'key-a', bytes: 10 * MB, level: 'recommend' };
  let d = deps({ protect: { ok: true, ids: ['key-a'] } });
  assert.strictEqual((await clean([row], d))[0].reason, '在保护名单里');
  d = deps({ protect: { ok: false, ids: [], error: '保护名单已损坏' } });
  const r = await clean([row], d);
  assert.strictEqual(r[0].action, 'skipped');
  assert.strictEqual(d.calls.removed.length, 0);
  await fs.rm(a, { recursive: true });
});

test('paths outside allowed places, missing or grown folders are skipped', async () => {
  const d = deps();
  const out = await clean([{ path: path.join(os.homedir(), 'Documents'), groupKey: 'x', bytes: 1, level: 'recommend' }], d);
  assert.match(out[0].reason, /拒绝/);
  const gone = await clean([{ path: path.join(CACHES_DIR, 'com.cleaner-test.missing'), groupKey: 'y', bytes: 1, level: 'recommend' }], d);
  assert.strictEqual(gone[0].reason, '已经不存在了');
  const a = await fixture('grow');
  const grown = await clean([{ path: a, groupKey: a, bytes: 10 * MB, level: 'recommend' }], deps({ sizeOf: async () => 500 * MB }));
  assert.match(grown[0].reason, /变大/);
  assert.strictEqual(d.calls.removed.length, 0);
  await fs.rm(a, { recursive: true });
});

test('command rows run their command instead of touching files', async () => {
  const d = deps();
  const r = await clean([{ path: '/opt/homebrew/Cellar', groupKey: 'cmd:homebrew', bytes: 100 * MB, level: 'recommend', command: 'homebrew' }], d);
  assert.deepStrictEqual([r[0].action, d.calls.commands, d.calls.removed], ['command', ['homebrew'], []]);
});

test('growth check tolerates small changes', () => {
  assert.ok(!grewTooMuch(100 * MB, 150 * MB));
  assert.ok(grewTooMuch(100 * MB, 300 * MB));
  assert.ok(!grewTooMuch(2000 * MB, 2400 * MB));
});

test('protect list: missing is empty, corrupt fails closed, save round-trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleaner-protect-'));
  const file = path.join(dir, 'protected.json');
  assert.deepStrictEqual(await protect.load(file), { ok: true, ids: [] });
  await fs.writeFile(file, '{oops');
  assert.strictEqual((await protect.load(file)).ok, false);
  await protect.save(file, ['a', 'b', 'a']);
  assert.deepStrictEqual(await protect.load(file), { ok: true, ids: ['a', 'b'] });
  await fs.rm(dir, { recursive: true });
});

test('our own log folder is never a cleaning target; other logs are', () => {
  assert.ok(!isAllowedTarget(OWN_LOG_DIR));
  assert.ok(isAllowedTarget(path.join(LOGS_DIR, 'Claude')));
});

test('parses brew cleanup output and the process list', () => {
  assert.strictEqual(parseFreed('==> This operation would free approximately 103.3MB of disk space.'), 103300000);
  assert.strictEqual(parseFreed('nothing to do'), 0);
  const r = parseRunning('/Applications/Arc.app/Contents/MacOS/Arc\n/usr/sbin/cfprefsd\n');
  assert.ok(r.has('/Applications/Arc.app') && r.size === 1);
});
