import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAdminPluginRoutes } from '../src/admin-plugin-routes.mjs';
import { createServerPluginService } from '../src/server-plugins.mjs';
import { init, info } from '../index.mjs';

function router() {
  const routes = [];
  const add = method => (path, ...handlers) => routes.push({ method, path, handlers });
  return { routes, get: add('get'), post: add('post'), put: add('put'), delete: add('delete') };
}
function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}
async function invoke(route, request) {
  assert.ok(route, 'the production route is registered');
  const result = response();
  async function dispatch(index) {
    const handler = route.handlers[index];
    if (!handler) return;
    let next;
    await handler(request, result, error => {
      if (error) throw error;
      next = dispatch(index + 1);
      return next;
    });
    if (next) await next;
  }
  await dispatch(0);
  return result;
}
const routeOf = (r, path) => r.routes.find(route => route.method === 'post' && route.path === path);
const admin = body => ({ user: { profile: { admin: true } }, body });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'bainiao-admin-plugins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('missing identity and ordinary users receive 403 before either admin service operation', async () => {
  let calls = 0;
  const r = router();
  registerAdminPluginRoutes(r, { service: {
    async list() { calls++; throw new Error('Unauthorized list reached the service'); },
    async update() { calls++; throw new Error('Unauthorized update reached the service'); },
  } });
  for (const request of [{}, { user: {} }, { user: { profile: { admin: false } } }, {user:{profile:{admin:'true'}}}]) {
    for (const path of ['/v1/admin/plugins/list', '/v1/admin/plugins/update']) {
      const result = await invoke(routeOf(r, path), { ...request, body: { directory: 'alpha' } });
      assert.equal(result.statusCode, 403);
      assert.ok(result.body?.message, 'the denied action has an actionable response');
    }
  }
  assert.equal(calls, 0);
});

test('admin list and selected update retain the public JSON envelopes and restart result', async () => {
  const r = router();
  const listed = [{ directory: 'alpha', packageName: 'example-alpha', version: '1.0.0', canUpdate: true }];
  registerAdminPluginRoutes(r, { service: {
    async list() { return listed; },
    async update(directory) {
      assert.equal(directory, 'alpha');
      return { plugin: { ...listed[0], version: '2.0.0', isUpToDate: false }, restartRecommended: true };
    },
  } });
  const list = await invoke(routeOf(r, '/v1/admin/plugins/list'), admin({}));
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body, { ok: true, plugins: listed });
  const update = await invoke(routeOf(r, '/v1/admin/plugins/update'), admin({ directory: 'alpha' }));
  assert.equal(update.statusCode, 200);
  assert.equal(update.body.ok, true);
  assert.equal(update.body.plugin.directory, 'alpha');
  assert.equal(update.body.plugin.version, '2.0.0');
  assert.equal(update.body.plugin.isUpToDate, false);
  assert.equal(update.body.restartRecommended, true);
});

test('registered admin update surfaces an actual non-Git service error without disk paths', async t => {
  const root = await temporary(t);
  const pluginsPath = join(root, 'plugins');
  await mkdir(join(pluginsPath, 'plain-plugin'), { recursive: true });
  const r = router();
  registerAdminPluginRoutes(r, { service: await createServerPluginService({ pluginsPath }) });
  const result = await invoke(routeOf(r, '/v1/admin/plugins/update'), admin({ directory: 'plain-plugin' }));
  assert.equal(result.statusCode, 409);
  assert.ok(result.body?.error);
  assert.match(result.body.message, /Git|git|仓库/);
  assert.equal(JSON.stringify(result.body).includes(root), false);
});

test('ordinary-user health retains identity, storage and existing capabilities while advertising admin API', async t => {
  const root = await temporary(t);
  const r = router();
  await init(r);
  const health = r.routes.find(route => route.method === 'get' && route.path === '/v1/health');
  const result = await invoke(health, { user: { profile: { admin: false }, directories: { root } } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.plugin, { id: 'st-bainiaodata', name: 'Bainiao Data', version: info.version });
  assert.deepEqual(result.body.api, { current: 1, supported: [1] });
  assert.deepEqual(result.body.storage, { scope: 'user-root', path: 'hidden', envelopeSchemaVersion: 1 });
  for (const key of ['records', 'recordList', 'recordBatchRead', 'recordBatchWrite', 'recordIdList',
    'optimisticRevision', 'atomicReplace', 'trash', 'trashRestore', 'permanentDelete']) {
    assert.equal(result.body.capabilities[key], true, key + ' remains available');
  }
  assert.equal(result.body.capabilities.serverPluginManagement, true);
  assert.equal(JSON.stringify(result.body).includes(root), false);
});
