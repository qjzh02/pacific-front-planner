import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solveAction } from './solver.js';

test('synthetic 48-enemy action repairs groups and carries health, inventory and group conditions', () => {
  const fixture = JSON.parse(readFileSync(new URL('./test-fixtures/action-resource-regression.json', import.meta.url)));
  assert.equal(fixture.kind, 'synthetic');
  const input = fixture.input;
  const original = structuredClone(input);
  const items = JSON.parse(readFileSync(new URL('./data/items.json', import.meta.url)));
  const result = solveAction(input, fixture.catalog, items, { exactLimit: 0, beamWidth: 900 });
  assert.equal(result.wins, 48);
  assert.equal(result.targetCount, 48);
  assert.ok(result.groupRepairs.length > 0);
  assert.ok(result.groupRepairRetries <= 4);
  const health = new Map(input.cards.map(card => [card.cardId, card.health]));
  const inventory = { ...input.inventory };
  for (const wave of result.waves) {
    const deployed = new Set();
    assert.deepEqual(wave.groups.map(group => group.group), [1, 2, 3, 4]);
    for (const group of wave.groups) {
      assert.equal(group.wins, 4);
      assert.deepEqual(group.conditions.allowedTypes, input.waves[wave.wave - 1].groupConditions[group.group - 1].allowedTypes ?? null);
      for (const position of group.positions) {
        assert.ok(position.win && position.ownPower > position.enemyPower);
        assert.ok(!deployed.has(position.cardId));
        deployed.add(position.cardId);
        assert.equal(position.originalHealth, health.get(position.cardId));
        const item = items.items.find(item => item.id === position.specialId);
        const restored = Math.min(3, health.get(position.cardId) + (item?.parameters.health_delta ?? 0));
        assert.equal(position.health, restored);
        assert.equal(position.healthAfter, restored - 1);
        health.set(position.cardId, restored - 1);
      }
      for (const [id, quantity] of Object.entries(group.usedItems)) {
        inventory[id] -= quantity;
        assert.ok(inventory[id] >= 0);
      }
    }
    assert.deepEqual(Object.fromEntries(health), Object.fromEntries(wave.remainingCards.map(card => [card.cardId, card.health])));
    assert.deepEqual(wave.remainingInventory, inventory);
  }
  assert.equal(result.usedItems.standard_firepower, 4);
  assert.equal(result.remainingInventory.standard_firepower, 0);
  assert.deepEqual(input, original);
});
