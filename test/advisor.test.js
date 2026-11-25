const test = require('node:test');
const assert = require('node:assert');
const { advise, isChatApp } = require('../src/advisor');
const { matchApp, addApp } = require('../src/apps');
const { looksLikeMedia } = require('../src/contents');

const MB = 1e6;
const item = (o) => ({ folder: 'x', bytes: 10 * MB, system: false, appName: null, appRunning: false, ...o });
const judged = (ratio, total = 500 * MB) => ({ judged: true, mediaRatio: ratio, mediaBytes: ratio * total, totalBytes: total });

test('tags say what a folder is', () => {
  const t = (o) => advise(item(o)).tags[0];
  assert.strictEqual(t({ folder: 'pip' }), 'download');
  assert.strictEqual(t({ folder: 'node-gyp' }), 'build');
  assert.strictEqual(t({ folder: 'com.foo.bar.ShipIt', appName: 'Bar' }), 'installer');
  assert.strictEqual(t({ folder: 'chrome_crashpad_handler' }), 'crash');
  assert.strictEqual(t({ folder: 'logs' }), 'log');
  assert.strictEqual(t({ folder: 'Google', appName: 'Google Chrome', contents: { ...judged(0.15), chromium: true } }), 'web');
  assert.strictEqual(t({ folder: 'com.tencent.QQMusicMac', appName: 'QQMusic', contents: { ...judged(0.65), urlCache: true } }), 'image');
  assert.strictEqual(t({ folder: 'com.x.app', appName: 'X', contents: { ...judged(0.01), urlCache: true } }), 'network');
  assert.strictEqual(t({ folder: 'com.x.app', appName: 'X' }), 'appcache');
  assert.strictEqual(t({ folder: 'com.apple.helpd', system: true }), 'system');
});

test('an app cache that is really an updater download is an installer', () => {
  const a = advise(item({ folder: 'com.openai.codex', appName: 'ChatGPT', bytes: 2400 * MB,
    contents: { ...judged(0.01), installerBytes: 2300 * MB, installerRatio: 0.96, urlCache: true } }));
  assert.deepStrictEqual([a.type, a.level], ['installer', 'recommend']);
  assert.match(a.reason, /安装包/);
});

test('installers, download, build caches, crash reports and logs are recommended', () => {
  for (const folder of ['pip', 'node-gyp', 'com.foo.bar.ShipIt', 'SentryCrash', 'logs']) {
    assert.strictEqual(advise(item({ folder, appName: folder.endsWith('ShipIt') ? 'Bar' : null })).level, 'recommend', folder);
  }
});

test('size never changes the group', () => {
  const big = advise(item({ folder: 'Steam', appName: 'Steam', bytes: 4000 * MB }));
  const small = advise(item({ folder: 'Steam', appName: 'Steam', bytes: 1 * MB }));
  assert.strictEqual(big.level, small.level);
});

test('running is a status tag, not a group', () => {
  const a = advise(item({ folder: 'Arc', appName: 'Arc', appRunning: true }));
  assert.deepStrictEqual([a.level, a.tags], ['ok', ['appcache', 'running']]);
  assert.match(a.reason, /先退出/);
});

test('chat apps: B when contents were judged, A as fallback', () => {
  const lark = { folder: 'LarkShell', appName: 'Lark', appBundleId: 'com.electron.lark' };
  assert.deepStrictEqual(advise(item({ ...lark, contents: judged(0.6) })).tags, ['chat', 'media']);
  assert.deepStrictEqual(advise(item({ ...lark, contents: judged(0.03) })).tags, ['chat']);
  assert.match(advise(item({ ...lark, contents: judged(0.03) })).reason, /3%/);
  assert.deepStrictEqual(advise(item({ ...lark, contents: { judged: false } })).tags, ['chat', 'maybechat']);
  assert.deepStrictEqual(advise(item(lark)).tags, ['chat', 'maybechat']);
});

test('QQ is a chat app but QQ Music is not', () => {
  assert.ok(isChatApp({ appBundleId: 'com.tencent.qq', appName: 'QQ' }));
  assert.ok(!isChatApp({ appBundleId: 'com.tencent.QQMusicMac', appName: 'QQMusic' }));
});

test('macOS caches are never recommended, including plain-named ones', () => {
  assert.strictEqual(advise(item({ folder: 'com.apple.helpd', system: true })).level, 'keep');
  assert.strictEqual(advise(item({ folder: 'GeoServices', bytes: 70 * MB })).level, 'keep');
});

test('unidentified folders keep their type, add a warning and the last change date', () => {
  const a = advise(item({ folder: 'com.onevcat.Kingfisher.ImageCache.default', mtimeMs: Date.UTC(2025, 0, 10) }));
  assert.deepStrictEqual([a.level, a.tags], ['ok', ['image', 'orphan']]);
  assert.match(a.reason, /2025 年 1 月/);
  assert.strictEqual(advise(item({ folder: 'crashpad_handler' })).level, 'recommend');
});

test('partial access adds a status tag', () => {
  assert.deepStrictEqual(advise(item({ folder: 'com.x.gone', partial: true })).tags, ['appcache', 'orphan', 'partial']);
});

test('media sniffing finds signatures after a cache header', () => {
  const header = Buffer.from('\x30\x5c\x72\xa7\x1b\x6d\xfb\xfc https://example.com/a.jpg ', 'latin1');
  assert.ok(looksLikeMedia(Buffer.concat([header, Buffer.from([0xff, 0xd8, 0xff, 0xe0])])));
  assert.ok(!looksLikeMedia(Buffer.from('function main() { return 1; }')));
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
  addApp(index, { name: 'Home', bundleId: 'com.apple.Home', path: '/System/Applications/Home.app' });
  assert.strictEqual(matchApp('Homebrew', index), null); // "brew" isn't a new word
});
