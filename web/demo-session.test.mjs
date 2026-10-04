import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoSession} from './demo-session.mjs';

test('demo session and saved apps survive refresh and sign-out', async () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const demo = new DemoSession(storage);
  demo.signIn();
  const {app} = await demo.request('/api/apps', {method: 'POST', body: {name: 'Calendar', url: 'https://example.com'}});
  const restored = new DemoSession(storage);
  assert.equal(restored.session().authenticated, true);
  assert.deepEqual(restored.account().apps, [app]);
  await restored.request('/api/logout', {method: 'POST'});
  const signedOut = new DemoSession(storage);
  assert.equal(signedOut.active, false);
  signedOut.signIn();
  assert.deepEqual(signedOut.account().apps, [app]);
});

test('demo remains usable when storage is blocked or corrupt', async () => {
  for (const storage of [
    {getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); }},
    {getItem: () => 'invalid JSON', setItem() {}},
  ]) {
    const demo = new DemoSession(storage);
    assert.equal(demo.signIn().authenticated, true);
    await demo.request('/api/apps', {method: 'POST', body: {name: 'Notes', url: ''}});
    assert.equal(demo.account().apps.length, 1);
    await assert.rejects(demo.request('/api/apps', {method: 'POST', body: {name: 'Bad', url: 'javascript:alert(1)'}}), /HTTP or HTTPS/);
  }
});
