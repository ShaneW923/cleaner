const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { CACHES_DIR, assertSafeCacheTarget } = require('../src/scanner');
const { matchApp } = require('../src/apps');

test('refuses paths outside the first level of ~/Library/Caches', async () => {
  for (const p of [
    CACHES_DIR,
    path.join(CACHES_DIR, 'a', 'b'),
    path.join(CACHES_DIR, '..', 'Preferences'),
    '/System',
    path.join(CACHES_DIR, 'x', '..', '..', 'Mail'),
  ]) {
    await assert.rejects(assertSafeCacheTarget(p), /拒绝/, p);
  }
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
