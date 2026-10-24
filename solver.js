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
    const source = input.conditions?.captureSource;
    check(!source?.enemyPowerIncreases || enemy.powerIncrease !== undefined,
      '本组旧采集数据缺少每个敌军的区域增益，请重新采集后计算。');
    const powerIncrease = enemy.powerIncrease ?? source?.enemyPowerIncrease ?? 0;
    check(number(powerIncrease, 0, Number.MAX_VALUE), `敌军${index + 1}区域战力增益必须是有效的非负数。`);
    const basePower = powerIncrease ? Math.round(enemy.power / (1 + powerIncrease)) : enemy.power;
    check(!powerIncrease || (Number.isInteger(enemy.power) && Math.round(basePower * (1 + powerIncrease)) === enemy.power),
      `敌军${index + 1}显示战力无法还原整数原战力，请核对输入或重新采集。`);
    return { ...enemy, powerIncrease, basePower };
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
  const conditions = { buffsDisabled: false, debuffsDisabled: false, buffsReduced: false, debuffsReduced: false, itemsDisabled: false, allowedTypes: null, ...input.conditions };
  check(['buffsDisabled', 'debuffsDisabled', 'buffsReduced', 'debuffsReduced', 'itemsDisabled'].every(key => typeof conditions[key] === 'boolean'), '战场条件的失效、削弱和禁用道具设置必须为开关。');
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
  check(!ctx.conditions.itemsDisabled || (!entry.standardId && !entry.specialId), '本组禁用道具，不能装备灰色或绿色道具。');
  const standardParameters = standard?.parameters ?? {};
  const specialParameters = special?.parameters ?? {};
  check(!ctx.conditions.allowedTypes || ctx.conditions.allowedTypes.includes(card.unit_type), '该卡牌的舰种不符合本组限制。');
  check(selected.health > 0 || (ctx.model.revive && specialParameters.health_delta), '零生命卡牌不能出战；如游戏允许复活，请在设置中启用。');
  const health = Math.min(3, selected.health + (specialParameters.health_delta ?? 0));
  const left = [0, 0, 0], right = [0, 0, 0], debuffs = [0, 0, 0];
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
      debuffs[target - position + 1] += 1 - multiplier;
      outgoing.push({ kind: 'debuff', target, name: type.weakness_name, multiplier });
    }
  }
  const usage = ctx.itemIds.map(id => Number(id === entry.standardId || id === entry.specialId));
  const healthFactor = [0, 0.8, 0.9, 1][health];
  const baseStats = STATS.map(stat => card[stat] * healthFactor);
  const positiveBase = STATS.map(stat => {
    const standardRate = standardParameters.stat === stat ? standardParameters.stat_multiplier - 1 : 0;
    const totalRate = (specialParameters.total_stat_multiplier ?? 1) - 1;
    return ctx.model.stacking === 'additive' ? 1 + standardRate + totalRate : (1 + standardRate) * (1 + totalRate);
  });
  const reductions = STATS.map(stat => specialParameters.ignore_battle_conditions ? 0 : ctx.global[stat]);
  return { card, index: selected.index, health, originalHealth: selected.health, standardId: entry.standardId ?? null,
    specialId: entry.specialId ?? null, baseStats, positiveBase, reductions, left, right, debuffs, outgoing, usage,
    cost: usage.reduce((sum, used) => sum + used, 0) };
}

function positionResult(position, left, current, right, ctx, explain = false, score = {}) {
  const enemy = ctx.enemies[position];
  let stats = null, ownRaw = 0;
  if (current) {
    if (explain) stats = {};
    for (let index = 0; index < STATS.length; index++) {
      const leftRate = left?.right[index] ?? 0;
      const rightRate = right?.left[index] ?? 0;
      const positive = ctx.model.stacking === 'additive' ? current.positiveBase[index] + leftRate + rightRate :
        current.positiveBase[index] * (1 + leftRate) * (1 + rightRate);
      const reduction = current.reductions[index];
      const multiplier = ctx.model.globalStacking === 'multiply' ? positive * (1 - reduction) : Math.max(0, positive - reduction);
      const value = current.baseStats[index] * multiplier;
      ownRaw += value;
      if (explain) stats[STATS[index]] = value;
    }
    ownRaw = Math.max(0, ownRaw - 10);
  }
  const debuffMultiplier = 1 - ((left?.debuffs[2] ?? 0) + (current?.debuffs[1] ?? 0) + (right?.debuffs[0] ?? 0));
  const increased = enemy.powerIncrease > 0 && debuffMultiplier < 1;
  // 增益和各来源减益均按原战力加算；只保留已实测组合的四舍五入，其余沿用所选取整设置。
  const calibrated = increased && Math.abs(enemy.powerIncrease - 0.16) < 1e-8 && Math.abs(debuffMultiplier - 0.8) < 1e-8;
  const enemyRaw = increased ? enemy.basePower * (debuffMultiplier + enemy.powerIncrease) : enemy.power * debuffMultiplier;
  const ownPower = ctx.model.rounding === 'conservative' ? Math.floor(ownRaw + 1e-8) : ownRaw;
  const enemyPower = calibrated ? Math.round(enemyRaw) : ctx.model.rounding === 'conservative' ? Math.ceil(enemyRaw - 1e-8) : enemyRaw;
  const margin = current && enemy.active ? ownPower - enemyPower : -enemyPower;
  const win = Boolean(current && enemy.active && (ctx.model.allowEqual ? margin >= -1e-8 : margin > 1e-8));
  // 搜索复用这个小对象；仅最终阵容需要属性、名称和效果说明。
  if (!explain) {
    score.active = enemy.active; score.margin = margin; score.win = win;
    return score;
  }
  const result = { position, active: enemy.active, ownPower, enemyPower, ownRaw, enemyRaw, stats, margin, win,
    enemyBasePower: enemy.basePower, enemyPowerIncrease: enemy.powerIncrease, enemyPowerRoundingAssumed: increased && !calibrated,
    cardId: current?.card.id ?? null, name: current?.card.name ?? null, health: current?.health ?? null,
    originalHealth: current?.originalHealth ?? null, standardId: current?.standardId ?? null, specialId: current?.specialId ?? null };
  result.effects = [left, current, right].flatMap(source => source?.outgoing
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
  const standards = [null, ...[...ctx.itemById.values()].filter(item => !ctx.conditions.itemsDisabled && item.slot === 'standard' && ctx.inventory[item.id] > 0)];
  const specials = [null, ...[...ctx.itemById.values()].filter(item => !ctx.conditions.itemsDisabled && item.slot === 'special' && ctx.inventory[item.id] > 0)];
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

function* search(input, catalog, itemCatalog, options = {}) {
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
    debuffs: [Math.max(0, ...list.map(unit => unit?.debuffs[0] ?? 0)), 0, 0],
  }));
  const activeSuffix = Array(5).fill(0);
  for (let position = 3; position >= 0; position--) activeSuffix[position] = activeSuffix[position + 1] + Number(ctx.enemies[position].active);
  const score = {};
  let best = null, explored = 0, accounted = 0, interrupted = false;
  const initial = { lineup: [], counts: stock.map(() => 0), mask: 0, wins: 0, cost: 0, specialCount: 0, units: 0, strength: 0, minMargin: Infinity, totalMargin: 0 };
  let frontier = initial;
  const account = () => {
    if (options.control) options.control.explored += explored - accounted;
    accounted = explored;
  };
  function extend(state, unit, depth) {
    explored++;
    if (unit && (state.mask & (1 << unit.index))) return null;
    const units = state.units + Number(Boolean(unit));
    if (units + 3 - depth < requiredUnits) return null;
    const counts = unit ? new Array(stock.length) : state.counts;
    if (unit) for (let index = 0; index < stock.length; index++) {
      counts[index] = state.counts[index] + unit.usage[index];
      if (counts[index] > stock[index]) return null;
    }
    const lineup = [...state.lineup, unit];
    let wins = state.wins, minMargin = state.minMargin, totalMargin = state.totalMargin;
    if (depth > 0) {
      const finished = positionResult(depth - 1, lineup[depth - 2], lineup[depth - 1], unit, ctx, false, score);
      wins += Number(finished.win);
      if (finished.active) { minMargin = Math.min(minMargin, finished.margin); totalMargin += finished.margin; }
    }
    const pending = positionResult(depth, lineup[depth - 1], unit, depth === 3 ? null : optimistic[depth + 1], ctx, false, score);
    if (depth === 3) {
      wins += Number(pending.win);
      if (pending.active) { minMargin = Math.min(minMargin, pending.margin); totalMargin += pending.margin; }
    }
    const projectedMin = depth < 3 && pending.active ? Math.min(minMargin, pending.margin) : minMargin;
    const projectedTotal = depth < 3 && pending.active ? totalMargin + pending.margin : totalMargin;
    const cost = state.cost + (unit?.cost ?? 0);
    const specialCount = state.specialCount + Number(Boolean(unit?.specialId));
    const strength = state.strength + (unit?.card.power_min ?? 0);
    const possibleWins = depth === 3 ? wins : wins + Number(pending.win) + activeSuffix[depth + 1];
    const rank = depth === 3 ? [wins, -specialCount, -cost] : [possibleWins, wins, -specialCount, -cost];
    if (options.allowEmpty) rank.push(-units);
    rank.push(-strength, projectedMin, projectedTotal);
    return { lineup, counts, mask: state.mask | (unit ? 1 << unit.index : 0), wins, cost, specialCount, units, strength, minMargin, totalMargin, rank };
  }
  if (exact) {
    const states = [initial], indices = [0, 0, 0, 0];
    let depth = 0;
    while (depth >= 0) {
      if (indices[depth] >= choices[depth].length) { depth--; continue; }
      const next = extend(states[depth], choices[depth][indices[depth]++], depth);
      if (next) {
        if (!best) frontier = next;
        if (depth === 3) { if (!best || compare(next, best) > 0) best = next; }
        else if (!best || next.wins + activeSuffix[depth] >= best.wins) {
          states[++depth] = next; indices[depth] = 0;
        }
      }
      if ((explored & 1023) === 0) {
        account(); yield;
        if (options.control?.stopped) { interrupted = true; break; }
      }
    }
  } else {
    let beam = [initial];
    // Keep a separate quota for each last card so support cards survive pruning.
    const perCard = Math.ceil(limit / (usable.size + Number(requiredUnits < 4)));
    depths: for (let depth = 0; depth < 4; depth++) {
      const heaps = new Map();
      for (const state of beam) for (const unit of choices[depth]) {
        const next = extend(state, unit, depth);
        if (next) {
          if (!best) frontier = next;
          if (depth === 3) { if (!best || compare(next, best) > 0) best = next; }
          else {
            const key = unit?.card.id ?? 'empty';
            if (!heaps.has(key)) heaps.set(key, new BestHeap(perCard));
            heaps.get(key).add(next);
          }
        }
        if ((explored & 1023) === 0) {
          account(); yield;
          if (options.control?.stopped) { interrupted = true; break depths; }
        }
      }
      if (depth < 3) beam = [...heaps.values()].flatMap(heap => heap.values).sort((a, b) => compare(b, a)).slice(0, limit);
      options.onProgress?.({ stage: depth + 1, explored });
    }
  }
  account(); yield;
  if (interrupted && !best && options.allowEmpty) {
    const complete = state => {
      while (state.lineup.length < 4) state = extend(state, null, state.lineup.length);
      return state;
    };
    // 尚未走到完整阵容时，也要与已知可行的空阵比较，避免零胜场白耗生命或道具。
    const partial = complete(frontier), empty = complete(initial);
    best = compare(partial, empty) > 0 ? partial : empty;
    account();
  }
  check(best || interrupted, '库存与可用单位无法组成阵容，请检查输入。');
  const lineup = best?.lineup ?? [...frontier.lineup, ...Array(4 - frontier.lineup.length).fill(null)];
  return { ...summarize(lineup, ctx), searchMode: exact ? 'exact' : 'bounded', explored,
    ...(interrupted ? { searchIncomplete: true } : {}),
    beamWidth: exact ? null : limit, combinationUpperBound: bound };
}

export function solve(input, catalog, itemCatalog, options = {}) {
  const steps = search(input, catalog, itemCatalog, options);
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

function budget(options) {
  const maxTimeMs = options.maxTimeMs ?? Infinity, maxBranches = options.maxBranches ?? Infinity;
  check(typeof maxTimeMs === 'number' && maxTimeMs > 0 && typeof maxBranches === 'number' && maxBranches > 0 &&
    (maxBranches === Infinity || Number.isInteger(maxBranches)), '计算预算必须为正数或不限。');
  return { maxTimeMs, maxBranches, elapsedMs: 0, explored: 0, stopped: false };
}

function advance(steps, control) {
  const start = performance.now(), step = steps.next();
  control.elapsedMs += performance.now() - start;
  if (control.elapsedMs >= control.maxTimeMs || control.explored >= control.maxBranches) control.stopped = true;
  return step;
}

export function solveAction(input, catalog, itemCatalog, options = {}) {
  const control = budget(options), steps = actionSteps(input, catalog, itemCatalog, options, control);
  let step;
  do { step = advance(steps, control); } while (!step.done);
  return { ...step.value, searchLimited: control.stopped, searchElapsedMs: control.elapsedMs };
}

export async function solveActionAsync(input, catalog, itemCatalog, options = {}) {
  const control = budget(options), steps = actionSteps(input, catalog, itemCatalog, options, control);
  const schedule = options.schedule ?? (() => new Promise(resolve => setTimeout(resolve, 16)));
  const timeSliceMs = options.timeSliceMs ?? 12;
  let sliceStart = performance.now(), lastNotice = -Infinity;
  while (true) {
    const step = advance(steps, control);
    if (step.done || performance.now() - lastNotice >= 200) {
      options.onBudget?.({ elapsedMs: control.elapsedMs, explored: control.explored });
      lastNotice = performance.now();
    }
    if (step.done) return { ...step.value, searchLimited: control.stopped, searchElapsedMs: control.elapsedMs };
    if (performance.now() - sliceStart >= timeSliceMs) { await schedule(); sliceStart = performance.now(); }
  }
}

function* actionSteps(input, catalog, itemCatalog, options, control) {
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
  // 仅在本次行动复用完整输入相同的搜索；缓存快照不参与生命、库存和提前回血的修改。
  const searchCache = new Map();
  let workExplored = 0, searchCacheHits = 0;
  function* plan(prefix = [], attempt = 0, priority = null) {
    const cards = input.cards.map(card => ({ ...card }));
    const inventory = Object.fromEntries(itemCatalog.items.map(item => [item.id, input.inventory?.[item.id] ?? 0]));
    let wins = 0, targetCount = 0, itemCount = 0, explored = 0, completedGroups = 0;
    const usedItems = {}, waves = [], earlyHealing = [];
    for (let waveIndex = 0; waveIndex < waveGroups.length; waveIndex++) {
      const groups = waveGroups[waveIndex];
      const deployed = new Set();
      const order = groups.map((_, i) => i);
      if (priority?.waveIndex === waveIndex) order.unshift(...order.splice(order.indexOf(priority.groupIndex), 1));
      const results = [];
      for (const groupIndex of order) {
        const { enemies, global, conditions } = groups[groupIndex];
        const available = cards.filter(card => !deployed.has(card.cardId));
        const groupInput = { ...input, enemies, global, conditions, cards: available, inventory };
        const progressContext = { wave: waveIndex + 1, group: groupIndex + 1, completedGroups, totalGroups,
          phase: priority ? 'repair' : attempt ? 'healing' : 'initial', attempt: priority?.attempt ?? attempt };
        let result;
        if (prefix[completedGroups]) {
          result = { ...prefix[completedGroups], ...evaluateFormation(prefix[completedGroups].formation,
            available.length ? groupInput : { ...groupInput, cards }, catalog, itemCatalog), replayed: true, explored: 0 };
        } else if (control.stopped) {
          result = { ...evaluateFormation([null, null, null, null], available.length ? groupInput : { ...groupInput, cards }, catalog, itemCatalog),
            searchMode: 'unsearched', searchIncomplete: true, explored: 0 };
        } else if (available.length) {
          const key = JSON.stringify([enemies, global, conditions, available, inventory, input.model, options.beamWidth, options.exactLimit]);
          const cached = searchCache.get(key);
          if (cached) {
            result = { ...structuredClone(cached), explored: 0, searchReused: true };
            searchCacheHits++;
          } else {
            result = yield* search(groupInput, catalog, itemCatalog, { ...options, control, allowEmpty: true,
              onProgress: progress => options.onProgress?.({ ...progress, ...progressContext }) });
            workExplored += result.explored;
            if (!result.searchIncomplete) searchCache.set(key, structuredClone(result));
          }
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
        results.push({ ...result, group: groupIndex + 1 });
        yield;
      }
      results.sort((a, b) => a.group - b.group);
      waves.push({ wave: waveIndex + 1, groups: results, wins: results.reduce((sum, group) => sum + group.wins, 0),
        targetCount: results.reduce((sum, group) => sum + group.targetCount, 0),
        remainingCards: cards.map(card => ({ ...card })), remainingInventory: { ...inventory } });
    }
    return { waves, wins, targetCount, itemCount, usedItems, explored, earlyHealing,
      planningMode: earlyHealing.length ? 'sequential-healing' : 'sequential', model: waves[0].groups[0].model,
      remainingCards: cards.map(card => ({ ...card })), remainingInventory: { ...inventory } };
  }
  let best = yield* plan(), attempts = 0;
  const healingItem = itemCatalog.items.find(item => item.enabled && item.parameters.health_delta);
  const power = new Map(catalog.cards.map(card => [card.id, card.power_min]));
  // shortcut: only retry up to 12 earlier healing choices; broader resource backtracking needs action-level search.
  while (!control.stopped && healingItem && attempts < 12 && best.wins < best.targetCount) {
    const failedWave = best.waves.findLastIndex(wave => wave.wins < wave.targetCount);
    if (failedWave < 1) break;
    const lowHealth = new Set(best.waves[failedWave - 1].remainingCards.filter(card => card.health <= 1).map(card => card.cardId));
    const flat = best.waves.flatMap(wave => wave.groups);
    const candidates = [];
    let groupOffset = 0, healingStock = input.inventory?.[healingItem.id] ?? 0;
    best.waves.forEach((wave, waveIndex) => wave.groups.forEach(group => {
      if (waveIndex < failedWave && healingStock > 0 && !group.conditions.itemsDisabled) group.positions.forEach(position => {
        if (lowHealth.has(position.cardId) && position.originalHealth > 0 && position.originalHealth < 3 && !position.specialId)
          candidates.push({ index: groupOffset, waveIndex, position: position.position, cardId: position.cardId });
      });
      healingStock -= group.usedItems[healingItem.id] ?? 0;
      groupOffset++;
    }));
    candidates.sort((a, b) => b.waveIndex - a.waveIndex || power.get(b.cardId) - power.get(a.cardId) || b.index - a.index);
    let improved = false;
    for (const candidate of candidates) {
      if (control.stopped || attempts >= 12) break;
      const prefix = flat.slice(0, candidate.index + 1).map(group => ({ ...group, formation: group.formation.map(unit => unit ? { ...unit } : null) }));
      const group = prefix[candidate.index];
      group.formation[candidate.position].specialId = healingItem.id;
      group.earlyHealingPositions = [...(group.earlyHealingPositions ?? []), candidate.position];
      const alternative = yield* plan(prefix, ++attempts);
      if (alternative.wins > best.wins) { best = alternative; improved = true; break; }
    }
    if (!improved) break;
  }
  let groupRepairRetries = 0;
  const groupRepairs = [], tried = new Set();
  // shortcut: 最多4次为失败后组预留单位；此前波次固定，不枚举所有组间配队或跨波用卡。
  while (!control.stopped && groupRepairRetries < 4 && best.wins < best.targetCount) {
    const flat = best.waves.flatMap(wave => wave.groups);
    let waveOffset = 0;
    const candidates = best.waves.flatMap((wave, waveIndex) => {
      const offset = waveOffset;
      waveOffset += wave.groups.length;
      return wave.groups.filter(group => group.group > 1 && group.wins < group.targetCount && !tried.has(`${waveIndex}:${group.group}`))
        .map(group => ({ waveIndex, groupIndex: group.group - 1, offset }));
    });
    let improved = false;
    for (const candidate of candidates) {
      if (control.stopped || groupRepairRetries >= 4) break;
      tried.add(`${candidate.waveIndex}:${candidate.groupIndex + 1}`);
      const alternative = yield* plan(flat.slice(0, candidate.offset), 0, { ...candidate, attempt: ++groupRepairRetries });
      if (alternative.wins > best.wins) {
        best = alternative;
        groupRepairs.push({ wave: candidate.waveIndex + 1, group: candidate.groupIndex + 1 });
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return { ...best, planningMode: groupRepairs.length ? 'sequential-group-repair' : best.planningMode,
    groupRepairs, groupRepairRetries, explored: workExplored, healingRetries: attempts, searchCacheHits };
}
