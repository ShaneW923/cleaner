const test = require('node:test');
const assert = require('node:assert');
const { advise, isChatApp } = require('../src/advisor');
const { matchApp, addApp } = require('../src/apps');
const { looksLikeMedia } = require('../src/contents');

const MB = 1e6;
const item = (o) => ({ folder: 'x', bytes: 10 * MB, system: false, appName: null, appRunning: false, ...o });
const judged = (ratio, total = 500 * MB) => ({ judged: true, mediaRatio: ratio, mediaBytes: ratio * total, totalBytes: total });

test('recommend = deleting has no cost: dev tools and updater leftovers', () => {
  const pip = advise(item({ folder: 'pip', bytes: 400 * MB }));
  assert.deepStrictEqual([pip.level, pip.tags], ['recommend', ['redownload']]);
  const shipit = advise(item({ folder: 'com.foo.bar.ShipIt', appName: 'Bar' }));
  assert.deepStrictEqual([shipit.level, shipit.tags], ['recommend', ['noimpact']]);
});

test('size never changes the group', () => {
  const big = advise(item({ folder: 'Steam', appName: 'Steam', bytes: 4000 * MB }));
  const small = advise(item({ folder: 'Steam', appName: 'Steam', bytes: 1 * MB }));
  assert.strictEqual(big.level, small.level);
  assert.deepStrictEqual(big.tags, ['slower']);
});

test('running is a status tag, not a group', () => {
  const a = advise(item({ folder: 'Arc', appName: 'Arc', appRunning: true }));
  assert.deepStrictEqual([a.level, a.tags], ['ok', ['slower', 'running']]);
  assert.match(a.reason, /先退出/);
});

test('chat apps: B when contents were judged, A as fallback', () => {
  const lark = { folder: 'LarkShell', appName: 'Lark', appBundleId: 'com.electron.lark' };
  assert.deepStrictEqual(advise(item({ ...lark, contents: judged(0.6) })).tags, ['media']);
  assert.deepStrictEqual(advise(item({ ...lark, contents: judged(0.03) })).tags, ['slower']);
  assert.deepStrictEqual(advise(item({ ...lark, contents: { judged: false } })).tags, ['maybechat']);
  assert.deepStrictEqual(advise(item(lark)).tags, ['maybechat']);
});

test('media in non-chat caches only shows up in the explanation', () => {
  const a = advise(item({ folder: 'Steam', appName: 'Steam', contents: judged(0.54) }));
  assert.deepStrictEqual(a.tags, ['slower']);
  assert.match(a.reason, /图片或视频/);
});

test('QQ is a chat app but QQ Music is not', () => {
  assert.ok(isChatApp({ appBundleId: 'com.tencent.qq', appName: 'QQ' }));
  assert.ok(!isChatApp({ appBundleId: 'com.tencent.QQMusicMac', appName: 'QQMusic' }));
});

test('macOS caches are never recommended, including plain-named ones', () => {
  assert.strictEqual(advise(item({ folder: 'com.apple.helpd', system: true })).level, 'keep');
  assert.strictEqual(advise(item({ folder: 'GeoServices', bytes: 70 * MB })).level, 'keep');
});

test('unidentified folders say when they were last touched', () => {
  const a = advise(item({ folder: 'com.west2online.ClashX', mtimeMs: Date.UTC(2025, 2, 10) }));
  assert.deepStrictEqual([a.level, a.tags], ['ok', ['unknown']]);
  assert.match(a.reason, /2025 年 3 月/);
});

test('partial access adds a status tag', () => {
  assert.deepStrictEqual(advise(item({ folder: 'com.x.gone', partial: true })).tags, ['unknown', 'partial']);
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
