import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFormation, solve, solveAction } from './solver.js';
import * as solver from './solver.js';

const catalog = JSON.parse(readFileSync(new URL('./data/cards.json', import.meta.url)));
const items = JSON.parse(readFileSync(new URL('./data/items.json', import.meta.url)));
const inventory = Object.fromEntries(items.items.map(item => [item.id, 0]));
const request = (ids, stock = {}, extra = {}) => ({
  enemies: Array.from({ length: 4 }, () => ({ active: true, power: 200, weaknesses: [] })),
  cards: ids.map(cardId => ({ cardId, health: 3 })), inventory: { ...inventory, ...stock },
  global: { firepower: 0, survivability: 0, mobility: 0 },
  model: { stacking: 'additive', globalStacking: 'multiply', rounding: 'none', allowEqual: false, revive: false },
  ...extra,
});
const unit = (cardId, standardId = null, specialId = null) => ({ cardId, standardId, specialId });
const evaluate = (formation, input) => evaluateFormation(formation, input, catalog, items);

test('action branch budget preserves a valid partial plan and marks unsearched groups', () => {
  const input = request(catalog.cards.map(card => card.id));
  input.waves = [{ enemies: [...input.enemies, ...input.enemies] }];
  const original = structuredClone(input);
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solveAction(input, catalog, items, { ...options, maxBranches: 1024 });
    assert.equal(result.searchLimited, true);
    assert.ok(result.explored <= 2048);
    assert.equal(result.waves[0].groups[0].searchIncomplete, true);
    assert.equal(result.waves[0].groups[1].searchMode, 'unsearched');
    const deployed = new Set();
    for (const group of result.waves[0].groups) {
      const checked = evaluate(group.formation, input);
      assert.equal(group.wins, checked.wins);
      for (const position of group.positions) if (position.cardId) {
        assert.ok(!deployed.has(position.cardId)); deployed.add(position.cardId);
        assert.equal(position.healthAfter, position.health - 1);
      }
    }
    assert.deepEqual(input, original);
  }
  const hopeless = { ...input, waves: [{ enemies: input.waves[0].enemies.map(enemy => ({ ...enemy, power: 1000000 })) }] };
  const stopped = solveAction(hopeless, catalog, items, { exactLimit: 0, beamWidth: 300, maxBranches: 2048 });
  assert.deepEqual(stopped.remainingCards, hopeless.cards);
  assert.equal(stopped.itemCount, 0);
});

test('cooperative action matches unlimited synchronous search and can stop by execution time', async () => {
  assert.equal(typeof solver.solveActionAsync, 'function');
  const input = request(catalog.cards.slice(0, 8).map(card => card.id), { standard_firepower: 2 });
  input.waves = [{ enemies: input.enemies }];
  let yields = 0;
  const options = { exactLimit: 0, beamWidth: 60 };
  const synchronous = solveAction(input, catalog, items, options);
  const asynchronous = await solver.solveActionAsync(input, catalog, items, { ...options, timeSliceMs: 0,
    schedule: async () => { yields++; } });
  const semantic = result => { const { searchElapsedMs, ...rest } = result; return rest; };
  assert.deepEqual(semantic(asynchronous), semantic(synchronous));
  assert.ok(yields > 0);
  const limited = await solver.solveActionAsync(input, catalog, items, { ...options, maxTimeMs: 0.001 });
  assert.equal(limited.searchLimited, true);
  assert.ok(limited.searchElapsedMs >= 0.001);
  for (const maxTimeMs of [-1, NaN, '30']) assert.throws(() => solveAction(input, catalog, items, { maxTimeMs }), /预算/);
});

test('a budget ending during repair preserves an already completed better plan', () => {
  const input = request(['arrow', 'hughes']);
  const group = (power, weaknesses) => input.enemies.map((enemy, i) => ({ ...enemy, power, weaknesses, active: i === 0 }));
  input.waves = [{ enemies: [...group(80, []), ...group(110, ['debuff_concentric_target'])] }];
  let initialBranches = 0;
  solveAction(input, catalog, items, { onProgress: progress => {
    if (progress.phase === 'initial' && progress.completedGroups === 2) initialBranches = progress.explored;
  } });
  const result = solveAction(input, catalog, items, { maxBranches: initialBranches + 1 });
  assert.equal(result.searchLimited, true);
  assert.ok(result.wins >= 1);
  const deployed = result.waves[0].groups.flatMap(group => group.positions.filter(position => position.cardId).map(position => position.cardId));
  assert.equal(new Set(deployed).size, deployed.length);
  assert.ok(Object.values(result.remainingInventory).every(quantity => quantity >= 0));
});

test('regional enemy increase and one ordinary debuff reproduce the four destroyer screenshot', () => {
  const ids = ['san_diego', 'johnston', 'benson', 'helldiver_essex'];
  const input = request(ids, {}, { model: { rounding: 'conservative' } });
  input.cards.forEach((card, i) => { card.health = [3, 2, 2, 2][i]; });
  input.enemies = [160, 164, 159, 159].map((power, i) => ({ active: true, power, powerIncrease: 0.16,
    weaknesses: [['debuff_ring_projectile', 'debuff_three_shells'], ['debuff_concentric_target', 'debuff_three_shells'],
      ['debuff_ring_projectile', 'debuff_three_shells'], ['debuff_three_shells', 'debuff_plane']][i] }));
  const result = evaluate(ids.map(id => unit(id)), input);
  assert.deepEqual(result.positions.map(p => p.enemyPower), [132, 164, 132, 132]);
  assert.deepEqual(result.positions.map(p => p.ownPower), [130, 170, 137, 152]);
  assert.deepEqual(result.positions.map(p => p.win), [false, true, true, true]);
  assert.equal(result.wins, 3);
  assert.deepEqual(result.positions.map(p => p.enemyBasePower), [138, 141, 137, 137]);
});

test('enemy regional metadata affects search and action, rejects stale captures and invalid reconstruction', () => {
  const input = request(['johnston', 'san_diego'], {}, { model: { rounding: 'conservative' } });
  input.enemies = input.enemies.map((e, i) => ({ ...e, active: i === 0, power: 160, powerIncrease: 0.16, weaknesses: ['debuff_three_shells'] }));
  input.conditions = { allowedTypes: ['cruiser'] }; // only san_diego can deploy, johnston cannot supply a debuff
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    assert.equal(solve(input, catalog, items, options).wins, 0);
  }
  const weakOnly = request(['john_d_ford'], {}, { model: { rounding: 'conservative' } });
  weakOnly.enemies = weakOnly.enemies.map((e, i) => ({ ...e, active: i === 0, power: 116, powerIncrease: 0.16, weaknesses: ['debuff_ring_projectile'] }));
  // Original100 reduced by20 then increased by16 is96; old boosted116×0.8 wrongly lets power94 win.
  const modified = structuredClone(catalog);
  modified.cards.find(c => c.id === 'john_d_ford').firepower = 34;
  modified.cards.find(c => c.id === 'john_d_ford').power_min = 94;
  modified.cards.find(c => c.id === 'john_d_ford').effects[1].direction = 'front';
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(weakOnly, modified, items, options);
    assert.equal(result.wins, 0);
    assert.equal(result.positions[0].enemyPower, 96);
  }
  weakOnly.waves = [{ enemies: weakOnly.enemies }];
  assert.equal(solveAction(weakOnly, modified, items).wins, 0);
  for (const powerIncrease of ['0.16', -0.16, 0.12]) {
    assert.throws(() => evaluate([unit('john_d_ford'), null, null, null],
      { ...weakOnly, enemies: weakOnly.enemies.map(e => ({ ...e, powerIncrease })) }), /敌军.*增益/);
  }
  assert.throws(() => evaluate([unit('john_d_ford'), null, null, null],
    { ...weakOnly, enemies: weakOnly.enemies.map(e => ({ ...e, power: 4 })) }), /原战力/);
  const stale = { ...input, enemies: input.enemies.map(({ powerIncrease, ...e }) => e),
    conditions: { captureSource: { enemyPowerIncreases: [{ type: 'destroyer', rate: 0.16 }] } } };
  assert.throws(() => solve(stale, catalog, items), /重新采集/);
});

test('mixed capture keeps submarine regional16 on original139 for evaluation, search and action', () => {
  const input = request(['missouri'], {}, { model: { rounding: 'conservative' } });
  input.conditions = { captureSource: { ignoredEnemyPowerIncrease: 0.08,
    ignoredEnemyPowerIncreases: [{ type: 'destroyer', rate: 0.16 }], enemyPowerIncreases: [{ type: 'submarine', rate: 0.16 }] } };
  input.enemies = input.enemies.map((enemy, i) => ({ ...enemy, active: i === 0, power: 161, powerIncrease: i === 0 ? 0.16 : 0,
    weaknesses: ['debuff_concentric_target'] }));
  const evaluated = evaluate([unit('missouri'), null, null, null], input);
  assert.equal(evaluated.positions[0].enemyBasePower, 139);
  assert.equal(evaluated.positions[0].enemyPower, 133); // round(139 × (1 + 0.16 - 0.2))
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(input, catalog, items, options);
    assert.equal(result.positions[0].enemyPower, 133);
    const action = solveAction({ ...input, waves: [{ enemies: input.enemies, groupConditions: [input.conditions] }] }, catalog, items, options);
    assert.equal(action.waves[0].groups[0].positions[0].enemyBasePower, 139);
    assert.equal(action.waves[0].groups[0].positions[0].enemyPower, 133);
  }
});

test('boosted enemies retain unmatched display values and add reductions with existing rounding', () => {
  const input = request(['north_carolina', 'corsair_essex'], { special_debuff_amplifier: 1 }, { model: { rounding: 'conservative' } });
  input.enemies = input.enemies.map(e => ({ ...e, power: 159, powerIncrease: 0.16, weaknesses: ['debuff_vertical_lines'] }));
  const result = evaluate([unit('north_carolina'), null, unit('corsair_essex'), null], input);
  assert.equal(result.positions[0].enemyPower, 159);
  assert.equal(result.positions[1].enemyPower, 105); // ceil(137 × (1 + 0.16 - 0.2 - 0.2)); rounding remains unconfirmed
  assert.equal(result.positions[1].enemyPowerRoundingAssumed, true);
  const amplified = evaluate([unit('north_carolina', null, 'special_debuff_amplifier'), null, null, null], input);
  assert.equal(amplified.positions[1].enemyPower, 105);
  assert.equal(amplified.positions[1].enemyPowerRoundingAssumed, true);
  input.conditions = { debuffsDisabled: true };
  assert.deepEqual(evaluate([unit('north_carolina'), null, unit('corsair_essex'), null], input).positions.map(p => p.enemyPower), [159, 159, 159, 159]);
});

test('disabled items forbid both equipment slots including ignore conditions; search uses no items', () => {
  const input = request(['missouri'], { standard_firepower: 4, special_disable_effects_power: 4, special_ignore_conditions: 4 },
    { conditions: { itemsDisabled: true } });
  for (const [standard, special] of [['standard_firepower', null], [null, 'special_disable_effects_power'], [null, 'special_ignore_conditions']]) {
    assert.throws(() => evaluate([unit('missouri', standard, special), null, null, null], input), /禁用道具/);
  }
  assert.equal(evaluate([unit('missouri'), null, null, null], input).positions[0].ownPower, 190);
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(input, catalog, items, options);
    assert.equal(result.wins, 0);
    assert.deepEqual(result.usedItems, {});
  }
  assert.throws(() => solve({ ...input, conditions: { itemsDisabled: 'true' } }, catalog, items), /开关/);
});

test('disabled items are local to a group and preserve equipment for a later wave', () => {
  const input = request(['missouri'], { standard_firepower: 1 });
  input.enemies = input.enemies.map((enemy, i) => ({ ...enemy, active: i === 0 }));
  input.waves = [{ enemies: input.enemies, groupConditions: [{ itemsDisabled: true }] }, { enemies: input.enemies }];
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].wins, 0);
  assert.deepEqual(result.waves[0].groups[0].usedItems, {});
  assert.equal(result.waves[0].remainingInventory.standard_firepower, 1);
  assert.equal(result.waves[1].wins, 1);
  assert.equal(result.waves[1].groups[0].usedItems.standard_firepower, 1);
  assert.equal(result.waves[1].groups[0].conditions.itemsDisabled, false);
});

test('early healing never equips an item in a group that disables equipment', () => {
  const input = request(['missouri'], { special_restore_health: 1 });
  input.waves = [170, 160, 140, 165].map((power, wave) => ({
    enemies: input.enemies.map((enemy, i) => ({ ...enemy, active: i === 0, power })),
    groupConditions: [{ itemsDisabled: wave < 3 }],
  }));
  const result = solveAction(input, catalog, items);
  assert.equal(result.wins, 3);
  assert.deepEqual(result.usedItems, {});
  assert.equal(result.healingRetries, 0);
});

test('50 percent buff reduction halves card bonus rates after amplification, not equipment bonuses', () => {
  const input = request(['north_carolina','helldiver_essex'], {standard_firepower:1,standard_buff_amplifier:1,special_ignore_conditions:1});
  input.conditions = {buffsReduced:true};
  const normal = evaluate([unit('north_carolina','standard_firepower'),unit('helldiver_essex'),null,null],input);
  assert.equal(normal.positions[0].ownPower,208);
  assert.ok(Math.abs(normal.positions[0].effects[0].rate-0.15)<1e-8);
  const amplified = evaluate([unit('north_carolina','standard_firepower'),unit('helldiver_essex','standard_buff_amplifier'),null,null],input);
  assert.equal(amplified.positions[0].ownPower,220);
  const ignored = evaluate([unit('north_carolina','standard_firepower'),unit('helldiver_essex','standard_buff_amplifier','special_ignore_conditions'),null,null],input);
  assert.equal(ignored.positions[0].ownPower,244);
  const receiverOnly = evaluate([unit('north_carolina',null,'special_ignore_conditions'),unit('helldiver_essex'),null,null],input);
  assert.equal(receiverOnly.positions[0].ownPower,192);
});

test('50 percent debuff reduction halves each matched, amplified and forced source', () => {
  const input = request(['north_carolina','corsair_essex'], {special_debuff_amplifier:1,special_force_debuff:1,special_ignore_conditions:1});
  input.conditions = {debuffsReduced:true};
  input.enemies[1].weaknesses=['debuff_vertical_lines'];
  assert.equal(evaluate([unit('north_carolina'),null,unit('corsair_essex'),null],input).positions[1].enemyPower,160);
  assert.ok(Math.abs(evaluate([unit('north_carolina',null,'special_debuff_amplifier'),null,unit('corsair_essex'),null],input).positions[1].enemyPower-140)<1e-8);
  const ignored=evaluate([unit('north_carolina',null,'special_ignore_conditions'),null,unit('corsair_essex'),null],input);
  assert.equal(ignored.positions[1].enemyPower,140);
  input.enemies[1].weaknesses=[];
  assert.equal(evaluate([unit('north_carolina'),null,unit('corsair_essex',null,'special_force_debuff'),null],input).positions[1].enemyPower,180);
  input.conditions.debuffsDisabled=true;
  assert.equal(evaluate([unit('north_carolina',null,'special_ignore_conditions'),null,unit('corsair_essex'),null],input).positions[1].enemyPower,200);
});

test('effect failure still disables reduced effects while ignore conditions restores reduced outgoing buffs', () => {
  const input=request(['north_carolina','helldiver_essex'],{special_ignore_conditions:1});
  input.conditions={buffsDisabled:true,buffsReduced:true};
  assert.equal(evaluate([unit('north_carolina'),unit('helldiver_essex'),null,null],input).positions[0].ownPower,180);
  assert.equal(evaluate([unit('north_carolina'),unit('helldiver_essex',null,'special_ignore_conditions'),null,null],input).positions[0].ownPower,204);
});

test('search retains ignore-conditions equipment for reduced buffs or debuffs alone', () => {
  for(const options of [{},{exactLimit:0,beamWidth:300}]){
    const buffInput=request(['north_carolina','helldiver_essex'],{special_ignore_conditions:1});
    buffInput.conditions={buffsReduced:true};
    buffInput.enemies=buffInput.enemies.map((e,i)=>({...e,active:i===0,power:200}));
    const buffResult=solve(buffInput,catalog,items,{...options,allowEmpty:true});
    assert.equal(buffResult.wins,1);
    assert.equal(buffResult.positions[1].specialId,'special_ignore_conditions');
    const debuffInput=request(['missouri'],{special_ignore_conditions:1});
    debuffInput.conditions={debuffsReduced:true};
    debuffInput.enemies=debuffInput.enemies.map((e,i)=>({...e,active:i===0,power:220,weaknesses:['debuff_concentric_target']}));
    const debuffResult=solve(debuffInput,catalog,items,{...options,allowEmpty:true});
    assert.equal(debuffResult.wins,1);
    assert.equal(debuffResult.positions[0].specialId,'special_ignore_conditions');
    assert.equal(debuffResult.positions[0].enemyPower,176);
  }
});

test('effect reductions are local to each action group and require boolean inputs', () => {
  const input=request(['missouri']);
  input.enemies=input.enemies.map((e,i)=>({...e,active:i===0,weaknesses:['debuff_concentric_target']}));
  input.waves=[{enemies:input.enemies,groupConditions:[{buffsReduced:true,debuffsReduced:true}]},{enemies:input.enemies}];
  const result=solveAction(input,catalog,items);
  assert.equal(result.wins,2);
  assert.equal(result.waves[0].groups[0].positions[0].enemyPower,180);
  assert.equal(result.waves[1].groups[0].positions[0].enemyPower,160);
  assert.equal(result.waves[1].groups[0].conditions.buffsReduced,false);
  assert.equal(result.waves[1].groups[0].conditions.debuffsReduced,false);
  for(const conditions of [{buffsReduced:'true'},{debuffsReduced:0}])
    assert.throws(()=>solve({...input,conditions},catalog,items));
});

test('action heals before exhaustion when it increases later-wave wins', () => {
  const input = request(['missouri'], { special_restore_health: 1 });
  input.waves = [170, 160, 140, 165].map(power => ({
    enemies: input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0, power })),
  }));
  const original = structuredClone(input);
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solveAction(input, catalog, items, options);
    assert.equal(result.wins, 4);
    assert.deepEqual(result.usedItems, { special_restore_health: 1 });
    const healing = result.waves[2].groups[0].positions.find(p => p.cardId);
    assert.equal(healing.originalHealth, 1);
    assert.equal(healing.health, 3);
    assert.equal(healing.healthAfter, 2);
    assert.equal(healing.specialId, 'special_restore_health');
    assert.equal(result.waves[2].groups[0].replayed, true);
    assert.equal(result.waves[2].groups[0].explored, 0);
    assert.equal(result.waves[3].groups[0].positions.find(p => p.cardId).originalHealth, 2);
    assert.equal(result.remainingInventory.special_restore_health, 0);
    assert.deepEqual(input, original);
  }
});

test('early healing does not spend items without extra wins or overwrite required green items', () => {
  for (const [stock, powers, expectedItems] of [
    [{}, [170, 160, 140, 165], {}],
    [{special_restore_health:1}, [170, 160, 140, 1000], {}],
    [{special_restore_health:1}, [170, 160, 140], {}],
    [{special_restore_health:1,special_disable_effects_power:1}, [170, 160, 200, 165], {special_disable_effects_power:1}],
  ]) {
    const input = request(['missouri'], stock);
    input.waves = powers.map(power => ({ enemies: input.enemies.map((e,i) => ({...e,active:i===0,power})) }));
    const result = solveAction(input, catalog, items);
    assert.equal(result.wins, 3);
    assert.deepEqual(result.usedItems, expectedItems);
  }
});

test('healing retries preserve empty groups and once-per-wave deployment', () => {
  const input = request(['missouri'], {special_restore_health:1});
  input.waves = [170,160,140,165].map(power => ({enemies:Array.from({length:8},(_,i)=>({active:i%4===0,power,weaknesses:[]}))}));
  const result = solveAction(input,catalog,items);
  assert.equal(result.wins,4);
  assert.equal(result.targetCount,8);
  assert.ok(result.waves.every(w=>w.groups.flatMap(g=>g.formation).filter(Boolean).length===1));
  assert.equal(result.remainingInventory.special_restore_health,0);
});

test('multiple early heals carry their health and stock through six waves', () => {
  const input = request(['missouri'], {special_restore_health:2});
  input.waves = Array.from({length:6},()=>({enemies:input.enemies.map((e,i)=>({...e,active:i===0,power:80}))}));
  const result = solveAction(input,catalog,items);
  assert.equal(result.wins,6);
  assert.equal(result.earlyHealing.length,2);
  assert.equal(result.usedItems.special_restore_health,2);
  assert.equal(result.remainingInventory.special_restore_health,0);
});

test('synthetic 44-enemy action improves wins and preserves resources with early healing', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/early-healing-action.json',import.meta.url)));
  const original = structuredClone(input);
  const result = solveAction(input,catalog,items,{beamWidth:2400});
  assert.ok(result.wins > 36, '提前回血应增加前三波36胜以外的胜场');
  assert.equal(result.targetCount,44);
  assert.ok(result.earlyHealing.length>0);
  for (const wave of result.waves) {
    const units = wave.groups.flatMap(g=>g.positions).filter(p=>p.cardId);
    assert.equal(new Set(units.map(p=>p.cardId)).size,units.length);
    assert.ok(units.every(p=>p.originalHealth>0 && p.healthAfter===p.health-1));
    assert.ok(Object.values(wave.remainingInventory).every(q=>q>=0));
  }
  for (const [id,quantity] of Object.entries(input.inventory))
    assert.equal(result.remainingInventory[id],quantity-(result.usedItems[id]??0));
  assert.deepEqual(input,original);
});

test('exact and bounded search use gray items before green without sacrificing wins', () => {
  const input = request(['north_carolina'], { standard_firepower: 1, special_disable_effects_power: 1 });
  input.enemies = input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0 }));
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    for (const [power, expectedItems] of [[170, {}], [190, { standard_firepower: 1 }], [200, { special_disable_effects_power: 1 }]]) {
      input.enemies[0].power = power;
      const result = solve(input, catalog, items, { ...options, allowEmpty: true });
      assert.equal(result.wins, 1);
      assert.deepEqual(result.usedItems, expectedItems);
    }
  }
});

test('two gray items are preferred over one green item for the same wins', () => {
  const input = request(['north_carolina', 'helldiver_essex'], {
    standard_firepower: 1, standard_buff_amplifier: 1, special_disable_effects_power: 1,
  });
  input.enemies = input.enemies.map((enemy, index) => ({ ...enemy, active: index < 2, power: index === 0 ? 240 : 150 }));
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(input, catalog, items, { ...options, allowEmpty: true });
    assert.equal(result.wins, 2);
    assert.deepEqual(result.usedItems, { standard_firepower: 1, standard_buff_amplifier: 1 });
    assert.equal(result.positions[0].cardId, 'north_carolina');
    assert.equal(result.positions[1].cardId, 'helldiver_essex');
  }
});

test('action preserves green inventory when gray suffices and uses green in a later wave', () => {
  const input = request(['north_carolina'], { standard_firepower: 1, special_disable_effects_power: 1 });
  input.waves = [190, 200].map(power => ({
    enemies: input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0, power })),
  }));
  const original = structuredClone(input);
  const result = solveAction(input, catalog, items);
  assert.equal(result.wins, 2);
  assert.deepEqual(result.waves[0].groups[0].usedItems, { standard_firepower: 1 });
  assert.equal(result.waves[0].remainingInventory.special_disable_effects_power, 1);
  assert.deepEqual(result.waves[1].groups[0].usedItems, { special_disable_effects_power: 1 });
  assert.equal(result.remainingInventory.standard_firepower, 0);
  assert.equal(result.remainingInventory.special_disable_effects_power, 0);
  assert.deepEqual(input, original);
});

test('Laffey smoke debuffs only the enemy directly ahead at every position', () => {
  const input = request(['laffey']);
  input.enemies.forEach(enemy => { enemy.weaknesses = ['debuff_ring_projectile']; });
  for (let position = 0; position < 4; position++) {
    const formation = Array.from({ length: 4 }, (_, index) => index === position ? unit('laffey') : null);
    const result = evaluate(formation, input);
    assert.deepEqual(result.positions.map(entry => entry.enemyPower),
      Array.from({ length: 4 }, (_, index) => index === position ? 160 : 200));
    assert.equal(result.wins, 1);
  }
  input.waves = [{ enemies: input.enemies }];
  const result = solveAction(input, catalog, items);
  assert.equal(result.wins, 1);
  assert.equal(result.itemCount, 0);
  const deployed = result.waves[0].groups[0].positions.find(position => position.cardId);
  assert.equal(deployed.enemyPower, 160);
});

test('all catalog cards can be selected for evaluation and action planning', () => {
  const input = request(catalog.cards.map(card => card.id));
  input.enemies.forEach(enemy => { enemy.power = 1; });
  assert.equal(evaluate([unit('missouri'), null, null, null], input).wins, 1);
  input.waves = [{ enemies: input.enemies }];
  const result = solveAction(input, catalog, items, { exactLimit: 0, beamWidth: 300 });
  assert.equal(result.wins, 4);
  assert.equal(result.remainingCards.length, catalog.cards.length);
});

test('action replans a failed later group before spending its specialist in an earlier group', () => {
  const input = request(['arrow', 'hughes']);
  const group = (power, weaknesses) => input.enemies.map((e, i) => ({ ...e, power, weaknesses, active: i === 0 }));
  input.waves = [{ enemies: [...group(80, []), ...group(110, ['debuff_concentric_target'])],
    groupConditions: [{ itemsDisabled: true }, { global: { mobility: 0.01 } }] }];
  const original = structuredClone(input);
  for (const options of [{}, { exactLimit: 0, beamWidth: 2400 }]) {
    const progress = [];
    const result = solveAction(input, catalog, items, { ...options, onProgress: p => progress.push(p) });
    assert.equal(result.wins, 2);
    assert.deepEqual(result.waves[0].groups.map(g => g.group), [1, 2]);
    assert.equal(result.waves[0].groups[0].positions[0].cardId, 'hughes');
    assert.equal(result.waves[0].groups[1].positions[0].cardId, 'arrow');
    assert.equal(result.waves[0].remainingCards.find(c => c.cardId === 'arrow').health, 2);
    assert.equal(result.waves[0].remainingCards.find(c => c.cardId === 'hughes').health, 2);
    assert.deepEqual(result.groupRepairs, [{ wave: 1, group: 2 }]);
    assert.equal(result.waves[0].groups[0].conditions.itemsDisabled, true);
    assert.equal(result.waves[0].groups[1].global.mobility, 0.01);
    assert.ok(progress.some(p => p.phase === 'repair'));
    assert.deepEqual(input, original);
  }
});

test('unsuccessful group replanning keeps the accepted plan, inventory and unused health', () => {
  const input = request(['arrow', 'hughes'], { standard_mobility: 1 });
  const group = input.enemies.map((e, i) => ({ ...e, active: i === 0, power: 999999 }));
  input.waves = [{ enemies: [...group, ...group] }];
  const original = structuredClone(input);
  const result = solveAction(input, catalog, items);
  assert.equal(result.wins, 0);
  assert.deepEqual(result.groupRepairs, []);
  assert.equal(result.groupRepairRetries, 1);
  assert.equal(result.remainingInventory.standard_mobility, 1);
  assert.deepEqual(result.remainingCards, input.cards);
  assert.deepEqual(input, original);
});

test('action reuses identical searches across groups and unsuccessful repairs only within this action', () => {
  const input = request(['arrow', 'hughes', 'missouri', 'laffey', 'johnston']);
  input.enemies.forEach(enemy => { enemy.power = 1000000; });
  input.waves = Array.from({ length: 2 }, () => ({ enemies: [...input.enemies, ...input.enemies] }));
  const original = structuredClone(input);
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const single = solve(input, catalog, items, { ...options, allowEmpty: true });
    const result = solveAction(input, catalog, items, options);
    assert.equal(result.wins, 0);
    assert.equal(result.groupRepairRetries, 2);
    assert.equal(result.explored, single.explored);
    assert.ok(result.searchCacheHits >= 3);
    assert.equal(result.waves[0].groups[1].searchReused, true);
    assert.equal(result.waves[0].groups[1].explored, 0);
    assert.notEqual(result.waves[0].groups[0].positions, result.waves[0].groups[1].positions);
    assert.deepEqual(result.remainingCards, input.cards);
    assert.deepEqual(input, original);
    // A new call must do its own first search, including when search settings change.
    assert.equal(solveAction(input, catalog, items, options).explored, single.explored);
  }
});

test('action search reuse respects health, stock, enemies, conditions and captured source metadata', () => {
  const input = request(['missouri'], { standard_firepower: 1 });
  const enemies = input.enemies.map((enemy, i) => ({ ...enemy, power: 190, active: i === 0 }));
  input.waves = Array.from({ length: 3 }, () => ({ enemies }));
  const result = solveAction(input, catalog, items);
  assert.deepEqual(result.waves.map(wave => wave.wins), [1, 0, 0]);
  assert.equal(result.remainingCards[0].health, 2);
  assert.equal(result.remainingInventory.standard_firepower, 0);
  assert.ok(result.searchCacheHits > 0);
  assert.equal(result.waves[2].groups[0].searchReused, true);
  const changed = request(['missouri']);
  changed.waves = [
    { enemies: enemies.map(enemy => ({ ...enemy, power: 1000000 })), groupConditions: [{ captureSource: { action: 'A' } }] },
    { enemies: enemies.map(enemy => ({ ...enemy, power: 1000000 })), groupConditions: [{ captureSource: { action: 'B' } }] },
    { enemies: enemies.map(enemy => ({ ...enemy, power: 180 })), groupConditions: [{ global: { firepower: 1 } }] },
    { enemies: enemies.map(enemy => ({ ...enemy, power: 180 })), groupConditions: [{}] },
    { enemies: enemies.map(enemy => ({ ...enemy, power: 200 })), groupConditions: [{}] },
    { enemies: enemies.map(enemy => ({ ...enemy, power: 200, weaknesses: ['debuff_concentric_target'] })), groupConditions: [{}] },
  ];
  const distinct = solveAction(changed, catalog, items);
  assert.deepEqual(distinct.waves.map(wave => wave.wins), [0, 0, 0, 1, 0, 1]);
  assert.deepEqual(distinct.waves.slice(0, 2).map(wave => wave.groups[0].conditions.captureSource.action), ['A', 'B']);
  assert.equal(distinct.searchCacheHits, 0);
});

test('exact and bounded action search save stronger cards for later groups', () => {
  const strong = ['missouri', 'north_carolina', 'helldiver_essex', 'corsair_essex'];
  const weak = ['wildcat_saratoga', 'marblehead', 'arrow', 'john_d_ford'];
  const input = request([...strong, ...weak], { special_disable_effects_power: 4 });
  const enemies = power => Array.from({ length: 4 }, () => ({ active: true, power, weaknesses: [] }));
  input.waves = [{ enemies: [...enemies(80), ...enemies(110)],
    groupConditions: [{ buffsDisabled: true }, { buffsDisabled: true }] }];
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const original = structuredClone(input);
    const result = solveAction(input, catalog, items, options);
    assert.equal(result.wins, 8);
    assert.equal(result.itemCount, 0);
    assert.deepEqual(new Set(result.waves[0].groups[0].formation.map(entry => entry.cardId)), new Set(weak));
    assert.deepEqual(new Set(result.waves[0].groups[1].formation.map(entry => entry.cardId)), new Set(strong));
    assert.deepEqual(input, original);
  }
});

test('action uses a weaker card first and saves stronger card health for a later wave', () => {
  const input = request(['missouri', 'wildcat_saratoga'], { special_disable_effects_power: 1 });
  input.cards[1].health = 1;
  input.waves = [60, 175].map(power => ({
    enemies: Array.from({ length: 4 }, (_, index) => ({ active: index === 0, power, weaknesses: [] })),
    groupConditions: [{ buffsDisabled: true }],
  }));
  const result = solveAction(input, catalog, items);
  assert.equal(result.wins, 2);
  assert.equal(result.itemCount, 0);
  assert.equal(result.waves[0].groups[0].positions[0].cardId, 'wildcat_saratoga');
  assert.equal(result.waves[0].remainingCards.find(card => card.cardId === 'missouri').health, 3);
  assert.equal(result.waves[1].groups[0].positions[0].cardId, 'missouri');
});

test('saving weaker cards never takes priority over wins or avoiding items', () => {
  const input = request(['wildcat_saratoga', 'missouri'], { special_disable_effects_power: 1 });
  input.enemies = input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0, power: 100 }));
  input.conditions = { buffsDisabled: true };
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(input, catalog, items, { ...options, allowEmpty: true });
    assert.equal(result.wins, 1);
    assert.equal(result.itemCount, 0);
    assert.equal(result.positions[0].cardId, 'missouri');
    assert.equal(result.formation.filter(Boolean).length, 1);
  }
});

test('weaker-card preference uses actual debuffs and still requires a strict win', () => {
  const input = request(['missouri', 'wildcat_saratoga']);
  input.enemies = input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0,
    power: 100, weaknesses: ['debuff_vertical_lines'] }));
  for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
    const result = solve(input, catalog, items, { ...options, allowEmpty: true });
    assert.equal(result.positions[0].cardId, 'wildcat_saratoga');
    assert.equal(result.positions[0].enemyPower, 80);
    assert.equal(result.wins, 1);
    input.enemies[0].power = 112.5;
    const tied = solve(input, catalog, items, { ...options, allowEmpty: true });
    assert.equal(tied.positions[0].cardId, 'missouri');
    assert.equal(tied.wins, 1);
    input.enemies[0].power = 100;
  }
});

test('Missouri has minimum power 190 and debuffs the front and upper-right enemies', () => {
  const input = request(['missouri']);
  input.enemies.forEach(enemy => { enemy.weaknesses = ['debuff_concentric_target', 'debuff_single_shell']; });
  const middle = evaluate([null, unit('missouri'), null, null], input);
  assert.equal(middle.positions[1].ownPower, 190);
  assert.equal(middle.positions[0].enemyPower, 200);
  assert.equal(middle.positions[1].enemyPower, 160);
  assert.equal(middle.positions[2].enemyPower, 160);
  assert.equal(middle.positions[3].enemyPower, 200);
  const edge = evaluate([null, null, null, unit('missouri')], input);
  assert.equal(edge.positions[3].enemyPower, 160);
  assert.equal(edge.positions[0].enemyPower, 200);
});

test('neighbor buff and item add to the same attribute without subtracting ten twice', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { standard_firepower: 1 });
  const result = evaluate([unit('north_carolina', 'standard_firepower'), unit('helldiver_essex'), null, null], input);
  assert.equal(result.positions[0].ownPower, 220);
  assert.equal(result.positions[0].stats.firepower, 120);
});

test('buff amplification makes the outgoing 30 percent bonus become 60 percent', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { standard_buff_amplifier: 1 });
  const result = evaluate([unit('north_carolina'), unit('helldiver_essex', 'standard_buff_amplifier'), null, null], input);
  assert.equal(result.positions[0].ownPower, 228);
});

test('two debuffs add their rates, including amplified and reduced effects', () => {
  const input = request(['corsair_essex', 'hellcat_enterprise'], { special_debuff_amplifier: 2 });
  input.enemies[1].weaknesses = ['debuff_plane'];
  const normal = evaluate([unit('corsair_essex'), null, unit('hellcat_enterprise'), null], input);
  const amplified = evaluate([unit('corsair_essex', null, 'special_debuff_amplifier'), null, unit('hellcat_enterprise'), null], input);
  assert.ok(Math.abs(normal.positions[1].enemyPower - 120) < 1e-9);
  assert.ok(Math.abs(amplified.positions[1].enemyPower - 80) < 1e-9);
  const twiceAmplified = [unit('corsair_essex', null, 'special_debuff_amplifier'), null,
    unit('hellcat_enterprise', null, 'special_debuff_amplifier'), null];
  assert.ok(Math.abs(evaluate(twiceAmplified, input).positions[1].enemyPower - 40) < 1e-9);
  input.conditions = { debuffsReduced: true };
  assert.ok(Math.abs(evaluate(twiceAmplified, input).positions[1].enemyPower - 120) < 1e-9);
});

test('three sources and two effects from one card add on original enemy power', () => {
  const input = request(['north_carolina', 'san_diego', 'corsair_essex']);
  input.enemies[1] = { active: true, power: 232, powerIncrease: 0.16, weaknesses: ['debuff_vertical_lines'] };
  const result = evaluate([unit('north_carolina'), unit('san_diego'), unit('corsair_essex'), null], input);
  assert.ok(Math.abs(result.positions[1].enemyRaw - 112) < 1e-9); // 200 × (1 + 0.16 - 3 × 0.2)
  assert.equal(result.positions[1].effects.filter(e => e.kind === 'debuff').length, 3);
  const modified = structuredClone(catalog);
  modified.cards.find(c => c.id === 'missouri').effects[1].direction = 'front';
  const sameSource = request(['missouri']);
  sameSource.enemies[0].weaknesses = ['debuff_concentric_target', 'debuff_single_shell'];
  const combined = evaluateFormation([unit('missouri'), null, null, null], sameSource, modified, items);
  assert.ok(Math.abs(combined.positions[0].enemyPower - 120) < 1e-9);
});

test('exact and bounded searches and multi-wave action use additive enemy debuffs', () => {
  for (const increase of [0, 0.16]) {
    const bases = increase ? [240, 210] : [300, 270];
    const input = request(['corsair_essex', 'missouri', 'hellcat_enterprise']);
    const enemies = base => input.enemies.map((e, i) => ({ ...e, active: i === 1,
      power: Math.round(base * (1 + increase)), powerIncrease: increase, weaknesses: ['debuff_plane'] }));
    input.enemies = enemies(bases[0]);
    input.waves = bases.map(base => ({ enemies: enemies(base) }));
    const original = structuredClone(input);
    for (const options of [{}, { exactLimit: 0, beamWidth: 300 }]) {
      const result = solve(input, catalog, items, { ...options, allowEmpty: true });
      assert.equal(result.wins, 1);
      assert.equal(result.positions[1].cardId, 'missouri');
      assert.ok(Math.abs(result.positions[1].enemyRaw - bases[0] * (1 + increase - 0.4)) < 1e-9);
      const action = solveAction(input, catalog, items, options);
      assert.equal(action.wins, 2);
      assert.deepEqual(action.remainingCards.map(c => c.health), [1, 1, 1]);
      assert.deepEqual(action.remainingInventory, input.inventory);
    }
    assert.deepEqual(input, original);
  }
});

test('forced debuffs keep their directions and do not wrap around the board', () => {
  const input = request(['farragut'], { special_force_debuff: 1 });
  const result = evaluate([unit('farragut', null, 'special_force_debuff'), null, null, null], input);
  assert.equal(result.positions[1].enemyPower, 160);
  assert.equal(result.positions[3].enemyPower, 200);
  assert.equal(result.positions[0].enemyPower, 200);
});

test('Enterprise Avenger air strike targets the upper-right enemy and stops at the edge', () => {
  const input = request(['avenger_enterprise']);
  input.enemies.forEach(enemy => { enemy.weaknesses = ['debuff_plane']; });
  const middle = evaluate([null, unit('avenger_enterprise'), null, null], input);
  assert.equal(middle.positions[1].enemyPower, 200);
  assert.equal(middle.positions[2].enemyPower, 160);
  const edge = evaluate([null, null, null, unit('avenger_enterprise')], input);
  assert.ok(edge.positions.every(position => position.enemyPower === 200));
});

test('the 40 percent item disables both outgoing effects', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { special_disable_effects_power: 1 });
  input.enemies[1].weaknesses = ['debuff_plane'];
  const result = evaluate([unit('north_carolina'), unit('helldiver_essex', null, 'special_disable_effects_power'), null, null], input);
  assert.equal(result.positions[0].ownPower, 180);
  assert.ok(Math.abs(result.positions[1].ownPower - 242) < 1e-9);
  assert.equal(result.positions[1].enemyPower, 200);
});

test('healing restores two health capped at three and ignores conditions only on its holder', () => {
  const input = request(['north_carolina'], { special_restore_health: 1, special_ignore_conditions: 1 });
  input.cards[0].health = 1;
  const healed = evaluate([unit('north_carolina', null, 'special_restore_health'), null, null, null], input);
  assert.equal(healed.positions[0].health, 3);
  assert.equal(healed.positions[0].ownPower, 180);
  input.cards[0].health = 3;
  input.global = { firepower: 0.24, survivability: 0.24, mobility: 0.24 };
  const normal = evaluate([unit('north_carolina'), null, null, null], input);
  const ignored = evaluate([unit('north_carolina', null, 'special_ignore_conditions'), null, null, null], input);
  assert.ok(Math.abs(normal.positions[0].ownPower - 134.4) < 1e-9);
  assert.equal(ignored.positions[0].ownPower, 180);
});

test('empty positions cannot win and ties are controlled by an explicit setting', () => {
  const input = request(['north_carolina']);
  input.enemies[0].power = 180;
  assert.equal(evaluate([unit('north_carolina'), null, null, null], input).wins, 0);
  input.model.allowEqual = true;
  assert.equal(evaluate([unit('north_carolina'), null, null, null], input).wins, 1);
});

test('reject duplicate cards, insufficient inventory, invalid weakness and zero-health revival', () => {
  const input = request(['north_carolina', 'king_george_v'], { standard_firepower: 1 });
  assert.throws(() => evaluate([unit('north_carolina'), unit('north_carolina'), null, null], input));
  assert.throws(() => evaluate([unit('north_carolina', 'standard_firepower'), unit('king_george_v', 'standard_firepower'), null, null], input));
  input.enemies[0].weaknesses = ['wrong'];
  assert.throws(() => solve(input, catalog, items));
  const zero = request(['north_carolina'], { special_restore_health: 1 });
  zero.cards[0].health = 0;
  assert.throws(() => evaluate([unit('north_carolina', null, 'special_restore_health'), null, null, null], zero));
});

test('exact search matches an independent enumeration of the selected four cards', () => {
  const ids = ['north_carolina', 'king_george_v', 'helldiver_essex', 'johnston'];
  const input = request(ids);
  input.enemies.forEach(enemy => { enemy.power = 180; enemy.weaknesses = ['debuff_plane', 'debuff_single_shell']; });
  let maximum = 0;
  function enumerate(prefix, remaining) {
    if (!remaining.length) maximum = Math.max(maximum, evaluate(prefix.map(id => unit(id)), input).wins);
    else remaining.forEach((id, index) => enumerate([...prefix, id], remaining.filter((_, other) => index !== other)));
  }
  enumerate([], ids);
  const result = solve(input, catalog, items);
  assert.equal(result.searchMode, 'exact');
  assert.equal(result.wins, maximum);
  assert.equal(new Set(result.formation.map(entry => entry.cardId)).size, 4);
});

test('bounded search labels its result and stays within the item budget', () => {
  const input = request(['north_carolina', 'king_george_v', 'helldiver_essex', 'johnston'], { standard_firepower: 1, special_debuff_amplifier: 1 });
  const result = solve(input, catalog, items, { exactLimit: 0, beamWidth: 100 });
  assert.equal(result.searchMode, 'bounded');
  assert.ok((result.usedItems.standard_firepower ?? 0) <= 1);
  assert.ok((result.usedItems.special_debuff_amplifier ?? 0) <= 1);
  assert.equal(result.formation.filter(Boolean).length, 4);
});

test('action respects once-per-wave deployment and carries health between waves', () => {
  const input = request(['north_carolina']);
  const enemy = { active: true, power: 1, weaknesses: [] };
  input.waves = [8, 4, 4, 4].map(count => ({ enemies: Array.from({ length: count }, () => ({ ...enemy })) }));
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves.length, 4);
  assert.equal(result.waves[0].groups.reduce((count, group) => count + group.formation.filter(Boolean).length, 0), 1);
  assert.deepEqual(result.waves.map(wave => wave.remainingCards[0].health), [2, 1, 0, 0]);
  assert.equal(result.wins, 3);
  assert.equal(result.targetCount, 20);
  assert.equal(result.planningMode, 'sequential');
});

test('action consumes items and healing persists after the one-health battle cost', () => {
  const input = request(['north_carolina'], { special_restore_health: 1 });
  input.cards[0].health = 1;
  input.waves = [0, 1].map(() => ({ enemies: Array.from({ length: 4 }, () => ({ active: true, power: 160, weaknesses: [] })) }));
  const original = structuredClone(input);
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].groups[0].usedItems.special_restore_health, 1);
  assert.equal(result.waves[0].remainingCards[0].health, 2);
  assert.equal(result.waves[1].remainingInventory.special_restore_health, 0);
  assert.equal(result.waves[1].remainingCards[0].health, 1);
  assert.deepEqual(input, original);
});

test('action supports six waves of twenty enemies and validates limits before planning', () => {
  const input = request(['north_carolina']);
  const wave = count => ({ enemies: Array.from({ length: count }, () => ({ active: true, power: 1, weaknesses: [] })) });
  input.waves = Array.from({ length: 6 }, () => wave(20));
  const result = solveAction(input, catalog, items);
  assert.equal(result.targetCount, 120);
  assert.ok(result.waves.every(entry => entry.groups.length === 5));
  for (const waves of [[], Array.from({ length: 7 }, () => wave(4)), [wave(6)], [wave(24)]]) {
    assert.throws(() => solveAction({ ...input, waves }, catalog, items));
  }
  const invalid = wave(4); invalid.enemies[3].weaknesses = ['wrong'];
  assert.throws(() => solveAction({ ...input, waves: [wave(4), invalid] }, catalog, items));
});

test('action conserves units when they cannot win instead of spending their health', () => {
  const input = request(['north_carolina']);
  input.waves = [10000, 1].map(power => ({ enemies: Array.from({ length: 4 }, () => ({ active: true, power, weaknesses: [] })) }));
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].groups[0].formation.filter(Boolean).length, 0);
  assert.equal(result.waves[0].remainingCards[0].health, 3);
  assert.equal(result.waves[1].groups[0].wins, 1);
});

test('battle conditions belong to a specific wave and group, without action-wide leakage', () => {
  const input = request(['north_carolina']);
  const enemies = (power, count = 4) => Array.from({ length: count }, () => ({ active: true, power, weaknesses: [] }));
  input.global = { firepower: 1, survivability: 1, mobility: 1 };
  input.waves = [
    { enemies: [...enemies(1), ...enemies(160)], groupConditions: [{ global: { firepower: 1, survivability: 1, mobility: 1 } }, { global: {} }] },
    { enemies: enemies(140), groupConditions: [{ global: { firepower: 0.24 } }] },
  ];
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].groups[0].wins, 0);
  assert.equal(result.waves[0].groups[1].positions.find(position => position.cardId).ownPower, 180);
  assert.ok(Math.abs(result.waves[1].groups[0].positions.find(position => position.cardId).ownPower - 143.72) < 1e-8);
  assert.deepEqual(result.waves[0].groups[1].global, { firepower: 0, survivability: 0, mobility: 0 });
  assert.equal(result.waves[1].groups[0].global.firepower, 0.24);
});

test('ignore-conditions items are spent only for their group and group reductions are validated', () => {
  const input = request(['north_carolina'], { special_ignore_conditions: 1 });
  input.waves = [
    { enemies: input.enemies.map(enemy => ({ ...enemy, power: 170 })), groupConditions: [{ global: { firepower: 0.24, survivability: 0.24, mobility: 0.24 } }] },
    { enemies: input.enemies.map(enemy => ({ ...enemy, power: 160 })), groupConditions: [{ global: {} }] },
  ];
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].groups[0].usedItems.special_ignore_conditions, 1);
  assert.equal(result.waves[1].groups[0].wins, 1);
  assert.deepEqual(result.waves[1].groups[0].usedItems, {});
  input.waves[1].groupConditions[0].global.firepower = 1.01;
  assert.throws(() => solveAction(input, catalog, items), /第2波第1组/);
  input.waves[1].groupConditions = [];
  assert.throws(() => solveAction(input, catalog, items));
});

test('buff failure removes friendly card buffs while ordinary attribute items still work', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { standard_firepower: 1 });
  input.conditions = { buffsDisabled: true };
  const result = evaluate([unit('north_carolina', 'standard_firepower'), unit('helldiver_essex'), null, null], input);
  assert.equal(result.positions[0].ownPower, 196);
  assert.ok(result.positions[0].effects.every(effect => effect.kind !== 'buff'));
});

test('debuff failure also disables amplified and forced debuffs', () => {
  const input = request(['avenger_enterprise'], { special_debuff_amplifier: 1, special_force_debuff: 1 });
  input.conditions = { debuffsDisabled: true };
  input.enemies.forEach(enemy => { enemy.weaknesses = ['debuff_plane']; });
  for (const special of ['special_debuff_amplifier', 'special_force_debuff']) {
    const result = evaluate([null, unit('avenger_enterprise', null, special), null, null], input);
    assert.ok(result.positions.every(position => position.enemyPower === 200));
    assert.ok(result.positions.every(position => position.effects.every(effect => effect.kind !== 'debuff')));
  }
});

test('unit type limits accept multiple types and reject unknown, duplicate or empty lists', () => {
  const input = request(['north_carolina', 'helldiver_essex', 'baltimore']);
  input.enemies.forEach(enemy => { enemy.power = 1; });
  input.conditions = { allowedTypes: ['aircraft', 'battleship'] };
  const result = solve(input, catalog, items);
  assert.deepEqual(new Set(result.formation.filter(Boolean).map(unit => unit.cardId)), new Set(['north_carolina', 'helldiver_essex']));
  assert.throws(() => evaluate([unit('baltimore'), null, null, null], input), /舰种/);
  for (const allowedTypes of [[], ['unknown'], ['aircraft', 'aircraft'], 'aircraft']) {
    assert.throws(() => solve({ ...input, conditions: { allowedTypes } }, catalog, items));
  }
  assert.throws(() => solve({ ...input, conditions: { buffsDisabled: 'true' } }, catalog, items));
});

test('new conditions stay within their action group and blocked cards remain available for the next wave', () => {
  const input = request(['helldiver_essex']);
  input.enemies.forEach(enemy => { enemy.power = 1; });
  input.waves = [
    { enemies: input.enemies, groupConditions: [{ allowedTypes: ['cruiser'], buffsDisabled: true, debuffsDisabled: true }] },
    { enemies: input.enemies, groupConditions: [{}] },
  ];
  const result = solveAction(input, catalog, items);
  assert.equal(result.waves[0].wins, 0);
  assert.equal(result.waves[0].remainingCards[0].health, 3);
  assert.equal(result.waves[1].wins, 1);
  assert.equal(result.waves[1].groups[0].conditions.allowedTypes, null);
  assert.equal(result.waves[1].groups[0].conditions.buffsDisabled, false);
  assert.equal(result.waves[1].groups[0].conditions.debuffsDisabled, false);
});

test('ignore conditions on a receiver alone does not restore buffs; debuff and type exceptions remain pending', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { special_ignore_conditions: 1 });
  input.conditions = { buffsDisabled: true, debuffsDisabled: true };
  input.enemies.forEach(enemy => { enemy.weaknesses = ['debuff_plane']; });
  const result = evaluate([unit('north_carolina', null, 'special_ignore_conditions'), unit('helldiver_essex'), null, null], input);
  assert.equal(result.positions[0].ownPower, 180);
  assert.ok(result.positions.every(position => position.enemyPower === 200));
  const aircraftIgnored = evaluate([null, unit('helldiver_essex', null, 'special_ignore_conditions'), null, null], input);
  assert.ok(aircraftIgnored.positions.every(position => position.enemyPower === 200));
  input.conditions = { allowedTypes: ['cruiser'] };
  assert.throws(() => evaluate([unit('north_carolina', null, 'special_ignore_conditions'), null, null, null], input), /舰种/);
});

test('ignore conditions restores only the equipped source outgoing buffs, including amplification', () => {
  const input = request(['north_carolina', 'helldiver_essex', 'king_george_v'], { special_ignore_conditions: 1, standard_buff_amplifier: 1 });
  input.conditions = { buffsDisabled: true };
  const normal = evaluate([unit('north_carolina'), unit('helldiver_essex', null, 'special_ignore_conditions'), unit('king_george_v'), null], input);
  assert.equal(normal.positions[0].ownPower, 204);
  assert.equal(normal.positions[0].specialId, null);
  assert.equal(normal.positions[1].ownPower, 170);
  assert.equal(normal.positions[0].effects.find(effect => effect.kind === 'buff').sourceName, catalog.cards.find(card => card.id === 'helldiver_essex').name);
  const amplified = evaluate([unit('north_carolina'), unit('helldiver_essex', 'standard_buff_amplifier', 'special_ignore_conditions'), unit('king_george_v'), null], input);
  assert.equal(amplified.positions[0].ownPower, 228);
});

test('search considers ignore conditions for restoring ally buffs even with no attribute reductions', () => {
  const input = request(['north_carolina', 'helldiver_essex'], { special_ignore_conditions: 1 });
  input.conditions = { buffsDisabled: true };
  input.enemies = input.enemies.map((enemy, index) => ({ ...enemy, active: index === 0, power: 200 }));
  const result = solve(input, catalog, items);
  assert.equal(result.wins, 1);
  assert.equal(result.positions[0].cardId, 'north_carolina');
  assert.equal(result.positions[0].ownPower, 204);
  assert.equal(result.positions[1].specialId, 'special_ignore_conditions');
  assert.equal(result.usedItems.special_ignore_conditions, 1);
});
