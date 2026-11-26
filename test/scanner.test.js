const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { assertSafeCacheTarget } = require('../src/scanner');
const { HOME, CACHES_DIR, DOT_CACHE_DIR, isAllowedTarget } = require('../src/locations');
const { matchApp } = require('../src/apps');

test('refuses paths outside the allowed cache locations', async () => {
  for (const p of [
    CACHES_DIR,
    DOT_CACHE_DIR,
    path.join(CACHES_DIR, 'a', 'b'),
    path.join(DOT_CACHE_DIR, 'uv', 'wheels'),
    path.join(CACHES_DIR, '..', 'Preferences'),
    '/System',
    path.join(CACHES_DIR, 'x', '..', '..', 'Mail'),
    path.join(HOME, '.npm'),                 // parent of an allowed target
    path.join(HOME, '.nvm'),                 // ditto — holds installed Node
    path.join(HOME, '.npm', '_cacache', 'index-v5'),
  ]) {
    await assert.rejects(assertSafeCacheTarget(p), /拒绝/, p);
  }
});

test('allows children of the cache roots and exact extra targets', () => {
  assert.ok(isAllowedTarget(path.join(CACHES_DIR, 'com.foo.bar')));
  assert.ok(isAllowedTarget(path.join(DOT_CACHE_DIR, 'uv')));
  assert.ok(isAllowedTarget(path.join(HOME, '.npm', '_cacache')));
  assert.ok(isAllowedTarget(path.join(HOME, '.nvm', '.cache')));
});

test('matches cache folders to apps by bundle id and name', () => {
  const chrome = { name: 'Google Chrome', bundleId: 'com.google.Chrome' };
  const arc = { name: 'Arc', bundleId: 'company.thebrowser.Browser' };
  const index = {
    byId: new Map([['com.google.chrome', chrome], ['company.thebrowser.browser', arc]]),
    byName: new Map([['arc', arc]]),
  };
  assert.strictEqual(matchApp('com.google.Chrome', index), chrome);
  assert.strictEqual(matchApp('com.google.Chrome.ShipIt', index), chrome);
  assert.strictEqual(matchApp('Arc', index), arc);
  assert.strictEqual(matchApp('com.google.Other', index), null); // no "com.google" prefix match
  assert.strictEqual(matchApp('Unknown', index), null);
});
