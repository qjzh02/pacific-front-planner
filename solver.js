const STATS = ['firepower', 'survivability', 'mobility'];
const UNIT_TYPES = ['aircraft', 'battleship', 'cruiser', 'destroyer'];
const OFFSETS = { left: -1, right: 1, front_left: -1, front: 0, front_right: 1 };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function context(input, catalog, itemCatalog) {
  const cardById = new Map(catalog.cards.map(card => [card.id, card]));
  const effectById = new Map(catalog.effect_types.map(effect => [effect.id, effect]));
  const itemById = new Map(itemCatalog.items.filter(item => item.enabled).map(item => [item.id, item]));
  check(Array.isArray(input.enemies) && input.enemies.length === 4, '请填写四个敌军位置。');
  const enemies = input.enemies.map((enemy, index) => {
    check(typeof enemy.active === 'boolean', `敌军${index + 1}的启用状态无效。`);
    check(number(enemy.power, 0, 1000000), `敌军${index + 1}战力必须是有效的非负数。`);
    check(Array.isArray(enemy.weaknesses) && enemy.weaknesses.length <= 2, `敌军${index + 1}最多有两种弱点。`);
    check(new Set(enemy.weaknesses).size === enemy.weaknesses.length && enemy.weaknesses.every(id => effectById.get(id)?.kind === 'debuff'), '存在无效或重复的弱点。');
    return { ...enemy };
  });
  check(enemies.some(enemy => enemy.active), '请至少启用一个敌军位置。');
  check(Array.isArray(input.cards) && input.cards.length > 0 && input.cards.length <= cardById.size, '请勾选有效数量的卡牌（至少一张，不超过卡牌目录数量）。');
  const selected = new Map();
  input.cards.forEach((entry, index) => {
    check(cardById.has(entry.cardId) && !selected.has(entry.cardId), '存在未知或重复的卡牌。');
    check(Number.isInteger(entry.health) && entry.health >= 0 && entry.health <= 3, '生命值必须为0至3格。');
    selected.set(entry.cardId, { ...entry, index });
  });
  const inventory = {};
  itemCatalog.items.forEach(item => {
    const quantity = input.inventory?.[item.id] ?? 0;
    check(Number.isInteger(quantity) && quantity >= 0 && quantity <= 999, '道具数量必须为0至999的整数。');
    if (item.enabled) inventory[item.id] = quantity;
  });
  const global = Object.fromEntries(STATS.map(stat => {
    const reduction = input.global?.[stat] ?? 0;
    check(number(reduction, 0, 1), '全局减益必须在0%至100%之间。');
    return [stat, reduction];
  }));
  const conditions = { buffsDisabled: false, debuffsDisabled: false, buffsReduced: false, debuffsReduced: false, allowedTypes: null, ...input.conditions };
  check(['buffsDisabled', 'debuffsDisabled', 'buffsReduced', 'debuffsReduced'].every(key => typeof conditions[key] === 'boolean'), '增益、减益的失效和减少50%设置必须为开关。');
  check(conditions.allowedTypes === null || (Array.isArray(conditions.allowedTypes) && conditions.allowedTypes.length > 0 &&
    conditions.allowedTypes.every(type => UNIT_TYPES.includes(type)) && new Set(conditions.allowedTypes).size === conditions.allowedTypes.length), '限定舰种必须选择至少一个有效舰种，且不能重复。');
  const model = { stacking: 'additive', globalStacking: 'multiply', rounding: 'conservative', allowEqual: false, revive: false, ...input.model };
  check(['additive', 'multiply'].includes(model.stacking) && ['additive', 'multiply'].includes(model.globalStacking), '属性叠加设置无效。');
  check(['none', 'conservative'].includes(model.rounding) && typeof model.allowEqual === 'boolean' && typeof model.revive === 'boolean', '计算设置无效。');
  return { cardById, effectById, itemById, selected, inventory, global, conditions, model, enemies,
    itemIds: Object.keys(inventory) };
}

function variant(entry, position, ctx) {
  if (!entry) return null;
  const selected = ctx.selected.get(entry.cardId);
  check(selected, '阵容包含未勾选的卡牌。');
  const card = ctx.cardById.get(entry.cardId);
  const standard = entry.standardId ? ctx.itemById.get(entry.standardId) : null;
  const special = entry.specialId ? ctx.itemById.get(entry.specialId) : null;
  check(!entry.standardId || standard?.slot === 'standard', '灰色道具槽位无效。');
  check(!entry.specialId || special?.slot === 'special', '绿色道具槽位无效。');
  const standardParameters = standard?.parameters ?? {};
  const specialParameters = special?.parameters ?? {};
  check(!ctx.conditions.allowedTypes || ctx.conditions.allowedTypes.includes(card.unit_type), '该卡牌的舰种不符合本组限制。');
  check(selected.health > 0 || (ctx.model.revive && specialParameters.health_delta), '零生命卡牌不能出战；如游戏允许复活，请在设置中启用。');
  const health = Math.min(3, selected.health + (specialParameters.health_delta ?? 0));
  const left = [0, 0, 0], right = [0, 0, 0], debuffs = [1, 1, 1];
  const outgoing = [];
  for (const effect of card.effects) {
    const type = ctx.effectById.get(effect.type);
    const target = position + OFFSETS[effect.direction];
    if (target < 0 || target > 3) continue;
    if (type.kind === 'buff' && !specialParameters.disable_card_buffs && (!ctx.conditions.buffsDisabled || specialParameters.ignore_battle_conditions)) {
      const rate = (type.multiplier - 1) * (standardParameters.bonus_rate_multiplier ?? 1) *
        (ctx.conditions.buffsReduced && !specialParameters.ignore_battle_conditions ? 0.5 : 1);
      (effect.direction === 'left' ? left : right)[STATS.indexOf(type.target_stat)] += rate;
      outgoing.push({ kind: 'buff', target, name: type.target_stat, rate });
    }
    if (type.kind === 'debuff' && !specialParameters.disable_card_debuffs && !ctx.conditions.debuffsDisabled && ctx.enemies[target].active &&
        (specialParameters.bypass_weakness_match || ctx.enemies[target].weaknesses.includes(type.id))) {
      const multiplier = 1 - (1 - type.multiplier) * (specialParameters.reduction_rate_multiplier ?? 1) *
        (ctx.conditions.debuffsReduced && !specialParameters.ignore_battle_conditions ? 0.5 : 1);
      debuffs[target - position + 1] *= multiplier;
      outgoing.push({ kind: 'debuff', target, name: type.weakness_name, multiplier });
    }
  }
  const usage = ctx.itemIds.map(id => Number(id === entry.standardId || id === entry.specialId));
  return { card, index: selected.index, health, originalHealth: selected.health, standardId: entry.standardId ?? null,
    specialId: entry.specialId ?? null, standardParameters, specialParameters, left, right, debuffs, outgoing, usage,
    cost: usage.reduce((sum, used) => sum + used, 0) };
}

function positionResult(position, left, current, right, ctx, explain = false) {
  const enemy = ctx.enemies[position];
  let stats = null, ownRaw = 0;
  if (current) {
    stats = {};
    const healthFactor = [0, 0.8, 0.9, 1][current.health];
    STATS.forEach((stat, index) => {
      const standardRate = current.standardParameters.stat === stat ? current.standardParameters.stat_multiplier - 1 : 0;
      const totalRate = (current.specialParameters.total_stat_multiplier ?? 1) - 1;
      const leftRate = left?.right[index] ?? 0;
      const rightRate = right?.left[index] ?? 0;
      const positive = ctx.model.stacking === 'additive' ? 1 + standardRate + totalRate + leftRate + rightRate :
        (1 + standardRate) * (1 + totalRate) * (1 + leftRate) * (1 + rightRate);
      const reduction = current.specialParameters.ignore_battle_conditions ? 0 : ctx.global[stat];
      const multiplier = ctx.model.globalStacking === 'multiply' ? positive * (1 - reduction) : Math.max(0, positive - reduction);
      stats[stat] = current.card[stat] * healthFactor * multiplier;
    });
    ownRaw = Math.max(0, STATS.reduce((sum, stat) => sum + stats[stat], 0) - 10);
  }
  const enemyRaw = enemy.power * (left?.debuffs[2] ?? 1) * (current?.debuffs[1] ?? 1) * (right?.debuffs[0] ?? 1);
  const ownPower = ctx.model.rounding === 'conservative' ? Math.floor(ownRaw + 1e-8) : ownRaw;
  const enemyPower = ctx.model.rounding === 'conservative' ? Math.ceil(enemyRaw - 1e-8) : enemyRaw;
  const margin = current && enemy.active ? ownPower - enemyPower : -enemyPower;
  const win = Boolean(current && enemy.active && (ctx.model.allowEqual ? margin >= -1e-8 : margin > 1e-8));
  const result = { position, active: enemy.active, ownPower, enemyPower, ownRaw, enemyRaw, stats, margin, win,
    cardId: current?.card.id ?? null, name: current?.card.name ?? null, health: current?.health ?? null,
    originalHealth: current?.originalHealth ?? null, standardId: current?.standardId ?? null, specialId: current?.specialId ?? null };
  if (explain) result.effects = [left, current, right].flatMap(source => source?.outgoing
    .filter(effect => effect.target === position && (effect.kind === 'debuff' || source !== current))
    .map(effect => ({ ...effect, sourceName: source.card.name })) ?? []);
  return result;
}

function summarize(lineup, ctx) {
  const positions = Array.from({ length: 4 }, (_, position) => positionResult(position, lineup[position - 1], lineup[position], lineup[position + 1], ctx, true));
  const usedItems = {};
  lineup.filter(Boolean).forEach(unit => [unit.standardId, unit.specialId].filter(Boolean).forEach(id => { usedItems[id] = (usedItems[id] ?? 0) + 1; }));
  return { positions, wins: positions.filter(position => position.win).length,
    targetCount: ctx.enemies.filter(enemy => enemy.active).length,
    usedItems, itemCount: Object.values(usedItems).reduce((sum, quantity) => sum + quantity, 0),
    formation: lineup.map(unit => unit ? { cardId: unit.card.id, standardId: unit.standardId, specialId: unit.specialId } : null),
    model: ctx.model, global: { ...ctx.global }, conditions: { ...ctx.conditions } };
}

export function evaluateFormation(formation, input, catalog, itemCatalog) {
  const ctx = context(input, catalog, itemCatalog);
  check(Array.isArray(formation) && formation.length === 4, '阵容必须有四个位置。');
  const ids = formation.filter(Boolean).map(entry => entry.cardId);
  check(new Set(ids).size === ids.length, '同一张卡牌不能重复出战。');
  const lineup = formation.map((entry, index) => variant(entry, index, ctx));
  const result = summarize(lineup, ctx);
  Object.entries(result.usedItems).forEach(([id, used]) => check(used <= ctx.inventory[id], '道具使用数量超过库存。'));
  return result;
}

function candidates(position, ctx) {
  const list = [];
  const standards = [null, ...[...ctx.itemById.values()].filter(item => item.slot === 'standard' && ctx.inventory[item.id] > 0)];
  const specials = [null, ...[...ctx.itemById.values()].filter(item => item.slot === 'special' && ctx.inventory[item.id] > 0)];
  for (const selected of ctx.selected.values()) {
    const card = ctx.cardById.get(selected.cardId);
    if (ctx.conditions.allowedTypes && !ctx.conditions.allowedTypes.includes(card.unit_type)) continue;
    for (const standard of standards) for (const special of specials) {
      const sp = special?.parameters ?? {}, st = standard?.parameters ?? {};
      if (selected.health === 0 && !(ctx.model.revive && sp.health_delta)) continue;
      if (sp.health_delta && selected.health === 3) continue;
      const ignoresStatPenalty = STATS.some(stat => ctx.global[stat] > 0);
      const restoresBuffs = ctx.conditions.buffsDisabled || ctx.conditions.buffsReduced;
      const restoresDebuffs = ctx.conditions.debuffsReduced && !ctx.conditions.debuffsDisabled;
      if (sp.ignore_battle_conditions && !ignoresStatPenalty && !restoresBuffs && !restoresDebuffs) continue;
      if (st.bonus_rate_multiplier && (sp.disable_card_buffs || !card.effects.some(effect => ctx.effectById.get(effect.type).kind === 'buff'))) continue;
      if ((sp.reduction_rate_multiplier || sp.bypass_weakness_match) && !card.effects.some(effect => ctx.effectById.get(effect.type).kind === 'debuff')) continue;
      const candidate = variant({ cardId: card.id, standardId: standard?.id, specialId: special?.id }, position, ctx);
      if (sp.ignore_battle_conditions && !ignoresStatPenalty && !candidate.outgoing.some(effect =>
        (effect.kind === 'buff' && restoresBuffs) || (effect.kind === 'debuff' && restoresDebuffs))) continue;
      if (st.bonus_rate_multiplier && !candidate.outgoing.some(effect => effect.kind === 'buff')) continue;
      if (sp.reduction_rate_multiplier && !candidate.outgoing.some(effect => effect.kind === 'debuff')) continue;
      if (sp.bypass_weakness_match && !candidate.outgoing.some(effect => effect.kind === 'debuff' &&
          !ctx.enemies[effect.target].weaknesses.includes(card.effects.find(entry => ctx.effectById.get(entry.type).weakness_name === effect.name)?.type))) continue;
      list.push(candidate);
    }
  }
  return list.sort((a, b) => a.card.power_min - b.card.power_min || Number(Boolean(a.specialId)) - Number(Boolean(b.specialId)) || a.cost - b.cost);
}

// Positive means a is better; save green items before gray items, then stronger cards.
function compare(a, b) {
  for (let index = 0; index < a.rank.length; index++) {
    if (Math.abs(a.rank[index] - b.rank[index]) > 1e-8) return a.rank[index] - b.rank[index];
  }
  return 0;
}

class BestHeap {
  constructor(limit) { this.limit = limit; this.values = []; }
  add(value) {
    const heap = this.values;
    if (heap.length < this.limit) {
      heap.push(value);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (compare(heap[index], heap[parent]) >= 0) break;
        [heap[index], heap[parent]] = [heap[parent], heap[index]]; index = parent;
      }
    } else if (compare(value, heap[0]) > 0) {
      heap[0] = value;
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
        if (compare(heap[index], heap[child]) <= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]]; index = child;
      }
    }
  }
}

export function solve(input, catalog, itemCatalog, options = {}) {
  const ctx = context(input, catalog, itemCatalog);
  const choices = Array.from({ length: 4 }, (_, position) => candidates(position, ctx));
  const usable = new Set(choices.flat().map(unit => unit.card.id));
  check(usable.size > 0 || options.allowEmpty, '没有可出战的卡牌，请检查生命值及回血道具。');
  const requiredUnits = options.allowEmpty ? 0 : Math.min(4, usable.size);
  if (requiredUnits < 4) choices.forEach(list => list.push(null));
  const bound = choices.reduce((product, list) => product * list.length, 1);
  const exact = bound <= (options.exactLimit ?? 2000000);
  const limit = Math.max(30, Math.min(3000, options.beamWidth ?? 900));
  const stock = ctx.itemIds.map(id => ctx.inventory[id]);
  const optimistic = choices.map(list => ({
    left: STATS.map((_, index) => Math.max(0, ...list.map(unit => unit?.left[index] ?? 0))),
    debuffs: [Math.min(1, ...list.map(unit => unit?.debuffs[0] ?? 1)), 1, 1],
  }));
  let best = null, explored = 0;
  const initial = { lineup: [], counts: stock.map(() => 0), mask: 0, wins: 0, cost: 0, specialCount: 0, units: 0, strength: 0, margins: [] };
  function extend(state, unit, depth) {
    explored++;
    if (unit && (state.mask & (1 << unit.index))) return null;
    const units = state.units + Number(Boolean(unit));
    if (units + 3 - depth < requiredUnits) return null;
    const counts = unit ? state.counts.map((count, index) => count + unit.usage[index]) : state.counts;
    if (counts.some((count, index) => count > stock[index])) return null;
    const lineup = [...state.lineup, unit];
    let wins = state.wins, margins = state.margins;
    if (depth > 0) {
      const finished = positionResult(depth - 1, lineup[depth - 2], lineup[depth - 1], unit, ctx);
      wins += Number(finished.win);
      if (finished.active) margins = [...margins, finished.margin];
    }
    const pending = positionResult(depth, lineup[depth - 1], unit, depth === 3 ? null : optimistic[depth + 1], ctx);
    if (depth === 3) {
      wins += Number(pending.win);
      if (pending.active) margins = [...margins, pending.margin];
    }
    const projectedMargins = depth === 3 ? margins : [...margins, ...(pending.active ? [pending.margin] : [])];
    const cost = state.cost + (unit?.cost ?? 0);
    const specialCount = state.specialCount + Number(Boolean(unit?.specialId));
    const strength = state.strength + (unit?.card.power_min ?? 0);
    const possibleWins = depth === 3 ? wins : wins + Number(pending.win) + ctx.enemies.slice(depth + 1).filter(enemy => enemy.active).length;
    const conservation = options.allowEmpty ? [-units] : [];
    const rank = depth === 3 ? [wins, -specialCount, -cost, ...conservation, -strength, Math.min(...margins), margins.reduce((sum, margin) => sum + margin, 0)] :
      [possibleWins, wins, -specialCount, -cost, ...conservation, -strength, Math.min(...projectedMargins), projectedMargins.reduce((sum, margin) => sum + margin, 0)];
    return { lineup, counts, mask: state.mask | (unit ? 1 << unit.index : 0), wins, cost, specialCount, units, strength, margins, rank };
  }
  if (exact) {
    function visit(state, depth) {
      for (const unit of choices[depth]) {
        const next = extend(state, unit, depth);
        if (!next) continue;
        if (depth === 3) { if (!best || compare(next, best) > 0) best = next; }
        else if (!best || next.wins + ctx.enemies.slice(depth).filter(enemy => enemy.active).length >= best.wins) visit(next, depth + 1);
      }
    }
    visit(initial, 0);
  } else {
    let beam = [initial];
    // Keep a separate quota for each last card so support cards survive pruning.
    const perCard = Math.ceil(limit / (usable.size + Number(requiredUnits < 4)));
    for (let depth = 0; depth < 4; depth++) {
      const heaps = new Map();
      for (const state of beam) for (const unit of choices[depth]) {
        const next = extend(state, unit, depth);
        if (!next) continue;
        if (depth === 3) { if (!best || compare(next, best) > 0) best = next; continue; }
        const key = unit?.card.id ?? 'empty';
        if (!heaps.has(key)) heaps.set(key, new BestHeap(perCard));
        heaps.get(key).add(next);
      }
      if (depth < 3) beam = [...heaps.values()].flatMap(heap => heap.values).sort((a, b) => compare(b, a)).slice(0, limit);
      options.onProgress?.({ stage: depth + 1, explored });
    }
  }
  check(best, '库存与可用单位无法组成阵容，请检查输入。');
  return { ...summarize(best.lineup, ctx), searchMode: exact ? 'exact' : 'bounded', explored,
    beamWidth: exact ? null : limit, combinationUpperBound: bound };
}

export function solveAction(input, catalog, itemCatalog, options = {}) {
  check(Array.isArray(input.waves) && input.waves.length >= 1 && input.waves.length <= 6, '每次行动必须有1至6波敌人。');
  // Validate the entire action before spending any simulated resources.
  const waveGroups = input.waves.map((wave, waveIndex) => {
    check(Array.isArray(wave.enemies) && [4, 8, 12, 16, 20].includes(wave.enemies.length), `第${waveIndex + 1}波敌军数量必须是4、8、12、16或20。`);
    check(wave.groupConditions === undefined || (Array.isArray(wave.groupConditions) && wave.groupConditions.length === wave.enemies.length / 4), `第${waveIndex + 1}波的战场条件必须与组数对应。`);
    return Array.from({ length: wave.enemies.length / 4 }, (_, groupIndex) => {
      const enemies = wave.enemies.slice(groupIndex * 4, groupIndex * 4 + 4);
      const conditions = wave.groupConditions?.[groupIndex] ?? {};
      const global = conditions.global ?? {};
      try { context({ ...input, enemies, global, conditions }, catalog, itemCatalog); }
      catch (error) { throw new Error(`第${waveIndex + 1}波第${groupIndex + 1}组：${error.message}`); }
      return { enemies, global, conditions };
    });
  });
  const totalGroups = waveGroups.reduce((sum, groups) => sum + groups.length, 0);
  let workExplored = 0;
  function plan(prefix = [], attempt = 0) {
    const cards = input.cards.map(card => ({ ...card }));
    const inventory = Object.fromEntries(itemCatalog.items.map(item => [item.id, input.inventory?.[item.id] ?? 0]));
    let wins = 0, targetCount = 0, itemCount = 0, explored = 0, completedGroups = 0;
    const usedItems = {}, waves = [], earlyHealing = [];
    waveGroups.forEach((groups, waveIndex) => {
      const deployed = new Set();
      const results = groups.map(({ enemies, global, conditions }, groupIndex) => {
        const available = cards.filter(card => !deployed.has(card.cardId));
        const groupInput = { ...input, enemies, global, conditions, cards: available, inventory };
        const progressContext = { wave: waveIndex + 1, group: groupIndex + 1, completedGroups, totalGroups, phase: attempt ? 'healing' : 'initial', attempt };
        let result;
        if (prefix[completedGroups]) {
          result = { ...prefix[completedGroups], ...evaluateFormation(prefix[completedGroups].formation,
            available.length ? groupInput : { ...groupInput, cards }, catalog, itemCatalog), replayed: true, explored: 0 };
        } else if (available.length) {
          result = solve(groupInput, catalog, itemCatalog, { ...options, allowEmpty: true,
            onProgress: progress => options.onProgress?.({ ...progress, ...progressContext }) });
          workExplored += result.explored;
        } else {
          result = { ...evaluateFormation([null, null, null, null], { ...groupInput, cards }, catalog, itemCatalog), searchMode: 'exact', explored: 0 };
        }
        result.positions.forEach(position => {
          if (!position.cardId) return;
          deployed.add(position.cardId);
          const card = cards.find(entry => entry.cardId === position.cardId);
          card.health = Math.max(0, position.health - 1);
          position.healthAfter = card.health;
          if (result.earlyHealingPositions?.includes(position.position)) {
            position.earlyHealing = true;
            earlyHealing.push({ wave: waveIndex + 1, group: groupIndex + 1, position: position.position, cardId: position.cardId });
          }
        });
        Object.entries(result.usedItems).forEach(([id, count]) => { inventory[id] -= count; usedItems[id] = (usedItems[id] ?? 0) + count; });
        wins += result.wins; targetCount += result.targetCount; itemCount += result.itemCount; explored += result.explored;
        completedGroups++;
        options.onProgress?.({ ...progressContext, stage: 4, explored, completedGroups });
        return { ...result, group: groupIndex + 1 };
      });
      waves.push({ wave: waveIndex + 1, groups: results, wins: results.reduce((sum, group) => sum + group.wins, 0),
        targetCount: results.reduce((sum, group) => sum + group.targetCount, 0),
        remainingCards: cards.map(card => ({ ...card })), remainingInventory: { ...inventory } });
    });
    return { waves, wins, targetCount, itemCount, usedItems, explored, earlyHealing,
      planningMode: earlyHealing.length ? 'sequential-healing' : 'sequential', model: waves[0].groups[0].model,
      remainingCards: cards.map(card => ({ ...card })), remainingInventory: { ...inventory } };
  }
  let best = plan(), attempts = 0;
  const healingItem = itemCatalog.items.find(item => item.enabled && item.parameters.health_delta);
  const power = new Map(catalog.cards.map(card => [card.id, card.power_min]));
  // shortcut: only retry up to 12 earlier healing choices; broader resource backtracking needs action-level search.
  while (healingItem && attempts < 12 && best.wins < best.targetCount) {
    const failedWave = best.waves.findLastIndex(wave => wave.wins < wave.targetCount);
    if (failedWave < 1) break;
    const lowHealth = new Set(best.waves[failedWave - 1].remainingCards.filter(card => card.health <= 1).map(card => card.cardId));
    const flat = best.waves.flatMap(wave => wave.groups);
    const candidates = [];
    let groupOffset = 0, healingStock = input.inventory?.[healingItem.id] ?? 0;
    best.waves.forEach((wave, waveIndex) => wave.groups.forEach(group => {
      if (waveIndex < failedWave && healingStock > 0) group.positions.forEach(position => {
        if (lowHealth.has(position.cardId) && position.originalHealth > 0 && position.originalHealth < 3 && !position.specialId)
          candidates.push({ index: groupOffset, waveIndex, position: position.position, cardId: position.cardId });
      });
      healingStock -= group.usedItems[healingItem.id] ?? 0;
      groupOffset++;
    }));
    candidates.sort((a, b) => b.waveIndex - a.waveIndex || power.get(b.cardId) - power.get(a.cardId) || b.index - a.index);
    let improved = false;
    for (const candidate of candidates) {
      if (attempts >= 12) break;
      const prefix = flat.slice(0, candidate.index + 1).map(group => ({ ...group, formation: group.formation.map(unit => unit ? { ...unit } : null) }));
      const group = prefix[candidate.index];
      group.formation[candidate.position].specialId = healingItem.id;
      group.earlyHealingPositions = [...(group.earlyHealingPositions ?? []), candidate.position];
      const alternative = plan(prefix, ++attempts);
      if (alternative.wins > best.wins) { best = alternative; improved = true; break; }
    }
    if (!improved) break;
  }
  return { ...best, explored: workExplored, healingRetries: attempts };
}
