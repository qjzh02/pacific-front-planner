import test from 'node:test';
import assert from 'node:assert/strict';
import './game-capture.js';

const api = globalThis.PacificFrontCapture;
const enemy = () => ({ active: true, rawPower: '', weaknesses: [] });
const input = () => ({ waves: [{ enemies: Array.from({ length: 4 }, enemy), groupConditions: [{}] }],
  cards: [{ cardId: 'missouri', health: 2 }], inventory: { standard_firepower: 6 }, computeBudget: 0, pauseBackground: true });
const snapshot = (stage, keypoint, power = keypoint * 10, action = '测试行动') => ({ version: 1,
  source: { action, stage, keypoint }, enemies: Array.from({ length: 4 }, () => ({ active: true, power, weaknesses: [] })),
  condition: { global: { firepower: 0, survivability: 0, mobility: 0 }, buffsDisabled: false, debuffsDisabled: false,
    buffsReduced: false, debuffsReduced: false, itemsDisabled: false, allowedTypes: null } });

test('按累计据点号顺序采集自动扩容，阶段切换从本阶段第一组开始', () => {
  let current = input();
  const resources = structuredClone(current);
  for (const [stage, keypoint, group] of [[1, 1, 0], [1, 2, 1], [1, 3, 2],
    [2, 4, 0], [2, 5, 1], [2, 6, 2], [2, 7, 3], [2, 8, 4], [3, 9, 0]]) {
    const previous = structuredClone(current);
    const result = api.mergeAutoSnapshot(current, snapshot(stage, keypoint));
    assert.deepEqual(current, previous);
    assert.equal(result.waveIndex, stage - 1); assert.equal(result.groupIndex, group);
    current = result.input;
    assert.equal(current.waves[stage - 1].groupConditions[group].captureSource.keypoint, keypoint);
  }
  assert.deepEqual(current.waves.map(wave => wave.enemies.length), [12, 20, 4]);
  assert.deepEqual(current.cards, resources.cards); assert.deepEqual(current.inventory, resources.inventory);
  const updated = api.mergeAutoSnapshot(current, snapshot(2, 6, 999));
  assert.deepEqual(updated.input.waves.map(wave => wave.enemies.length), [12, 20, 4]);
  assert.equal(updated.groupIndex, 2);
  assert.deepEqual(updated.input.waves[1].enemies.slice(8, 12).map(enemy => enemy.power), [999, 999, 999, 999]);
  assert.deepEqual(updated.input.waves[2], current.waves[2]);
});

test('已知阶段边界可补抓缺失据点，不靠所有阶段固定组数推算', () => {
  let current = api.mergeAutoSnapshot(input(), snapshot(1, 1)).input;
  current = api.mergeAutoSnapshot(current, snapshot(1, 3)).input;
  assert.equal(current.waves[0].enemies.length, 12);
  assert.equal(current.waves[0].enemies[4].rawPower, '');
  const missing = api.mergeAutoSnapshot(current, snapshot(1, 2));
  assert.equal(missing.groupIndex, 1);
  current = api.mergeAutoSnapshot(missing.input, snapshot(2, 4)).input;
  assert.deepEqual(current.waves.map(wave => wave.enemies.length), [12, 4]);
});

test('边界缺失、混用行动、错位来源、重复据点和超过每阶段5组不修改原输入', () => {
  const initial = input();
  for (const source of [snapshot(2, 4), snapshot(1, 6), snapshot(7, 1), snapshot(1, 31)]) {
    assert.throws(() => api.mergeAutoSnapshot(initial, source));
    assert.deepEqual(initial, input());
  }
  let current = api.mergeAutoSnapshot(initial, snapshot(1, 1)).input;
  assert.throws(() => api.mergeAutoSnapshot(current, snapshot(1, 2, 20, '另一行动')), /行动/);
  assert.throws(() => api.mergeAutoSnapshot(current, snapshot(2, 1)), /据点|阶段/);
  current.waves[0].groupConditions[0].captureSource.stage = 2;
  const before = structuredClone(current);
  assert.throws(() => api.mergeAutoSnapshot(current, snapshot(2, 2)), /来源|位置|阶段/);
  assert.deepEqual(current, before);
});
