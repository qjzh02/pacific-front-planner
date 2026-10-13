import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import './game-capture.js';
import { createCaptureRelay } from './capture-relay.mjs';

async function withRelay(run) {
  const relay = createCaptureRelay(globalThis.PacificFrontCapture.validateSnapshot);
  const server = http.createServer(async (request, response) => { await relay(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/capture/config`)).json();
  const call = (path, { game = false, body, token: key = token, origin, ...options } = {}) => fetch(`${base}/capture/${path}`, {
    ...options, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { Origin: origin ?? (game ? 'https://pacificfront.worldofwarships.asia' : base), 'X-Capture-Token': key,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  try { await run(call, base); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const snapshot = { version: 1, source: { action: '测试行动', stage: 1, keypoint: 1, enemyPowerIncrease: 0.08 },
  enemies: Array.from({ length: 4 }, () => ({ active: true, power: 100, weaknesses: ['debuff_plane'] })),
  condition: { global: { firepower: 0.24, survivability: 0, mobility: 0 }, buffsDisabled: false, debuffsDisabled: false,
    buffsReduced: false, debuffsReduced: false, allowedTypes: null } };

test('接口限制来源、配对码、预检和私有文件白名单', async () => {
  await withRelay(async call => {
    assert.equal((await call('status', { token: 'bad' })).status, 403);
    assert.equal((await call('config', { game: true })).status, 403);
    assert.equal((await call('game?client=a', { origin: 'https://example.invalid' })).status, 403);
    const preflight = await call('game', { game: true, method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-capture-token' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://pacificfront.worldofwarships.asia');
    assert.equal((await call('AGENTS.md')).status, 404);
  });
});

test('请求、读取、结果只按当前请求编号返回，不复用旧结果', async () => {
  await withRelay(async call => {
    assert.equal((await call('game', { game: true, body: { type: 'connect', clientId: 'client-a' } })).status, 200);
    await call('request', { body: { requestId: 'request-a' } });
    assert.equal((await (await call('game?client=client-a', { game: true })).json()).requestId, 'request-a');
    await call('request', { body: { requestId: 'request-b' } });
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-a', snapshot } })).status, 409);
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-b', snapshot } })).status, 200);
    const state = await (await call('status')).json();
    assert.equal(state.result.requestId, 'request-b');
    assert.deepEqual(state.result.snapshot, snapshot);
    assert.equal((await (await call('game?client=client-a', { game: true })).json()).requestId, null);
    await call('request', { body: { requestId: 'request-c' } });
    assert.equal((await (await call('status')).json()).result, null);
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-c',
      snapshot: { ...snapshot, source: { ...snapshot.source, enemyPowerIncrease: -0.1 } } } })).status, 400);
    for (const source of [
      { ...snapshot.source, ignoredEnemyPowerIncrease: 0.08 },
      { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncrease: 0.1 },
    ]) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-c',
        snapshot: { ...snapshot, source } } })).status, 400);
    }
    const restored = { ...snapshot, source: { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncrease: 0.08 } };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-c', snapshot: restored } })).status, 200);
    assert.deepEqual((await (await call('status')).json()).result.snapshot, restored);
  });
});

test('拒绝无效结果及超大请求，游戏页接管后拒绝旧连接', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-a' } });
    await call('request', { body: { requestId: 'request-a' } });
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-a', requestId: 'request-a', snapshot: { ...snapshot, enemies: [] } } })).status, 400);
    assert.equal((await (await call('status')).json()).result, null);
    assert.equal((await call('game', { game: true, body: { extra: 'x'.repeat(17000) } })).status, 413);
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-b' } });
    assert.equal((await call('game?client=client-a', { game: true })).status, 409);
    await call('game', { game: true, body: { type: 'disconnect', clientId: 'client-b' } });
    assert.equal((await (await call('status')).json()).connected, false);
  });
});

test('接口接受有效区域舰种限制，拒绝空值、重复或未知类型', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-types' } });
    await call('request', { body: { requestId: 'request-types' } });
    for (const allowedTypes of [[], ['unknown'], ['cruiser', 'cruiser'], 'battleship']) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-types', requestId: 'request-types',
        snapshot: { ...snapshot, condition: { ...snapshot.condition, allowedTypes } } } })).status, 400);
    }
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-types', requestId: 'request-types',
      snapshot: { ...snapshot, condition: { ...snapshot.condition, itemsDisabled: 'true' } } } })).status, 400);
    const restricted = { ...snapshot, condition: { ...snapshot.condition, allowedTypes: ['aircraft', 'cruiser', 'destroyer'], itemsDisabled: true } };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-types', requestId: 'request-types', snapshot: restricted } })).status, 200);
    assert.deepEqual((await (await call('status')).json()).result.snapshot, restricted);
  });
});
