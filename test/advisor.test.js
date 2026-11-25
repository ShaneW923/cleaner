const test = require('node:test');
const assert = require('node:assert');
const { advise } = require('../src/advisor');
const { matchApp, addApp } = require('../src/apps');

const MB = 1e6;
const item = (o) => ({ folder: 'x', bytes: 10 * MB, system: false, appName: null, appRunning: false, ...o });

test('dev tool caches are recommended', () => {
  const a = advise(item({ folder: 'pip', bytes: 400 * MB }));
  assert.deepStrictEqual([a.kind, a.level, a.displayName], ['tool', 'recommend', 'Python pip']);
});

test('macOS caches are never recommended, including plain-named ones', () => {
  assert.strictEqual(advise(item({ folder: 'com.apple.helpd', system: true })).level, 'keep');
  assert.strictEqual(advise(item({ folder: 'GeoServices', bytes: 70 * MB })).level, 'keep');
});

test('running apps are not recommended', () => {
  const a = advise(item({ folder: 'Arc', appName: 'Arc', bytes: 2000 * MB, appRunning: true }));
  assert.strictEqual(a.level, 'ok');
  assert.match(a.reason, /正在运行/);
});

test('large caches of closed apps and updater leftovers are recommended', () => {
  assert.strictEqual(advise(item({ folder: 'Steam', appName: 'Steam', bytes: 400 * MB })).level, 'recommend');
  assert.strictEqual(advise(item({ folder: 'Steam', appName: 'Steam', bytes: 5 * MB })).level, 'ok');
  assert.strictEqual(advise(item({ folder: 'com.foo.bar.ShipIt', appName: 'Bar', bytes: 1 * MB })).level, 'recommend');
});

test('unmatched folders are flagged as possible leftovers', () => {
  const a = advise(item({ folder: 'com.west2online.ClashX', bytes: 5 * MB }));
  assert.deepStrictEqual([a.kind, a.level], ['orphan', 'recommend']);
});

test('matches Codex to ChatGPT.app and LarkShell to Lark', () => {
  const index = { byId: new Map(), byName: new Map(), byLastSeg: new Map() };
  const chatgpt = { name: 'ChatGPT', bundleId: 'com.openai.codex', path: '/Applications/ChatGPT.app' };
  const lark = { name: 'Lark', bundleId: 'com.electron.lark', path: '/Applications/Lark.app' };
  const arc = { name: 'Arc', bundleId: 'company.thebrowser.Browser', path: '/Applications/Arc.app' };
  [chatgpt, lark, arc].forEach((a) => addApp(index, a));
  assert.strictEqual(matchApp('Codex', index), chatgpt);
  assert.strictEqual(matchApp('LarkShell', index), lark);
  assert.strictEqual(matchApp('Archive', index), null); // "Arc" is too short for prefix matching
});
