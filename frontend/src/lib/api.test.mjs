// Run with: node --test src/lib/api.test.mjs
// Checks how the API layer tells "no server" from "the server said no", and
// the browser-side store for presets and profiles.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { protocol: 'http:', host: 'localhost' };

const answer = (status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => type },
  text: async () => body,
});

let copy = 0;
// A fresh copy of the module each time: it keeps the server state in module scope.
async function load(respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(`${options?.method || 'GET'} ${url}`);
    return respond(url, options);
  };
  const api = await import(`./api.js?copy=${++copy}`);
  return { api, calls };
}

test('the app page instead of JSON means there is no server, and reads stop', async () => {
  const { api, calls } = await load(() => answer(200, '<!DOCTYPE html><html></html>', 'text/html'));
  const err = await api.fetchConfig().catch((e) => e);
  assert.equal(err.offline, true);
  assert.equal(api.getServerState(), 'none');
  await assert.rejects(api.getActiveModel());
  await assert.rejects(api.fetchPresets());
  assert.deepEqual(calls, ['GET /api/config']);
});

test('a 404 that is not from the server means the same', async () => {
  const { api } = await load(() => answer(404, 'The page could not be found', 'text/plain'));
  await assert.rejects(api.fetchModels());
  assert.equal(api.getServerState(), 'none');
});

test('requests made together wait for the first answer instead of all going out', async () => {
  const { api, calls } = await load(() => answer(404, 'NOT_FOUND', 'text/plain'));
  await Promise.allSettled([api.fetchConfig(), api.getActiveModel(), api.fetchPresets()]);
  assert.equal(calls.length, 1);
});

test('an empty 500 or a gateway error means the server may still be starting', async () => {
  const { api, calls } = await load(() => answer(500, '', 'text/plain'));
  const err = await api.fetchConfig().catch((e) => e);
  assert.equal(err.offline, true);
  assert.equal(api.getServerState(), 'unreachable');
  await assert.rejects(api.fetchModels()); // inside the wait: no request
  assert.equal(calls.length, 1);
  assert.equal(await api.checkServer(), 'unreachable'); // asked for: goes out
  assert.equal(calls.length, 2);
});

test('a failed connection means unreachable', async () => {
  const { api } = await load(() => {
    throw new TypeError('Failed to fetch');
  });
  const err = await api.fetchConfig().catch((e) => e);
  assert.match(err.message, /Can't reach the BadloVoice server/);
  assert.equal(api.getServerState(), 'unreachable');
});

test('the server saying no keeps it online and passes its reason on', async () => {
  const { api } = await load((url) =>
    url.endsWith('/config')
      ? answer(200, '{"sample_rate":40000}')
      : answer(404, '{"detail":"Model not found: x.pth"}')
  );
  assert.deepEqual(await api.fetchConfig(), { sample_rate: 40000 });
  const err = await api.activateModel('x.pth').catch((e) => e);
  assert.equal(err.message, 'Model not found: x.pth');
  assert.equal(err.offline, false);
  assert.equal(api.getServerState(), 'online');
});

test('a list of validation problems becomes one sentence', async () => {
  const { api } = await load(() =>
    answer(422, '{"detail":[{"msg":"String should have at least 1 character"},{"msg":"Field required"}]}')
  );
  const err = await api.savePreset('', {}).catch((e) => e);
  assert.equal(err.message, 'String should have at least 1 character. Field required');
});

test('a plain-text crash is a server problem, not a missing server', async () => {
  const { api } = await load(() => answer(500, 'Internal Server Error', 'text/plain'));
  const err = await api.fetchModels().catch((e) => e);
  assert.equal(err.offline, false);
  assert.doesNotMatch(err.message, /500/);
  assert.equal(api.getServerState(), 'online');
});

test('JSON errors from something that is not the server do not count as online', async () => {
  const { api } = await load(() => answer(404, '{"error":"no such route"}'));
  await assert.rejects(api.fetchModels());
  assert.equal(api.getServerState(), 'none');
});

test('listeners hear about a change of state', async () => {
  const { api } = await load(() => answer(200, '{}'));
  const seen = [];
  const stop = api.subscribeServerState(() => seen.push(api.getServerState()));
  await api.checkServer();
  stop();
  assert.deepEqual(seen, ['online']);
});

test('saved presets: any language as a name, same name replaces, limit, delete', async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const { localProfiles, BUILTIN_PRESETS } = await import('./savedSettings.js');
  const { EFFECT_DEFS } = await import('./effects.js');

  localProfiles.save('低音', { pitch_shift: -4 });
  localProfiles.save('روبوت', { pitch_shift: 1 });
  localProfiles.save('🔥', { pitch_shift: 2 });
  localProfiles.save(' 低音 ', { pitch_shift: -6 });
  assert.deepEqual(
    localProfiles.list().map((item) => [item.name, item.settings.pitch_shift]),
    [['低音', -6], ['روبوت', 1], ['🔥', 2]]
  );
  localProfiles.remove(localProfiles.list()[1].id);
  assert.equal(localProfiles.list().length, 2);
  assert.throws(() => localProfiles.save('   ', {}), /name/);
  for (let i = 0; i < 38; i += 1) localProfiles.save(`p${i}`, {});
  assert.throws(() => localProfiles.save('one too many', {}), /already have 40/);
  localProfiles.save('p0', { again: true }); // replacing still works at the limit

  data.set('badlovoice_profiles_v1', '{not json');
  assert.deepEqual(localProfiles.list(), []);

  // Built-in presets only use effects and parameters the engine knows.
  for (const preset of BUILTIN_PRESETS) {
    for (const [key, values] of Object.entries(preset.settings.effects)) {
      const def = EFFECT_DEFS.find((d) => d.key === key);
      assert.ok(def, `${preset.id}: unknown effect ${key}`);
      for (const param of Object.keys(values)) {
        assert.ok(param === 'enabled' || def.params.some((p) => p.key === param), `${preset.id}: ${key}.${param}`);
      }
    }
  }
});
