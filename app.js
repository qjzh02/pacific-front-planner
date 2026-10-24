const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const STAT_NAMES = { firepower: '火力', survivability: '存活性', mobility: '机动性' };
const TYPE_NAMES = { aircraft: '飞机', battleship: '战列舰', cruiser: '巡洋舰', destroyer: '驱逐舰' };
const ENEMY_TYPE_NAMES = { ...TYPE_NAMES, submarine: '潜艇', coastal_artillery: '岸防炮', naval_mine: '水雷' };
const ARROWS = { left: '←', right: '→', front_left: '↖', front: '↑', front_right: '↗' };
const STORAGE_KEY = 'pacific-front-planner-v1';
const CAPTURE_BACKUP_KEY = `${STORAGE_KEY}-capture-backup`;
const capture = globalThis.PacificFrontCapture;
let captureConnected = false, captureClientId = null, pendingCapture = null, captureUndo = null;
let captureConnectionKey = '', manuallyPaused = false;
let catalog, items, worker, dirty = false;
let filter = 'all';
const format = value => Number(value.toFixed(2)).toLocaleString('zh-CN');
const conditionText = (global, conditions = {}) => [
  ...Object.entries(STAT_NAMES).filter(([stat]) => global[stat] > 0).map(([stat, name]) => `${name}−${format(global[stat] * 100)}%`),
  ...(conditions.buffsDisabled ? ['增益失效'] : []), ...(conditions.debuffsDisabled ? ['减益失效'] : []),
  ...(conditions.buffsReduced ? ['增益效果减少50%'] : []), ...(conditions.debuffsReduced ? ['减益效果减少50%'] : []),
  ...(conditions.itemsDisabled ? ['禁用道具（灰色、绿色）'] : []),
  ...(conditions.allowedTypes ? [`限定舰种：${conditions.allowedTypes.map(type => TYPE_NAMES[type]).join('、')}`] : []),
  ...(conditions.captureSource?.enemyPowerIncrease > 0 ? [`区域敌方战力＋${format(conditions.captureSource.enemyPowerIncrease * 100)}%（已计入）`] : []),
  ...(conditions.captureSource?.enemyPowerIncreases ?? []).map(({ type, rate }) => `区域敌方${ENEMY_TYPE_NAMES[type]}战力＋${format(rate * 100)}%（已计入）`),
].join('，') || '无战场条件';

function groupConditionsMarkup(condition, waveIndex, groupIndex) {
  const label = `第${waveIndex + 1}波第${groupIndex + 1}组`;
  const saved = new Map((condition.globalInputs ?? []).map(value => [value.stat, value]));
  return `<fieldset class="group-conditions"><legend>${label} · 战场条件</legend><p>仅作用于本组我方单位</p><div class="group-condition-grid">${Object.entries(STAT_NAMES).map(([stat, name]) => {
    const rate = condition.global?.[stat] ?? 0;
    const value = saved.get(stat) ?? { active: rate > 0, percent: rate > 0 ? rate * 100 : 24 };
    return `<div class="global-row" data-global="${stat}"><label><input type="checkbox" class="global-active" ${value.active ? 'checked' : ''} aria-label="${label}所有单位${name}">所有单位${name}</label><div class="percent-field">−<input type="number" class="global-percent" min="0" max="100" step="any" value="${escape(value.percent)}" aria-label="${label}${name}减益百分比">%</div></div>`;
  }).join('')}</div>
    <div class="effect-conditions"><label><input type="checkbox" class="buffs-disabled" ${condition.buffsDisabled ? 'checked' : ''} aria-label="${label}增益失效">增益失效</label><label><input type="checkbox" class="debuffs-disabled" ${condition.debuffsDisabled ? 'checked' : ''} aria-label="${label}减益失效">减益失效</label><label><input type="checkbox" class="buffs-reduced" ${condition.buffsReduced ? 'checked' : ''} aria-label="${label}增益效果减少50%">增益效果减少50%</label><label><input type="checkbox" class="debuffs-reduced" ${condition.debuffsReduced ? 'checked' : ''} aria-label="${label}减益效果减少50%">减益效果减少50%</label><label><input type="checkbox" class="items-disabled" ${condition.itemsDisabled ? 'checked' : ''} aria-label="${label}禁用道具">禁用道具（禁用变项）</label><label><input type="checkbox" class="restrict-types" ${condition.allowedTypes != null ? 'checked' : ''} aria-label="${label}限定舰种">限定舰种</label></div>
    <div class="allowed-types"><span>允许上阵（可多选）</span>${Object.entries(TYPE_NAMES).map(([type, name]) => `<label><input type="checkbox" value="${type}" ${(condition.allowedTypeInputs ?? condition.allowedTypes ?? []).includes(type) ? 'checked' : ''} aria-label="${label}允许${name}">${name}</label>`).join('')}</div>
    </fieldset>`;
}

function renderWaves(waves) {
  const opened = new Map([...document.querySelectorAll('[data-wave]')].map(wave => [Number(wave.dataset.wave), wave.open]));
  const weaknessOrder = ['debuff_vertical_lines', 'debuff_concentric_target', 'debuff_ring_projectile', 'debuff_single_shell', 'debuff_three_shells', 'debuff_plane'];
  const debuffs = catalog.effect_types.filter(effect => effect.kind === 'debuff').sort((a, b) => weaknessOrder.indexOf(a.id) - weaknessOrder.indexOf(b.id));
  $('#enemies').innerHTML = waves.map((wave, waveIndex) => `<details class="wave-input" data-wave="${waveIndex}" ${(opened.get(waveIndex) ?? (waveIndex === 0)) ? 'open' : ''}>
    <summary>第${waveIndex + 1}波 <span>${wave.enemies.length}个敌人 · ${wave.enemies.length / 4}组</span></summary>
    <label class="wave-size-label">本波敌军数量<select class="wave-size" aria-label="第${waveIndex + 1}波敌军数量">${[4, 8, 12, 16, 20].map(count => `<option value="${count}" ${count === wave.enemies.length ? 'selected' : ''}>${count}个（${count / 4}组）</option>`).join('')}</select></label>
    ${Array.from({ length: wave.enemies.length / 4 }, (_, groupIndex) => `<div class="enemy-group" data-group="${groupIndex}" data-capture-source="${escape(JSON.stringify(wave.groupConditions?.[groupIndex]?.captureSource ?? null))}"><h3>第${groupIndex + 1}组 · 从左到右</h3>${wave.groupConditions?.[groupIndex]?.captureSource ? `<p class="capture-source">采集来源：${escape(captureSourceText(wave.groupConditions[groupIndex].captureSource))} · 仅区域条件</p>` : ''}${groupConditionsMarkup(wave.groupConditions?.[groupIndex] ?? {}, waveIndex, groupIndex)}<div class="enemy-grid">${wave.enemies.slice(groupIndex * 4, groupIndex * 4 + 4).map((enemy, localIndex) => {
      const index = groupIndex * 4 + localIndex;
      const label = `第${waveIndex + 1}波敌军${index + 1}`;
      return `<div class="enemy" data-enemy="${index}"${enemy.powerIncrease !== undefined ? ` data-power-increase="${escape(enemy.powerIncrease)}"` : ''}>
    <div class="enemy-top"><span>敌军 / ${String(index + 1).padStart(2, '0')}</span><label><input type="checkbox" class="enemy-active" ${enemy.active !== false ? 'checked' : ''} aria-label="${label}存在">有敌人</label></div>
    <label class="enemy-power-label">总战力<input class="enemy-power" type="number" min="0" max="1000000" step="any" value="${escape(enemy.rawPower ?? enemy.power ?? '')}" placeholder="填写数值" aria-label="${label}总战力"></label>
    <div class="weakness-title"><span>可命中的减益</span><span class="weakness-count">0 / 2</span></div>
    <div class="weakness-list">${debuffs.map(effect => `<label><input type="checkbox" value="${effect.id}" ${(enemy.weaknesses ?? []).includes(effect.id) ? 'checked' : ''} aria-label="${label}弱点${escape(effect.weakness_name)}">${escape(effect.weakness_name)}</label>`).join('')}</div></div>`;
    }).join('')}</div></div>`).join('')}</details>`).join('');
}
const blankEnemy = () => ({ active: true, rawPower: '', weaknesses: [] });
function renderInputs() {
  renderWaves([{ enemies: Array.from({ length: 4 }, blankEnemy) }]);
  const effectById = new Map(catalog.effect_types.map(effect => [effect.id, effect]));
  $('#cards').innerHTML = catalog.cards.map(card => `<div class="fleet-card" data-card="${card.id}" data-type="${card.unit_type}">
    <label class="card-select"><input type="checkbox" class="card-owned" aria-label="选择${escape(card.name)}"><span class="card-name">${escape(card.name).replace('／', '<br>')}</span></label>
    <div class="card-meta"><span class="type-label">${TYPE_NAMES[card.unit_type]}</span><span class="power"><small>最低战力</small>${card.power_min}</span></div>
    <div class="stat-line"><span>火 ${card.firepower}</span><span>存 ${card.survivability}</span><span>机 ${card.mobility}</span></div>
    <div class="effect-line">${card.effects.map(effect => { const type = effectById.get(effect.type); return `<div class="${type.kind}-text">${ARROWS[effect.direction]} ${escape(type.weakness_name ?? STAT_NAMES[type.target_stat] + '增益')} ${type.kind === 'buff' ? '+30%' : '−20%'}</div>`; }).join('')}</div>
    <label class="health-label">当前生命<select class="card-health" aria-label="${escape(card.name)}当前生命"><option value="3">●●● 3格</option><option value="2">●● 2格</option><option value="1">● 1格</option><option value="0">0格</option></select></label></div>`).join('');
  for (const slot of ['standard', 'special']) {
    $(`#${slot}-items`).innerHTML = items.items.filter(item => item.slot === slot).map(item => `<label class="item-row ${item.enabled ? '' : 'excluded'}"><span><strong>${item.position}. ${escape(item.label)}</strong><small>${escape(item.description)}</small></span><input type="number" min="0" max="999" step="1" data-item="${item.id}" aria-label="${escape(item.label)}数量" value="${items.inventory_snapshot.quantities[item.id]}" ${item.enabled ? '' : 'disabled'}></label>`).join('');
  }
}

function readInput(validate = false) {
  const waves = [...document.querySelectorAll('[data-wave]')].map(wave => ({ enemies: [...wave.querySelectorAll('[data-enemy]')].map(row => {
    const active = row.querySelector('.enemy-active').checked;
    const raw = row.querySelector('.enemy-power').value;
    if (validate && active && raw === '') throw new Error(`请填写第${Number(wave.dataset.wave) + 1}波敌军${Number(row.dataset.enemy) + 1}的总战力。`);
    return { active, power: raw === '' ? 0 : Number(raw), rawPower: raw,
      ...(row.dataset.powerIncrease !== undefined ? { powerIncrease: Number(row.dataset.powerIncrease) } : {}),
      weaknesses: [...row.querySelectorAll('.weakness-list input:checked')].map(input => input.value) };
  }), groupConditions: [...wave.querySelectorAll('[data-group]')].map(group => {
    const rows = [...group.querySelectorAll('[data-global]')];
    if (validate && rows.some(row => row.querySelector('.global-active').checked && row.querySelector('.global-percent').value === '')) {
      throw new Error(`请填写第${Number(wave.dataset.wave) + 1}波第${Number(group.dataset.group) + 1}组的减益百分比。`);
    }
    const allowedTypeInputs = [...group.querySelectorAll('.allowed-types input:checked')].map(field => field.value);
    const restricted = group.querySelector('.restrict-types').checked;
    if (validate && restricted && !allowedTypeInputs.length) throw new Error(`请至少选择第${Number(wave.dataset.wave) + 1}波第${Number(group.dataset.group) + 1}组允许的一个舰种。`);
    return { global: Object.fromEntries(rows.map(row => [row.dataset.global,
      row.querySelector('.global-active').checked ? Number(row.querySelector('.global-percent').value) / 100 : 0])),
      globalInputs: rows.map(row => ({ stat: row.dataset.global, active: row.querySelector('.global-active').checked, percent: row.querySelector('.global-percent').value })),
      buffsDisabled: group.querySelector('.buffs-disabled').checked, debuffsDisabled: group.querySelector('.debuffs-disabled').checked,
      buffsReduced: group.querySelector('.buffs-reduced').checked, debuffsReduced: group.querySelector('.debuffs-reduced').checked,
      itemsDisabled: group.querySelector('.items-disabled').checked,
      allowedTypes: restricted ? allowedTypeInputs : null, allowedTypeInputs,
      captureSource: JSON.parse(group.dataset.captureSource ?? 'null') };
  }) }));
  const cards = [...document.querySelectorAll('[data-card]')].filter(row => row.querySelector('.card-owned').checked)
    .map(row => ({ cardId: row.dataset.card, health: Number(row.querySelector('.card-health').value) }));
  const inventory = Object.fromEntries([...document.querySelectorAll('[data-item]')].map(input => [input.dataset.item, input.value === '' ? 0 : Number(input.value)]));
  if (validate) waves.forEach((wave, index) => {
    for (let start = 0; start < wave.enemies.length; start += 4) {
      if (!wave.enemies.slice(start, start + 4).some(enemy => enemy.active)) throw new Error(`请至少启用第${index + 1}波第${start / 4 + 1}组的一个敌军位置。`);
    }
  });
  return { waves, cards, inventory,
    model: { stacking: 'additive', globalStacking: $('#global-stacking').value, rounding: $('#rounding').value, allowEqual: $('#allow-equal').checked, revive: $('#revive').checked },
    beamWidth: Number($('#beam-width').value), computeBudget: Number($('#compute-budget').value),
    pauseBackground: $('#pause-background').checked, captureAuto: $('#capture-auto').checked };
}

function restore(input) {
  $('#capture-auto').checked = input.captureAuto !== false;
  const waves = input.waves ?? (input.enemies ? [{ enemies: input.enemies }] : null);
  if (waves?.length >= 1 && waves.length <= 6 && waves.every(wave => [4, 8, 12, 16, 20].includes(wave.enemies?.length))) {
    const legacy = waves.some(wave => !wave.groupConditions) && (input.global || input.globalInputs);
    const migrated = waves.map(wave => ({ ...wave, groupConditions: wave.groupConditions ?? Array.from({ length: wave.enemies.length / 4 }, () => ({ global: input.global ?? {}, globalInputs: input.globalInputs ?? [] })) }));
    renderWaves(migrated);
    $('#migration-note').hidden = !legacy;
  }
  const selected = new Map((input.cards ?? []).map(card => [card.cardId, card.health]));
  document.querySelectorAll('[data-card]').forEach(row => {
    row.querySelector('.card-owned').checked = selected.has(row.dataset.card);
    row.querySelector('.card-health').value = selected.get(row.dataset.card) ?? 3;
  });
  document.querySelectorAll('[data-item]').forEach(field => { if (input.inventory?.[field.dataset.item] != null) field.value = input.inventory[field.dataset.item]; });
  if (input.model) {
    $('#global-stacking').value = input.model.globalStacking;
    $('#rounding').value = input.model.rounding;
    $('#allow-equal').checked = input.model.allowEqual;
    $('#revive').checked = input.model.revive;
  }
  if ([300, 900, 2400].includes(input.beamWidth)) $('#beam-width').value = input.beamWidth;
  if ([0, 30, 60].includes(input.computeBudget)) $('#compute-budget').value = input.computeBudget;
  if (typeof input.pauseBackground === 'boolean') $('#pause-background').checked = input.pauseBackground;
}

function synchronize(save = true) {
  let count = 0;
  document.querySelectorAll('[data-card]').forEach(row => {
    const chosen = row.querySelector('.card-owned').checked;
    count += Number(chosen); row.classList.toggle('chosen', chosen);
    row.hidden = filter !== 'all' && row.dataset.type !== filter;
  });
  document.querySelectorAll('[data-enemy]').forEach(row => {
    const active = row.querySelector('.enemy-active').checked;
    row.classList.toggle('inactive', !active);
    row.querySelector('.enemy-power').required = active;
    row.querySelector('.enemy-power').disabled = !active;
    row.querySelectorAll('.weakness-list input').forEach(input => { input.disabled = !active; });
    row.querySelector('.weakness-count').textContent = `${row.querySelectorAll('.weakness-list input:checked').length} / 2`;
  });
  document.querySelectorAll('[data-global]').forEach(row => { row.querySelector('.global-percent').disabled = !row.querySelector('.global-active').checked; });
  document.querySelectorAll('[data-group]').forEach(group => {
    const restricted = group.querySelector('.restrict-types').checked;
    group.querySelector('.allowed-types').classList.toggle('inactive', !restricted);
    group.querySelectorAll('.allowed-types input').forEach(field => { field.disabled = !restricted; });
  });
  $('#selected-count').textContent = `${count} / ${catalog.cards.length}`;
  const waveCount = document.querySelectorAll('[data-wave]').length;
  $('#wave-count').textContent = `${waveCount} / 6波`;
  $('#add-wave').disabled = waveCount >= 6;
  $('#remove-wave').disabled = waveCount <= 1;
  $('#ready-summary').textContent = count ? `已选${count}张卡牌 · ${waveCount}波 / ${document.querySelectorAll('[data-enemy]').length}个敌人` : '请选择你的可用卡牌';
  if (save) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readInput())); } catch { $('.save-note').textContent = '此浏览器未允许保存，输入仅在本次页面保留。'; } }
  refreshCaptureTargets();
}

function stop() {
  worker?.terminate(); worker = null;
  manuallyPaused = false;
  $('#calculate').disabled = false; $('#cancel').hidden = true; $('#pause').hidden = true;
  $('#result-panel').classList.remove('compute-paused');
  $('#result-panel').setAttribute('aria-busy', 'false');
}

function updateSolverPause() {
  if (!worker) return;
  worker.postMessage({ type: 'pause', paused: manuallyPaused || ($('#pause-background').checked && document.hidden) });
  $('#pause').textContent = manuallyPaused ? '继续计算' : '暂停计算';
}
function error(message) {
  stop(); $('#result-panel').innerHTML = `<p class="error" role="alert">${escape(message)}</p>`;
  $('#result-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function groupResult(result, byId) {
  const complete = result.wins === result.targetCount;
  const searchText = result.searchMode === 'unsearched' ? '计算预算已到，本组尚未搜索。' : result.searchIncomplete ? '本组搜索未完成，显示已找到的阵容。' :
    result.replayed ? '本组复用此前阵容，已重新结算生命与库存。' : result.searchMode === 'exact' ? '本组已穷举当前可用组合。' : '本组为有限搜索结果。';
  const searchSummary = result.searchMode === 'unsearched' ? '尚未搜索' : result.searchIncomplete ? `搜索未完成 · 已检查 ${result.explored.toLocaleString()} 个分支` :
    result.replayed ? '复算此前阵容' : result.searchReused ? '复用相同输入的搜索结果' : `检查 ${result.explored.toLocaleString()} 个搜索分支 · ${result.searchMode === 'exact' ? '穷举' : `搜索范围 ${result.beamWidth}`}`;
  return `<div class="result-header"><div class="result-title"><h3>第${result.group}组 · ${complete ? '全部对位胜出' : '当前配队方案'}</h3><p>${searchText} 同波先前已上阵的卡牌不再参与。<br>本组战场条件：${conditionText(result.global, result.conditions)}</p></div><span class="result-badge">${result.wins} / ${result.targetCount}</span></div>
    <div class="result-grid">${result.positions.map(position => `<article class="position-result ${position.win ? 'win' : position.active ? 'fail' : ''}">
      <small>阵位 0${position.position + 1} · 生命 ${position.health ?? '—'} → ${position.healthAfter ?? '—'}/3</small><h3>${escape(position.name ?? '空位')}</h3>
      <div class="power-comparison"><div><small>我方最低战力</small>${format(position.ownPower)}</div><div><small>敌方最终战力</small>${position.active ? format(position.enemyPower) : '—'}</div></div>
      <p class="outcome">${!position.active ? '此位无敌人' : !position.cardId ? '未部署单位' : position.win ? `当前模型胜出 · 余量 +${format(position.margin)}` : `未达到胜出条件 · 差值 ${format(position.margin)}`}</p>
      <div class="result-items">灰色：<b>${escape(byId.get(position.standardId)?.label ?? '不装备')}</b><br>绿色：<b>${escape(byId.get(position.specialId)?.label ?? '不装备')}</b>${position.earlyHealing ? '<br><b>提前回血，为后续波次保留生命</b>' : ''}</div>
      <div class="result-effects">${position.effects.length ? position.effects.map(effect => `${escape(effect.sourceName)}：${effect.kind === 'buff' ? `${STAT_NAMES[effect.name]}＋${Math.round(effect.rate * 100)}%` : `${escape(effect.name)}减益−${format((1 - effect.multiplier) * 100)}%`}`).join('<br>') : '无有效的相邻增益或敌方减益'}${position.enemyPowerIncrease > 0 ? `<br>敌方原战力${format(position.enemyBasePower)} · 区域战力＋${format(position.enemyPowerIncrease * 100)}% · 减益按原战力结算${position.enemyPowerRoundingAssumed ? '（取整方式待核对）' : ''}` : ''}${position.stats ? `<br>结算属性：火${format(position.stats.firepower)} / 存${format(position.stats.survivability)} / 机${format(position.stats.mobility)}` : ''}</div></article>`).join('')}</div>
    <div class="result-footer"><span>道具共 ${result.itemCount} 个：${Object.entries(result.usedItems).map(([id, quantity]) => `${escape(byId.get(id).label)} ×${quantity}`).join('，') || '无消耗'}</span><span>${searchSummary}</span></div>
    `;
}

function renderResult(result) {
  const byId = new Map(items.items.map(item => [item.id, item]));
  const cardById = new Map(catalog.cards.map(card => [card.id, card]));
  const stockText = inventory => Object.entries(inventory).filter(([id, count]) => count > 0 && byId.get(id).enabled).map(([id, count]) => `${escape(byId.get(id).label)} ×${count}`).join('，') || '无剩余可用道具';
  $('#result-panel').innerHTML = `<div class="result-header"><div class="result-title"><h2>行动配队方案 · ${result.waves.length}波</h2><p>同等胜场时先少用绿色、再少用灰色道具；各类道具和单位数量相同时优先用弱卡，保留强卡。按波次规划，失败时尝试提前回血和重新分配同波用卡；同一卡牌每波只上阵一次。此方案尚未证明整场行动全局最优。</p></div><span class="result-badge">${result.wins} / ${result.targetCount} 对位胜出</span></div>
    ${result.searchLimited ? '<p class="section-note" role="status">已达到计算预算，保留当前已找到的方案。请核对各组“搜索未完成”或“尚未搜索”标记；可增加预算后重新计算。</p>' : ''}
    <p class="section-note">道具预计消耗${result.itemCount}个。以下生命与库存为模拟结果，未改动你的输入或游戏。空位可能用于保留无法增加本组胜场的单位。${result.groupRepairs?.length ? `<br>已重新分配同波用卡：${result.groupRepairs.map(repair => `第${repair.wave}波为第${repair.group}组预留单位`).join('；')}。请仍按原组序执行下方方案。` : ''}</p>
    ${result.waves.map(wave => `<details class="wave-result" open><summary>第${wave.wave}波 <span>${wave.groups.length}组 · ${wave.wins}/${wave.targetCount}胜出</span></summary>
      ${wave.groups.map(group => `<div class="group-result">${groupResult(group, byId)}</div>`).join('')}
      <div class="wave-resources"><h3>第${wave.wave}波结束后 · 预计资源</h3><div class="health-snapshot">${wave.remainingCards.map(card => `<span class="${card.health ? '' : 'exhausted'}">${escape(cardById.get(card.cardId).name)} <b>${card.health}/3</b></span>`).join('')}</div><p>剩余道具：${stockText(wave.remainingInventory)}</p></div></details>`).join('')}
    <div class="result-footer"><span>正向增幅加算 · 敌方减益加算 · 各组条件减益${result.model.globalStacking === 'multiply' ? '单独乘算' : '加入倍率'} · ${result.model.rounding === 'conservative' ? '保守取整' : '保留小数'} · ${result.model.allowEqual ? '相等计胜' : '严格大于才计胜'}</span><button type="button" id="copy-result">复制行动方案</button></div>`;
  $('#copy-result').addEventListener('click', async () => {
    const lines = ['同等胜场时先少用绿色、再少用灰色道具；各类道具和单位数量相同时优先用弱卡，保留强卡；逐组规划，失败时尝试提前回血及重新分配同波用卡，未证明整场行动全局最优。'];
    if (result.searchLimited) lines.push('已达到计算预算，以下为当前方案；标记为搜索未完成或尚未搜索的组需要继续核对。');
    if (result.groupRepairs?.length) lines.push(`已重新分配同波用卡：${result.groupRepairs.map(repair => `第${repair.wave}波为第${repair.group}组预留单位`).join('；')}；按原组序执行。`);
    result.waves.forEach(wave => {
      lines.push(`第${wave.wave}波：${wave.wins}/${wave.targetCount}胜出`);
      wave.groups.forEach(group => {
        lines.push(`第${group.group}组${group.searchMode === 'unsearched' ? ' · 尚未搜索' : group.searchIncomplete ? ' · 搜索未完成' : ''} · 战场条件：${conditionText(group.global, group.conditions)}`);
        group.positions.forEach(position => lines.push(`${position.position + 1}. ${position.name ?? '空位'}｜灰：${byId.get(position.standardId)?.label ?? '无'}｜绿：${byId.get(position.specialId)?.label ?? '无'}${position.earlyHealing ? '（提前回血，为后续波次保留生命）' : ''}｜我方${format(position.ownPower)} / 敌方${format(position.enemyPower)}｜生命${position.health ?? '—'}→${position.healthAfter ?? '—'}`));
      });
      lines.push(`本波结束剩余生命：${wave.remainingCards.map(card => `${cardById.get(card.cardId).name} ${card.health}/3`).join('，')}`);
      lines.push(`剩余道具：${Object.entries(wave.remainingInventory).filter(([id, count]) => count > 0 && byId.get(id).enabled).map(([id, count]) => `${byId.get(id).label} ×${count}`).join('，') || '无'}`);
    });
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); $('#copy-result').textContent = '已复制'; } catch { $('#copy-result').textContent = '复制未成功，请手动选择结果'; }
  });
  $('#result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function captureSourceText(source) {
  const typeNames = ENEMY_TYPE_NAMES;
  const restoredNote = source.enemyPowerIncrease || source.enemyPowerIncreases?.length ? '已去除带入，保留区域增益' : '已还原原战力';
  const typed = (source.enemyPowerIncreases ?? []).map(({ type, rate }) => ` · 区域敌方${typeNames[type]}战力＋${format(rate * 100)}%（已计入敌军数值）`).join('');
  const restored = (source.ignoredEnemyPowerIncreases ?? []).map(({ type, rate }) => ` · 带入敌方${typeNames[type]}战力＋${format(rate * 100)}%（${restoredNote}）`).join('');
  return `${source.action} · 阶段${source.stage} · 关键据点${source.keypoint}${source.enemyPowerIncrease > 0 ? ` · 区域敌方战力＋${format(source.enemyPowerIncrease * 100)}%（已计入敌军数值）` : ''}${typed}${restored}${source.ignoredEnemyPowerIncrease > 0 ? ` · 带入敌方战力＋${format(source.ignoredEnemyPowerIncrease * 100)}%（${restoredNote}）` : ''}`;
}

function captureFeedback(message, failed = false) {
  $('#capture-feedback').textContent = message;
  $('#capture-feedback').classList.toggle('capture-error', failed);
}

function refreshCaptureTargets() {
  const select = $('#capture-target');
  const selected = select.value;
  const options = [];
  document.querySelectorAll('[data-wave]').forEach(wave => {
    wave.querySelectorAll('[data-group]').forEach(group => {
      const waveIndex = Number(wave.dataset.wave), groupIndex = Number(group.dataset.group);
      options.push(new Option(`第${waveIndex + 1}波（阶段）· 第${groupIndex + 1}组`, `${waveIndex}:${groupIndex}`));
    });
  });
  select.replaceChildren(...options);
  if (options.some(option => option.value === selected)) select.value = selected;
  select.disabled = Boolean(pendingCapture) || $('#capture-auto').checked;
  document.querySelectorAll('[data-group]').forEach(group => group.classList.toggle('capture-target-group',
    `${group.closest('[data-wave]').dataset.wave}:${group.dataset.group}` === select.value));
}

function updateCaptureConnection() {
  const connected = captureConnected;
  const key = `${connected}:${Boolean(pendingCapture)}:${Boolean(captureUndo)}:${captureUndo?.kind}:${$('#capture-auto').checked}`;
  if (key === captureConnectionKey) return connected;
  captureConnectionKey = key;
  $('#capture-current').disabled = !connected || Boolean(pendingCapture);
  $('#capture-file-button').disabled = Boolean(pendingCapture);
  $('#capture-undo').disabled = !captureUndo || Boolean(pendingCapture);
  $('#capture-target').disabled = Boolean(pendingCapture) || $('#capture-auto').checked;
  $('#capture-undo').textContent = captureUndo?.kind === 'reset' ? '撤销重置' : '撤销上次抓取';
  $('#capture-connection').textContent = connected ? '游戏页面已连接 · 请先手动打开要抓取的据点' : '游戏页面未连接 · 首次连接方法见下方说明';
  return connected;
}

function cancelPendingCapture(message) {
  if (!pendingCapture) return;
  clearTimeout(pendingCapture.timer);
  pendingCapture = null;
  updateCaptureConnection();
  if (message) captureFeedback(message, true);
}

function beginCapture(kind) {
  cancelPendingCapture();
  const [waveIndex, groupIndex] = $('#capture-target').value.split(':').map(Number);
  const request = { kind, waveIndex, groupIndex, auto: $('#capture-auto').checked, requestId: crypto.randomUUID() };
  request.timer = setTimeout(() => {
    if (pendingCapture === request) cancelPendingCapture('抓取超时，原输入已保留。请检查游戏脚本连接，或导入HTML/TXT。');
  }, 8000);
  pendingCapture = request;
  updateCaptureConnection();
  captureFeedback(request.auto ? '正在读取，将按页面阶段和据点编号自动填入……' : `正在读取，目标为第${waveIndex + 1}波第${groupIndex + 1}组……`);
  return request;
}

function captureGroup(input, waveIndex, groupIndex) {
  const wave = input.waves[waveIndex];
  if (!wave || (groupIndex + 1) * 4 > wave.enemies.length) throw new Error('目标组已不存在，请重新选择。');
  return structuredClone({ enemies: wave.enemies.slice(groupIndex * 4, groupIndex * 4 + 4), condition: wave.groupConditions[groupIndex] });
}

function applyCapture(snapshot, request) {
  if (pendingCapture !== request) return;
  const before = readInput();
  const result = request.auto ? capture.mergeAutoSnapshot(before, snapshot) : {
    input: capture.mergeSnapshot(before, request.waveIndex, request.groupIndex, snapshot), waveIndex: request.waveIndex, groupIndex: request.groupIndex };
  const { waveIndex, groupIndex } = result;
  const previous = before.waves[waveIndex]?.enemies.length >= (groupIndex + 1) * 4 ? captureGroup(before, waveIndex, groupIndex) : null;
  cancelPendingCapture();
  stop();
  restore(result.input);
  const appliedInput = readInput();
  saveCaptureUndo({ waveIndex, groupIndex, previous, applied: captureGroup(appliedInput, waveIndex, groupIndex),
    ...(request.auto ? { structure: { beforeWaves: before.waves, appliedWaves: appliedInput.waves } } : {}) });
  $('#planner').dispatchEvent(new Event('input'));
  $(`[data-wave="${waveIndex}"]`).open = true;
  const select = $('#capture-target');
  select.value = `${waveIndex}:${groupIndex}`;
  const index = select.selectedIndex;
  if (!request.auto && index + 1 < select.options.length) select.selectedIndex = index + 1;
  refreshCaptureTargets();
  updateCaptureConnection();
  captureFeedback(`已填入第${waveIndex + 1}波第${groupIndex + 1}组：${snapshot.enemies.map(enemy => enemy.power).join(' / ')}。来源：${captureSourceText(snapshot.source)}。${request.auto ? '已按来源自动定位，可继续打开下一个据点。' : index + 1 < select.options.length ? '已选中下一组。' : '已到最后一组。'}`);
}

function saveCaptureUndo(value) {
  captureUndo = value;
  try {
    if (value) localStorage.setItem(CAPTURE_BACKUP_KEY, JSON.stringify(value));
    else localStorage.removeItem(CAPTURE_BACKUP_KEY);
  } catch { /* 本次仍可使用内存中的回退记录。 */ }
}

function undoCaptureExpansion(input, structure, waveIndex) {
  const { beforeWaves, appliedWaves } = structure;
  const unchanged = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const message = '自动新增的阶段或组已有其他修改，未撤销，以免覆盖你的新输入。';
  if (appliedWaves.length > beforeWaves.length) {
    if (input.waves.length !== appliedWaves.length || !unchanged(input.waves.slice(beforeWaves.length), appliedWaves.slice(beforeWaves.length))) throw new Error(message);
  }
  const previousWave = beforeWaves[waveIndex], appliedWave = appliedWaves[waveIndex], wave = input.waves[waveIndex];
  if (previousWave && previousWave.enemies.length < appliedWave.enemies.length) {
    const count = previousWave.enemies.length;
    if (wave.enemies.length !== appliedWave.enemies.length || !unchanged(wave.enemies.slice(count), appliedWave.enemies.slice(count)) ||
      !unchanged(wave.groupConditions.slice(count / 4), appliedWave.groupConditions.slice(count / 4))) throw new Error(message);
    wave.enemies.length = count; wave.groupConditions.length = count / 4;
  }
  if (appliedWaves.length > beforeWaves.length) input.waves.length = beforeWaves.length;
}

function setupCapture() {
  if (!capture) { captureFeedback('采集脚本未加载，请重新启动服务并刷新页面。', true); return; }
  try {
    const saved = JSON.parse(localStorage.getItem(CAPTURE_BACKUP_KEY));
    const validWaves = waves => Array.isArray(waves) && waves.length >= 1 && waves.length <= 6 &&
      waves.every(wave => [4, 8, 12, 16, 20].includes(wave.enemies?.length) && wave.groupConditions?.length === wave.enemies.length / 4);
    if (saved?.kind === 'reset' && validWaves(saved.previousWaves) && validWaves(saved.appliedWaves)) captureUndo = saved;
    else if (Number.isInteger(saved?.waveIndex) && saved.waveIndex >= 0 && saved.waveIndex < 6 && Number.isInteger(saved.groupIndex) && saved.groupIndex >= 0 && saved.groupIndex < 5 &&
      (saved.previous?.enemies?.length === 4 && saved.previous.condition || saved.previous === null && saved.structure) &&
      (!saved.structure || validWaves(saved.structure.beforeWaves) && validWaves(saved.structure.appliedWaves)) &&
      saved.applied?.enemies?.length === 4 && saved.applied.condition) captureUndo = saved;
  } catch { /* 损坏或不可用的回退记录不影响正常输入。 */ }
  updateCaptureConnection();
  let statusBusy = false, statusTimer = null;
  const pollCaptureStatus = async () => {
    clearTimeout(statusTimer);
    if (statusBusy || !capture.token) return;
    statusBusy = true;
    try {
      const state = await capture.relayRequest('status');
      if (captureClientId && state.clientId !== captureClientId) cancelPendingCapture('已切换游戏页面，请核对当前据点后重新抓取。');
      captureClientId = state.clientId;
      captureConnected = state.connected;
      updateCaptureConnection();
      const request = pendingCapture;
      if (request?.kind === 'live' && state.result?.requestId === request.requestId) {
        if (state.result.error) cancelPendingCapture(state.result.error);
        else applyCapture(state.result.snapshot, request);
      } else if (!captureConnected && request?.kind === 'live') cancelPendingCapture('游戏页未连接，原输入已保留，请重新连接。');
    } catch (error) {
      captureConnected = false; updateCaptureConnection();
      if (pendingCapture?.kind === 'live') cancelPendingCapture(error.message);
    } finally {
      statusBusy = false;
      const delay = pendingCapture?.kind === 'live' ? 250 : document.hidden ? 20000 : captureConnected ? 2000 : 5000;
      statusTimer = setTimeout(pollCaptureStatus, delay);
    }
  };
  const configureCapture = async () => {
    capture.token = null;
    try {
      const response = await fetch('/capture/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('本地服务尚未更新，请重启求解器服务。');
      const config = await response.json();
      if (!/^[a-f0-9]{64}$/.test(config.token ?? '')) throw new Error('本机采集配对码无效，请重启服务。');
      capture.token = config.token;
      await pollCaptureStatus();
    } catch (error) { captureConnected = false; updateCaptureConnection(); captureFeedback(error.message, true); }
  };
  void configureCapture();
  document.addEventListener('visibilitychange', () => { void pollCaptureStatus(); });
  $('#capture-auto').addEventListener('change', () => {
    cancelPendingCapture('填入方式已改变，请重新抓取。'); synchronize(); updateCaptureConnection();
  });
  $('#capture-target').addEventListener('change', () => { cancelPendingCapture('目标组已改变，请重新抓取。'); refreshCaptureTargets(); });
  $('#capture-current').addEventListener('click', async () => {
    if (!updateCaptureConnection()) return;
    const request = beginCapture('live');
    try { await capture.relayRequest('request', { method: 'POST', body: JSON.stringify({ requestId: request.requestId }) }); void pollCaptureStatus(); }
    catch (error) { if (pendingCapture === request) cancelPendingCapture(error.message); }
  });
  $('#capture-undo').addEventListener('click', () => {
    try {
      const input = readInput();
      const backup = captureUndo;
      if (!backup) return;
      const { waveIndex, groupIndex, previous, applied } = backup;
      if (backup.kind === 'reset') {
        if (JSON.stringify(input.waves) !== JSON.stringify(backup.appliedWaves)) throw new Error('重置后敌军或条件已有其他修改，未撤销，以免覆盖你的新输入。');
        input.waves = structuredClone(backup.previousWaves);
      } else {
        if (JSON.stringify(captureGroup(input, waveIndex, groupIndex)) !== JSON.stringify(applied)) {
          throw new Error('目标组已有其他修改，未撤销，以免覆盖你的新输入。');
        }
        if (backup.structure) undoCaptureExpansion(input, backup.structure, waveIndex);
        if (previous) {
          input.waves[waveIndex].enemies.splice(groupIndex * 4, 4, ...previous.enemies);
          input.waves[waveIndex].groupConditions[groupIndex] = previous.condition;
        }
      }
      stop(); restore(input);
      saveCaptureUndo(null);
      $('#planner').dispatchEvent(new Event('input'));
      const select = $('#capture-target'), target = `${waveIndex}:${groupIndex}`;
      select.value = [...select.options].some(option => option.value === target) ? target : select.options[select.options.length - 1].value;
      refreshCaptureTargets(); updateCaptureConnection();
      $('#result-panel').innerHTML = '<p class="section-note">已撤销，请按当前输入重新计算。</p>';
      captureFeedback(backup.kind === 'reset' ? '已撤销重置，恢复之前的行动敌军与条件。' : `已撤销第${waveIndex + 1}波第${groupIndex + 1}组的上次抓取。`);
    } catch (error) { captureFeedback(error.message, true); }
  });
  $('#reset-action').addEventListener('click', () => {
    const input = readInput(), previousWaves = input.waves;
    cancelPendingCapture(); stop();
    input.waves = [{ enemies: Array.from({ length: 4 }, blankEnemy), groupConditions: [{}] }];
    restore(input);
    saveCaptureUndo({ kind: 'reset', previousWaves, appliedWaves: readInput().waves });
    $('#planner').dispatchEvent(new Event('input'));
    $('[data-wave="0"]').open = true;
    $('#capture-target').value = '0:0'; refreshCaptureTargets(); updateCaptureConnection();
    $('#result-panel').innerHTML = '<div class="empty-result"><h2>行动已重置</h2><p>从阶段1据点1重新抓取。卡牌、生命、库存和计算设置已保留。</p></div>';
    captureFeedback('已重置为第一阶段第一组，资源与设置已保留；可点击“撤销重置”恢复。');
  });
  $('#capture-copy-script').addEventListener('click', async () => {
    try {
      const response = await fetch('game-capture.js');
      if (!response.ok) throw new Error('采集脚本读取失败，请重新启动服务。');
      await configureCapture();
      if (!capture.token) throw new Error('本机采集配对失败，请重启服务后再复制。');
      const script = `globalThis.PacificFrontCaptureToken = ${JSON.stringify(capture.token)};\n${await response.text()}`;
      $('#capture-script').value = script;
      try { await navigator.clipboard.writeText(script); captureFeedback('采集脚本已复制。请在游戏页控制台粘贴运行，再点击游戏页右下角连接按钮。'); }
      catch { $('#capture-script').hidden = false; $('#capture-script').focus(); $('#capture-script').select(); captureFeedback('浏览器未允许复制，请在下方脚本框全选并手动复制。'); }
    } catch (error) { captureFeedback(error.message, true); }
  });
  $('#capture-file-button').addEventListener('click', () => $('#capture-file').click());
  $('#capture-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const request = beginCapture('file');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('文件超过5MB，请使用当前据点的页面HTML。');
      const html = await file.text();
      if (pendingCapture !== request) return;
      // template 内容保持惰性，不执行样本脚本、不把样本节点插入页面。
      const template = document.createElement('template');
      template.innerHTML = html;
      applyCapture(capture.readSnapshot(template.content), request);
    } catch (error) { if (pendingCapture === request) { cancelPendingCapture(); captureFeedback(error.message, true); } }
  });
}

try {
  const responses = await Promise.all([fetch('data/cards.json'), fetch('data/items.json')]);
  if (responses.some(response => !response.ok)) throw new Error('数据库加载失败，请重新启动本地网页。');
  [catalog, items] = await Promise.all(responses.map(response => response.json()));
  renderInputs();
  try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) restore(JSON.parse(saved)); } catch { /* Input remains usable when browser storage is unavailable. */ }
  synchronize(false);
  setupCapture();
  $('#planner').addEventListener('input', event => {
    if (event.target.closest('#capture-tools')) return;
    cancelPendingCapture('输入已改变，原请求已取消，请重新抓取。');
    if (event.target.matches('.wave-size')) {
      const waves = readInput().waves;
      const index = Number(event.target.closest('[data-wave]').dataset.wave);
      const size = Number(event.target.value);
      waves[index].enemies = Array.from({ length: size }, (_, position) => waves[index].enemies[position] ?? blankEnemy());
      waves[index].groupConditions = Array.from({ length: size / 4 }, (_, position) => waves[index].groupConditions[position] ?? { global: {} });
      renderWaves(waves);
    }
    if (event.target.closest('.weakness-list') && event.target.checked && event.target.closest('.weakness-list').querySelectorAll('input:checked').length > 2) {
      event.target.checked = false; error('每个敌军最多勾选两种弱点。');
    }
    if (worker) { stop(); $('#result-panel').innerHTML = '<p class="section-note">输入已改变，请重新计算。</p>'; }
    else if (!dirty && $('#result-panel').querySelector('.result-header')) { $('#result-panel').innerHTML = '<p class="section-note">输入已改变，上一份结果已失效，请重新计算。</p>'; }
    dirty = true; synchronize();
  });
  $('#add-wave').addEventListener('click', () => {
    const waves = readInput().waves;
    if (waves.length >= 6) return;
    waves.push({ enemies: Array.from({ length: 4 }, blankEnemy) });
    renderWaves(waves); $('#planner').dispatchEvent(new Event('input'));
    const details = document.querySelector('[data-wave]:last-child'); details.open = true;
  });
  $('#remove-wave').addEventListener('click', () => {
    const waves = readInput().waves;
    if (waves.length <= 1) return;
    waves.pop(); renderWaves(waves); $('#planner').dispatchEvent(new Event('input'));
  });
  $('#select-all').addEventListener('click', () => { document.querySelectorAll('.card-owned').forEach(input => { input.checked = true; }); $('#planner').dispatchEvent(new Event('input')); });
  $('#clear-cards').addEventListener('click', () => { document.querySelectorAll('.card-owned').forEach(input => { input.checked = false; }); $('#planner').dispatchEvent(new Event('input')); });
  $('#type-filters').addEventListener('click', event => { const button = event.target.closest('[data-type]'); if (button) { filter = button.dataset.type; $('#type-filters').querySelectorAll('button').forEach(entry => entry.classList.toggle('active', entry === button)); synchronize(false); } });
  $('#demo').addEventListener('click', () => {
    stop();
    restore({ waves: [8, 4].map(count => ({ enemies: Array.from({ length: count }, (_, index) => ({ power: [90, 100, 110, 100][index % 4], active: true, weaknesses: index % 2 ? ['debuff_single_shell', 'debuff_three_shells'] : ['debuff_plane', 'debuff_vertical_lines'] })) })),
      cards: ['north_carolina', 'king_george_v', 'helldiver_essex', 'johnston', 'corsair_essex', 'baltimore', 'alaska', 'laffey'].map(cardId => ({ cardId, health: 3 })),
      inventory: Object.fromEntries(items.items.map(item => [item.id, ['standard_firepower', 'standard_buff_amplifier', 'special_debuff_amplifier'].includes(item.id) ? 1 : 0])),
      model: { globalStacking: 'multiply', rounding: 'conservative', allowEqual: false, revive: false }, beamWidth: 900 });
    synchronize(); dirty = true; $('#result-panel').innerHTML = '<div class="empty-result"><h2>示例已载入</h2><p>这是一组演示输入，可以直接计算或继续修改。</p></div>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#planner').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const input = readInput(true);
      if (!input.cards.length) throw new Error('请先勾选你的可用卡牌。');
      stop(); synchronize(); dirty = false;
      $('#calculate').disabled = true; $('#cancel').hidden = false; $('#pause').hidden = false; $('#pause').textContent = '暂停计算';
      $('#result-panel').setAttribute('aria-busy', 'true');
      $('#result-panel').innerHTML = '<div class="empty-result"><h2>正在比较阵容与道具组合</h2><div class="progress-bar"><span></span></div><p id="progress-text">计算不会改变游戏或扣减库存。</p><p id="budget-text">正在启动计算……</p></div>';
      $('#result-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      worker = new Worker('worker.js', { type: 'module' });
      const job = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== job) return;
        if (data.type === 'progress') $('#progress-text').textContent = `${data.progress.phase === 'repair' ? `重新分配同波用卡 ${data.progress.attempt}/4 · ` : data.progress.phase === 'healing' ? `提前回血重试 ${data.progress.attempt}/12 · ` : ''}第${data.progress.wave}波 / 第${data.progress.group}组 · 阵位搜索${data.progress.stage}/4 · 已完成${data.progress.completedGroups}/${data.progress.totalGroups}组`;
        if (data.type === 'budget') $('#budget-text').textContent = `已计算 ${(data.elapsedMs / 1000).toFixed(1)} 秒${input.computeBudget ? ` / ${input.computeBudget} 秒预算` : ' · 不限计算时间'}（暂停与让出时间不计入）`;
        if (data.type === 'paused') {
          $('#result-panel').classList.toggle('compute-paused', data.paused);
          $('#progress-text').textContent = data.paused ? (manuallyPaused ? '已暂停，点击“继续计算”接着搜索。' : '页面已转入后台，计算暂停；返回后继续。') : '已继续，正在接着原进度搜索……';
        }
        if (data.type === 'result') { stop(); renderResult(data.result); }
        if (data.type === 'error') error(data.message);
      };
      worker.onerror = () => { if (worker === job) error('计算进程未能运行，请重新启动本地网页后再试。'); };
      worker.postMessage({ input, catalog, items, beamWidth: input.beamWidth });
      updateSolverPause();
    } catch (failure) { error(failure.message); }
  });
  $('#cancel').addEventListener('click', () => { stop(); $('#result-panel').innerHTML = '<p class="section-note">已取消。输入和库存均已保留。</p>'; });
  $('#pause').addEventListener('click', () => { manuallyPaused = !manuallyPaused; updateSolverPause(); });
  document.addEventListener('visibilitychange', updateSolverPause);
} catch (failure) { error(failure.message); $('#calculate').disabled = true; }
