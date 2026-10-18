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

test('接口接受四种增益减益条件和组合，拒绝非布尔开关', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-buff' } });
    await call('request', { body: { requestId: 'request-buff' } });
    const flags = ['buffsDisabled', 'debuffsDisabled', 'buffsReduced', 'debuffsReduced'];
    for (const flag of flags) for (const value of ['true', 1, null]) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-buff', requestId: 'request-buff',
        snapshot: { ...snapshot, condition: { ...snapshot.condition, [flag]: value } } } })).status, 400);
      assert.equal((await (await call('status')).json()).result, null);
    }
    for (const active of [...flags.map(flag => [flag]), ['buffsReduced', 'debuffsReduced'], ['buffsDisabled', 'debuffsDisabled']]) {
      await call('request', { body: { requestId: 'request-buff' } });
      const accepted = { ...snapshot, condition: { ...snapshot.condition, ...Object.fromEntries(flags.map(flag => [flag, active.includes(flag)])) } };
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-buff', requestId: 'request-buff', snapshot: accepted } })).status, 200);
      assert.deepEqual((await (await call('status')).json()).result.snapshot, accepted);
    }
  });
});

test('快照入口拒绝未知提升比例、缺失舰种逐敌军比例和无法还原值，不覆盖待处理结果', async () => {
  const api = globalThis.PacificFrontCapture;
  const invalid = [
    { ...snapshot, source: { ...snapshot.source, enemyPowerIncrease: 0.5 } },
    { ...snapshot, source: { action: '测试', stage: 1, keypoint: 1, enemyPowerIncreases: [{ type: 'cruiser', rate: 0.12 }] } },
    { ...snapshot, source: { action: '测试', stage: 1, keypoint: 1, enemyPowerIncreases: [{ type: 'cruiser', rate: 0.16 }] } },
    { ...snapshot, enemies: snapshot.enemies.map(enemy => ({ ...enemy, power: 7 })) },
  ];
  for (const sample of invalid) assert.throws(() => api.validateSnapshot(sample));
  const input = { waves: [{ enemies: snapshot.enemies, groupConditions: [{}] }], cards: [], inventory: {} };
  const original = structuredClone(input);
  for (const sample of invalid) assert.throws(() => api.mergeSnapshot(input, 0, 0, sample));
  assert.deepEqual(input, original);
  assert.doesNotThrow(() => api.validateSnapshot(snapshot)); // legacy global source supplies each missing rate
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'strict-source' } });
    await call('request', { body: { requestId: 'strict-request' } });
    for (const sample of invalid) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'strict-source', requestId: 'strict-request', snapshot: sample } })).status, 400);
      assert.equal((await (await call('status')).json()).result, null);
    }
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

test('接口校验舰种提升来源，保留有效记录并拒绝无效及未核对叠加', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-boost' } });
    await call('request', { body: { requestId: 'request-boost' } });
    const boost = { type: 'cruiser', rate: 0.16 };
    for (const enemyPowerIncreases of [[], [null], [{ ...boost, type: 'unknown' }], [boost, boost],
      [{ ...boost, rate: -0.16 }], [{ ...boost, rate: '0.16' }]]) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-boost',
        snapshot: { ...snapshot, source: { ...snapshot.source, enemyPowerIncreases } } } })).status, 400);
    }
    const source = { action: '测试行动', stage: 1, keypoint: 1, enemyPowerIncreases: [boost] };
    for (const powerIncrease of ['0.16', -0.16, 0.12]) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-boost',
        snapshot: { ...snapshot, source, enemies: snapshot.enemies.map(enemy => ({ ...enemy, powerIncrease })) } } })).status, 400);
    }
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-boost',
      snapshot: { ...snapshot, source: { ...source, enemyPowerIncrease: 0.08, ignoredEnemyPowerIncrease: 0.08 } } } })).status, 400);
    const typed = { ...snapshot, source, enemies: snapshot.enemies.map(enemy => ({ ...enemy, powerIncrease: 0 })) };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-boost', snapshot: typed } })).status, 200);
    assert.deepEqual((await (await call('status')).json()).result.snapshot, typed);
    await call('request', { body: { requestId: 'request-restored-types' } });
    for (const source of [
      { ...typed.source, ignoredEnemyPowerIncreases: [boost] },
      { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncreases: [{ ...boost, rate: 0.12 }] },
      { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncreases: [boost, boost] },
      { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncreases: [boost], ignoredEnemyPowerIncrease: 0.08, enemyPowerIncrease: 0.16 },
    ]) {
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-restored-types',
        snapshot: { ...snapshot, source } } })).status, 400);
    }
    const restored = { ...snapshot, source: { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncreases: [boost] } };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-boost', requestId: 'request-restored-types', snapshot: restored } })).status, 200);
    assert.deepEqual((await (await call('status')).json()).result.snapshot, restored);
  });
});

test('接口接受两层带入及带入8%与潜艇区域16%，拒绝三层重叠', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-stacked' } });
    const carriedSource = { action: '测试行动', stage: 1, keypoint: 1, ignoredEnemyPowerIncrease: 0.08,
      ignoredEnemyPowerIncreases: [{ type: 'destroyer', rate: 0.16 }] };
    for (const [requestId, source, powers, rates] of [
      ['carried', carriedSource, [131, 154, 146, 137], []],
      ['mixed', { ...carriedSource, enemyPowerIncreases: [{ type: 'submarine', rate: 0.16 }] }, [145, 164, 161, 153], [0, 0, 0.16, 0]],
    ]) {
      await call('request', { body: { requestId } });
      const accepted = { ...snapshot, source, enemies: powers.map((power, i) => ({ ...snapshot.enemies[i], power,
        ...(rates.length ? { powerIncrease: rates[i] } : {}) })) };
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-stacked', requestId, snapshot: accepted } })).status, 200);
      assert.deepEqual((await (await call('status')).json()).result.snapshot, accepted);
    }
    await call('request', { body: { requestId: 'invalid-stack' } });
    const overlapping = { ...carriedSource, enemyPowerIncreases: [{ type: 'destroyer', rate: 0.16 }] };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-stacked', requestId: 'invalid-stack',
      snapshot: { ...snapshot, source: overlapping } } })).status, 400);
    assert.equal((await (await call('status')).json()).result, null);
  });
});

test('接口保留不同舰种的独立带入或区域提升，并拒绝同舰种重复', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'multi-types' } });
    const boosts = [{ type: 'destroyer', rate: 0.16 }, { type: 'battleship', rate: 0.16 }];
    for (const [key, powers, rates] of [
      ['ignoredEnemyPowerIncreases', [190, 191, 188, 186], null],
      ['enemyPowerIncreases', [190, 222, 218, 186], [0, 0.16, 0.16, 0]],
    ]) {
      await call('request', { body: { requestId: key } });
      const accepted = { ...snapshot, source: { action: '测试', stage: 1, keypoint: 11, [key]: boosts },
        enemies: powers.map((power, i) => ({ active: true, power, weaknesses: [], ...(rates ? { powerIncrease: rates[i] } : {}) })) };
      const duplicated = { ...accepted, source: { ...accepted.source, [key]: [...boosts, boosts[0]] } };
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'multi-types', requestId: key, snapshot: duplicated } })).status, 400);
      assert.equal((await (await call('status')).json()).result, null);
      assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'multi-types', requestId: key, snapshot: accepted } })).status, 200);
      assert.deepEqual((await (await call('status')).json()).result.snapshot, accepted);
    }
  });
});

test('接口接受岸防炮提升来源并保持每个敌军的区域比例', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-coastal' } });
    await call('request', { body: { requestId: 'request-coastal' } });
    const accepted = { ...snapshot, source: { action: '测试行动', stage: 1, keypoint: 1,
      enemyPowerIncreases: [{ type: 'coastal_artillery', rate: 0.16 }] },
    enemies: [177, 187, 204, 201].map((power, i) => ({ ...snapshot.enemies[i], power, powerIncrease: i < 3 ? 0.16 : 0 })) };
    assert.equal((await call('game', { game: true, body: { type: 'result', clientId: 'client-coastal', requestId: 'request-coastal', snapshot: accepted } })).status, 200);
    assert.deepEqual((await (await call('status')).json()).result.snapshot, accepted);
  });
});

test('接口接受有效区域舰种限制，拒绝空值、重复或未知类型', async () => {
  await withRelay(async call => {
    await call('game', { game: true, body: { type: 'connect', clientId: 'client-types' } });
    await call('request', { body: { requestId: 'request-types' } });
    for (const allowedTypes of [[], ['unknown'], ['submarine'], ['coastal_artillery'], ['cruiser', 'cruiser'], 'battleship']) {
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
