// 可直接复制到游戏页控制台；本地页面也加载这份文件，共用读取和校验逻辑。
(() => {
  'use strict';
  const GAME_ORIGIN = 'https://pacificfront.worldofwarships.asia';
  const PLANNER_ORIGIN = 'http://127.0.0.1:8765';
  const CHANNEL = 'pacific-front-capture-v1';
  const pairingToken = globalThis.PacificFrontCaptureToken ?? null;
  delete globalThis.PacificFrontCaptureToken;
  const STATS = ['firepower', 'survivability', 'mobility'];
  const FLAGS = ['buffsDisabled', 'debuffsDisabled', 'buffsReduced', 'debuffsReduced'];
  const UNIT_TYPES = ['aircraft', 'battleship', 'cruiser', 'destroyer'];
  const ENEMY_TYPES = [...UNIT_TYPES, 'submarine', 'coastal_artillery', 'naval_mine'];
  const validPowerRate = rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
  const sameRate = (a, b) => Math.abs(a - b) < 1e-8;
  const TYPE_NAMES = { aircraft: '飞机', battleship: '战列舰', cruiser: '巡洋舰', destroyer: '驱逐舰', submarine: '潜艇', coastal_artillery: '岸防炮', naval_mine: '水雷' };
  const WEAKNESSES = {
    _antiAircraftFire_: 'debuff_vertical_lines', _detection_: 'debuff_concentric_target',
    _smokes_: 'debuff_ring_projectile', _largeCaliber_: 'debuff_single_shell',
    _quickFire_: 'debuff_three_shells', _strikeAircraft_: 'debuff_plane',
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const hasClass = (node, prefix) => [...node.classList].some(value => value.startsWith(prefix));
  const nodes = (root, prefix) => [...root.querySelectorAll(`[class*="${prefix}"]`)].filter(node => hasClass(node, prefix));
  const one = (root, prefix, label) => {
    const found = nodes(root, prefix);
    check(found.length === 1, `无法唯一识别${label}，请打开完整的据点配队页面后重试。`);
    return found[0];
  };
  const text = node => node.textContent.replace(/\s+/g, ' ').trim();
  const blankCondition = () => ({ global: { firepower: 0, survivability: 0, mobility: 0 },
    buffsDisabled: false, debuffsDisabled: false, buffsReduced: false, debuffsReduced: false, itemsDisabled: false, allowedTypes: null });
  const shipType = icon => {
    const filename = (icon.getAttribute('src') ?? '').split('/').pop();
    const match = filename.match(/^icon_([a-z]+)_standard-[\w-]+\.webp(?:[?#].*)?$/);
    const cardType = filename.match(/^card_ship_(plane|coastal_artillery|naval_mine)-[\w-]+\.webp(?:[?#].*)?$/)?.[1];
    return cardType === 'plane' ? 'aircraft' : cardType ?? match?.[1];
  };

  function checkBoostTotals(source) {
    for (const type of ENEMY_TYPES) {
      const carriedRate = source.ignoredEnemyPowerIncreases?.find(boost => boost.type === type)?.rate ?? 0;
      const regionalRate = source.enemyPowerIncreases?.find(boost => boost.type === type)?.rate ?? 0;
      check(validPowerRate((source.ignoredEnemyPowerIncrease ?? 0) + (source.enemyPowerIncrease ?? 0) + carriedRate + regionalRate),
        '敌方战力提升合计比例无效，未导入。');
    }
  }

  function addTypedBoost(boosts, type, rate) {
    const existing = boosts.find(boost => boost.type === type);
    if (existing) existing.rate += rate;
    else boosts.push({ type, rate });
  }

  function readRegion(root) {
    const container = one(root, '_conditions_', '战场条件');
    const condition = blankCondition();
    const result = { condition, enemyPowerIncrease: 0, ignoredEnemyPowerIncrease: 0, ignoredEnemyPowerIncreases: [] };
    if (hasClass(container, '_noConditions_')) {
      check(text(container) === '无战斗条件', '无战斗条件标记与内容不一致，请等待页面更新后重试。');
      return result;
    }
    const headers = nodes(container, '_subheader_');
    check(headers.length > 0 && headers.every(node => ['区域', '带入', '指定', '全域'].includes(text(node))), '存在无法识别的战场条件栏目，未导入。');
    const enemyRows = body => nodes(body, '_rowLabel_').filter(row => nodes(row, '_label_').some(label => text(label) === '敌方战力'));
    const enemyRate = row => {
      const value = text(one(row, '_pctValue_', '敌方战力提升比例')).replace(/\s/g, '');
      check(/^\+\d+(?:\.\d+)?%$/.test(value) && Number.isFinite(Number(value.slice(1, -1))), '敌方战力提升比例无法识别，未导入。');
      return Number(value.slice(1, -1)) / 100;
    };
    const typedSections = body => nodes(body, '_section_').filter(section =>
      nodes(section, '_label_').some(label => /^敌方战力[：:]$/.test(text(label))));
    const typedBoosts = body => {
      const sections = typedSections(body), boosts = [];
      for (const section of sections) {
        const rows = nodes(section, '_statRow_');
        check(rows.length > 0, '舰种战力提升内容缺失，未导入。');
        for (const row of rows) {
          const type = shipType(one(row, '_shipIcon_', '战力提升舰种图标'));
          check(ENEMY_TYPES.includes(type), '存在未知战力提升舰种图标，未导入。');
          check(row.querySelectorAll('img').length === 1 && text(one(row, '_statLabel_', '战力提升舰种名称')) === TYPE_NAMES[type],
            '战力提升舰种图标与名称不一致，未导入。');
          const rate = enemyRate(row);
          check(validPowerRate(rate) && rate > 0, '舰种战力提升比例必须是有效正数，未导入。');
          check(text(row) === `${TYPE_NAMES[type]}${text(one(row, '_pctValue_', '舰种战力提升比例'))}`, '舰种战力提升包含未知内容，未导入。');
          boosts.push({ row, type, rate });
        }
        const remaining = section.cloneNode(true);
        nodes(remaining, '_statRow_').forEach(node => node.remove());
        check(/^敌方战力[：:]$/.test(text(remaining)), '舰种战力提升包含未知内容，未导入。');
      }
      return boosts;
    };
    for (const header of headers.filter(node => text(node) === '带入')) {
      const body = header.nextElementSibling;
      check(body && hasClass(body, '_bodyZone_'), '带入条件内容不完整，未导入。');
      const typed = typedBoosts(body).filter(boost => !nodes(boost.row, '_struckText_').length);
      for (const { type, rate } of typed) {
        addTypedBoost(result.ignoredEnemyPowerIncreases, type, rate);
      }
      const active = enemyRows(body).filter(row => !nodes(row, '_struckText_').length && enemyRate(row) > 0);
      result.ignoredEnemyPowerIncrease += active.reduce((sum, row) => sum + enemyRate(row), 0);
    }
    const regions = headers.filter(node => text(node) === '区域');
    check(regions.length <= 1, '存在多个区域条件栏目，未导入。');
    // 用户确认全域是下一关带入；与指定一起忽略，只录入当前区域。
    if (!regions.length) return result;
    const body = regions[0].nextElementSibling;
    check(body && hasClass(body, '_bodyZone_'), '区域条件内容缺失，请等待页面更新后重试。');
    const typed = typedBoosts(body);
    if (typed.length) {
      result.enemyPowerIncreases = [];
      typed.forEach(({ type, rate }) => addTypedBoost(result.enemyPowerIncreases, type, rate));
    }
    const rows = nodes(body, '_statRow_').filter(row => !typed.some(boost => boost.row === row));
    const statIds = { 火力: 'firepower', 存活性: 'survivability', 机动性: 'mobility' };
    const effectFlags = {
      '增益效果-50%': 'buffsReduced', '增益效果-100%': 'buffsDisabled',
      '减益效果-50%': 'debuffsReduced', '减益效果-100%': 'debuffsDisabled',
    };
    const seen = new Set();
    for (const row of rows) {
      const label = text(one(row, '_statLabel_', '区域属性名称'));
      if (label === '禁用变项') {
        check(!condition.itemsDisabled && text(row) === label, '禁用变项条件重复或包含未知内容，未导入。');
        condition.itemsDisabled = true;
        continue;
      }
      const stat = statIds[label];
      const valueText = text(one(row, '_pctValue_', '区域属性下降比例')).replace(/\s/g, '').replace(/−/g, '-');
      if (label === '增益效果' || label === '减益效果') {
        const flag = effectFlags[`${label}${valueText}`];
        check(flag && !seen.has(label) && text(row).replace(/\s/g, '').replace(/−/g, '-') === `${label}${valueText}`,
          `无法识别区域条件“${text(row)}”，未导入。`);
        condition[flag] = true;
        seen.add(label);
        continue;
      }
      check(stat && !seen.has(stat) && /^-\d+(?:\.\d+)?%$/.test(valueText), `无法识别区域条件“${text(row)}”，未导入。`);
      const rate = -Number(valueText.slice(0, -1)) / 100;
      check(rate >= 0 && rate <= 1, '区域属性下降比例必须在0%至100%之间。');
      condition.global[stat] = rate;
      seen.add(stat);
    }
    const boosts = enemyRows(body);
    result.enemyPowerIncrease = boosts.reduce((sum, row) => sum + enemyRate(row), 0);
    checkBoostTotals(result);
    const typeSections = regionBody => nodes(regionBody, '_section_').filter(section =>
      nodes(section, '_label_').some(label => text(label) === '禁用的单位类型'));
    const restrictions = typeSections(body);
    check(restrictions.length <= 1, '存在多项禁用单位类型栏目，未导入。');
    if (restrictions.length) {
      const section = restrictions[0];
      const iconRow = one(section, '_iconsRow_', '禁用单位类型图标栏');
      const icons = nodes(iconRow, '_shipIcon_');
      check(icons.length > 0 && icons.length === iconRow.querySelectorAll('img').length &&
        icons.length === nodes(iconRow, '_iconTooltip_').length, '禁用单位类型图标缺失或不完整，未导入。');
      const banned = icons.map(icon => {
        const type = shipType(icon);
        check(UNIT_TYPES.includes(type), '存在未知禁用单位类型图标，未导入。');
        return type;
      });
      check(new Set(banned).size === banned.length && text(section) === '禁用的单位类型', '禁用单位类型重复或包含未知内容，未导入。');
      condition.allowedTypes = UNIT_TYPES.filter(type => !banned.includes(type));
      check(condition.allowedTypes.length > 0, '所有单位类型均被禁用，当前求解器无法导入此限制。');
    }
    const remaining = body.cloneNode(true);
    typedSections(remaining).forEach(node => node.remove());
    nodes(remaining, '_statRow_').forEach(node => node.remove());
    enemyRows(remaining).forEach(node => node.remove());
    typeSections(remaining).forEach(node => node.remove());
    // shortcut: 效果削弱仅支持已有模型的50%和100%；其他比例收到规则后扩展。
    check(rows.length + boosts.length + typed.length + restrictions.length > 0 && !text(remaining), '区域包含尚不支持的条件，未导入；请保留页面样本。');
    return result;
  }

  function readSnapshot(root) {
    const region = readRegion(root);
    const board = one(root, '_enemies_', '敌军阵列');
    const enemyCards = nodes(board, '_enemy_');
    check(enemyCards.length === 4, '当前据点必须完整显示4个敌军，未导入。');
    const enemies = enemyCards.map((card, index) => {
      const powerNode = one(card, '_powerValue_', `敌军${index + 1}战力`);
      const powerText = text(powerNode);
      check(/^\d+(?:\.\d+)?$/.test(powerText), `敌军${index + 1}战力尚未显示完整。`);
      const weaknessContainer = one(card, '_vulns_', `敌军${index + 1}弱点栏`);
      check(!hasClass(powerNode, '_debuffed_') && !nodes(weaknessContainer, '_damage').some(node =>
        [...node.classList].some(value => /^_damage[1-9]\d*_/.test(value))),
      `敌军${index + 1}战力已受我方减益影响，未导入。请先移除当前上阵阵容，或使用未部署阵容的战斗前页面。`);
      const icons = nodes(weaknessContainer, '_vulnIcon_');
      check(nodes(weaknessContainer, '_vuln_').length === icons.length, `敌军${index + 1}弱点图标缺失。`);
      const weaknesses = icons.map(icon => {
        const matches = Object.entries(WEAKNESSES).filter(([prefix]) => hasClass(icon, prefix));
        check(matches.length === 1, `敌军${index + 1}存在未知弱点图标，未导入。`);
        return matches[0][1];
      });
      let power = Number(powerText);
      let regionalRate = region.enemyPowerIncrease;
      if (region.enemyPowerIncreases?.length) {
        const type = shipType(one(card, '_cardTypeIcon_', `敌军${index + 1}单位类型图标`));
        check(ENEMY_TYPES.includes(type), `敌军${index + 1}存在未知单位类型，无法识别区域战力增益。`);
        regionalRate += region.enemyPowerIncreases.find(boost => boost.type === type)?.rate ?? 0;
      }
      check(validPowerRate(regionalRate), '区域敌方提升合计比例无效，未导入。');
      let carriedRate = region.ignoredEnemyPowerIncrease;
      if (region.ignoredEnemyPowerIncreases.length) {
        const type = shipType(one(card, '_cardTypeIcon_', `敌军${index + 1}单位类型图标`));
        check(ENEMY_TYPES.includes(type), `敌军${index + 1}存在未知单位类型，无法还原带入战力。`);
        carriedRate += region.ignoredEnemyPowerIncreases.find(boost => boost.type === type)?.rate ?? 0;
      }
      if (carriedRate) {
        check(hasClass(powerNode, '_buffed_'), `敌军${index + 1}缺少战力加成标记，未导入。`);
        check(Number.isInteger(power), `敌军${index + 1}战力不是已核对的整数，无法还原。`);
        const multiplier = 1 + carriedRate + regionalRate;
        const original = Math.round(power / multiplier);
        // 增幅大于1时，显示值的四舍五入误差除以增幅后小于0.5，可唯一恢复整数。
        check(Math.round(original * multiplier) === power, `敌军${index + 1}显示战力与已核对的取整规则不一致，无法还原。`);
        // 带入与区域先合并还原原战力，再只保留区域增益；不能直接对显示值除以带入倍率。
        power = Math.round(original * (1 + regionalRate));
      }
      return { active: true, power, weaknesses,
        ...(region.enemyPowerIncrease || region.enemyPowerIncreases?.length ? { powerIncrease: regionalRate } : {}) };
    });
    const stagePanel = one(root, '_stageInfo_', '阶段信息');
    const stage = text(one(stagePanel, '_title_', '阶段标题')).match(/^阶段\s*(\d+)$/);
    const keypoint = text(one(root, '_headerTitle_', '据点标题')).match(/^关键据点\s*(\d+)$/);
    check(stage && keypoint, '阶段或据点编号无法识别，未导入。');
    const snapshot = { version: 1, source: { action: text(one(root, '_pageHeaderTitle_', '行动名称')),
      stage: Number(stage[1]), keypoint: Number(keypoint[1]), ...(region.enemyPowerIncrease > 0 ? { enemyPowerIncrease: region.enemyPowerIncrease } : {}),
      ...(region.enemyPowerIncreases ? { enemyPowerIncreases: region.enemyPowerIncreases } : {}),
      ...(region.ignoredEnemyPowerIncreases.length ? { ignoredEnemyPowerIncreases: region.ignoredEnemyPowerIncreases } : {}),
      ...(region.ignoredEnemyPowerIncrease > 0 ? { ignoredEnemyPowerIncrease: region.ignoredEnemyPowerIncrease } : {}) },
      enemies, condition: region.condition };
    validateSnapshot(snapshot);
    return snapshot;
  }

  function validateSnapshot(snapshot) {
    check(snapshot?.version === 1, '采集数据版本无效。');
    const source = snapshot.source;
    check(typeof source?.action === 'string' && source.action.length > 0 && source.action.length <= 100 &&
      Number.isInteger(source.stage) && source.stage >= 1 && source.stage <= 6 &&
      Number.isInteger(source.keypoint) && source.keypoint >= 1 && source.keypoint <= 30, '采集来源标识无效。');
    check(source.enemyPowerIncrease === undefined || validPowerRate(source.enemyPowerIncrease), '敌方战力提升来源比例无效。');
    const validTypedBoosts = boosts => Array.isArray(boosts) && boosts.length > 0 && boosts.length <= ENEMY_TYPES.length &&
      boosts.every(boost => ENEMY_TYPES.includes(boost?.type) && validPowerRate(boost.rate) && boost.rate > 0) &&
      new Set(boosts.map(boost => boost.type)).size === boosts.length;
    check(source.enemyPowerIncreases === undefined || validTypedBoosts(source.enemyPowerIncreases),
      '舰种战力提升来源记录无效。');
    check(source.ignoredEnemyPowerIncreases === undefined || validTypedBoosts(source.ignoredEnemyPowerIncreases),
      '带入舰种战力还原来源记录无效。');
    check(source.ignoredEnemyPowerIncrease === undefined || validPowerRate(source.ignoredEnemyPowerIncrease),
      '带入敌方战力还原来源记录无效。');
    checkBoostTotals(source);
    check(Array.isArray(snapshot.enemies) && snapshot.enemies.length === 4, '采集结果必须包含4个敌军。');
    const known = new Set(Object.values(WEAKNESSES));
    for (const enemy of snapshot.enemies) {
      check(enemy?.active === true && Number.isFinite(enemy.power) && enemy.power >= 0 && enemy.power <= 1000000,
        '采集敌军战力无效。');
      check(Array.isArray(enemy.weaknesses) && enemy.weaknesses.length <= 2 && new Set(enemy.weaknesses).size === enemy.weaknesses.length &&
        enemy.weaknesses.every(id => known.has(id)), '采集弱点无效或重复。');
      check(!source.enemyPowerIncreases || enemy.powerIncrease !== undefined, '采集缺少逐敌军的舰种增益比例，请重新采集。');
      const rate = enemy.powerIncrease ?? source.enemyPowerIncrease ?? 0;
      const globalRate = source.enemyPowerIncrease ?? 0;
      check(validPowerRate(rate) &&
        (rate === 0 || (Number.isInteger(enemy.power) && Math.round(Math.round(enemy.power / (1 + rate)) * (1 + rate)) === enemy.power)) &&
        (sameRate(rate, globalRate) || source.enemyPowerIncreases?.some(boost => sameRate(rate, globalRate + boost.rate))),
      '采集敌军区域战力增益无效或无法还原原战力。');
    }
    const condition = snapshot.condition;
    check(condition && STATS.every(stat => Number.isFinite(condition.global?.[stat]) && condition.global[stat] >= 0 && condition.global[stat] <= 1) &&
      FLAGS.every(flag => typeof condition[flag] === 'boolean'),
      '采集区域条件无效或尚不支持。');
    check(condition.allowedTypes === null || (Array.isArray(condition.allowedTypes) && condition.allowedTypes.length > 0 &&
      condition.allowedTypes.every(type => UNIT_TYPES.includes(type)) && new Set(condition.allowedTypes).size === condition.allowedTypes.length),
      '采集允许单位类型无效或重复。');
    check(condition.itemsDisabled === undefined || typeof condition.itemsDisabled === 'boolean', '采集禁用道具条件无效。');
  }

  function mergeSnapshot(input, waveIndex, groupIndex, snapshot) {
    validateSnapshot(snapshot);
    const wave = input.waves?.[waveIndex];
    check(Number.isInteger(waveIndex) && Number.isInteger(groupIndex) && waveIndex >= 0 && groupIndex >= 0 &&
      wave && (groupIndex + 1) * 4 <= wave.enemies.length, '目标组已不存在，请重新选择。');
    const result = structuredClone(input);
    const target = result.waves[waveIndex];
    target.enemies.splice(groupIndex * 4, 4, ...snapshot.enemies.map(enemy => ({ active: true, power: enemy.power,
      ...(enemy.powerIncrease !== undefined ? { powerIncrease: enemy.powerIncrease } : {}),
      rawPower: String(enemy.power), weaknesses: [...enemy.weaknesses] })));
    target.groupConditions ??= Array.from({ length: target.enemies.length / 4 }, blankCondition);
    target.groupConditions[groupIndex] = { ...blankCondition(), global: { ...snapshot.condition.global },
      ...Object.fromEntries(FLAGS.map(flag => [flag, snapshot.condition[flag]])),
      allowedTypes: snapshot.condition.allowedTypes === null ? null : [...snapshot.condition.allowedTypes],
      itemsDisabled: snapshot.condition.itemsDisabled ?? false,
      globalInputs: STATS.map(stat => ({ stat, active: snapshot.condition.global[stat] > 0, percent: snapshot.condition.global[stat] * 100 })),
      captureSource: { action: snapshot.source.action, stage: snapshot.source.stage, keypoint: snapshot.source.keypoint,
        ...(snapshot.source.enemyPowerIncrease > 0 ? { enemyPowerIncrease: snapshot.source.enemyPowerIncrease } : {}),
        ...(snapshot.source.enemyPowerIncreases ? { enemyPowerIncreases: snapshot.source.enemyPowerIncreases.map(({ type, rate }) => ({ type, rate })) } : {}),
        ...(snapshot.source.ignoredEnemyPowerIncreases ? { ignoredEnemyPowerIncreases: snapshot.source.ignoredEnemyPowerIncreases.map(({ type, rate }) => ({ type, rate })) } : {}),
        ...(snapshot.source.ignoredEnemyPowerIncrease > 0 ? { ignoredEnemyPowerIncrease: snapshot.source.ignoredEnemyPowerIncrease } : {}) } };
    return result;
  }

  function mergeAutoSnapshot(input, snapshot) {
    validateSnapshot(snapshot);
    const { action, stage, keypoint } = snapshot.source;
    const waveIndex = stage - 1;
    const records = (input.waves ?? []).flatMap((wave, index) => (wave.groupConditions ?? []).flatMap((condition, groupIndex) =>
      condition.captureSource ? [{ source: condition.captureSource, waveIndex: index, groupIndex }] : []));
    check(records.every(record => record.source.action === action), '已采集数据属于另一行动，请先重置行动，或切换手动填入。');
    check(records.every(record => record.source.stage === record.waveIndex + 1 && Number.isInteger(record.source.keypoint)),
      '已有采集来源与阶段位置不一致，请使用手动填入或重置后按顺序采集。');
    check(new Set(records.map(record => record.source.keypoint)).size === records.length, '已有重复据点来源，请核对后使用手动填入。');
    check(!records.some(record => record.source.keypoint === keypoint && record.source.stage !== stage), '据点编号与已采集阶段冲突，未填入。');
    const currentStage = records.filter(record => record.waveIndex === waveIndex);
    let offset = 0;
    if (currentStage.length) {
      const offsets = new Set(currentStage.map(record => record.source.keypoint - record.groupIndex - 1));
      check(offsets.size === 1, '本阶段据点来源与组位置不一致，请核对后使用手动填入。');
      offset = [...offsets][0];
      check(offset >= 0 && (stage !== 1 || offset === 0), '本阶段起始据点来源不一致，请核对后使用手动填入。');
    } else if (stage > 1) {
      const previousStage = records.filter(record => record.waveIndex === waveIndex - 1);
      check(previousStage.length > 0 && previousStage.every((record, i) => record.groupIndex === i &&
        record.source.keypoint === previousStage[0].source.keypoint + i), '尚不能确定阶段边界，请从阶段1据点1按顺序采集，或切换手动填入。');
      offset = previousStage.at(-1).source.keypoint;
      check(keypoint === offset + 1, `请先采集本阶段的首个据点（累计编号${offset + 1}），或切换手动填入。`);
    }
    const groupIndex = keypoint - offset - 1;
    check(groupIndex >= 0 && groupIndex < 5, '据点编号与阶段边界不符，或本阶段超过5组；请核对来源或使用手动填入。');
    const expanded = structuredClone(input);
    expanded.waves ??= [];
    const blankEnemy = () => ({ active: true, rawPower: '', weaknesses: [] });
    while (expanded.waves.length <= waveIndex) expanded.waves.push({ enemies: Array.from({ length: 4 }, blankEnemy), groupConditions: [blankCondition()] });
    const wave = expanded.waves[waveIndex];
    while (wave.enemies.length < (groupIndex + 1) * 4) wave.enemies.push(blankEnemy());
    wave.groupConditions = Array.from({ length: wave.enemies.length / 4 }, (_, index) => wave.groupConditions?.[index] ?? blankCondition());
    return { input: mergeSnapshot(expanded, waveIndex, groupIndex, snapshot), waveIndex, groupIndex };
  }

  async function relayRequest(path, options = {}) {
    const response = await fetch(`${PLANNER_ORIGIN}/capture/${path}`, { ...options, credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(8000), headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        'X-Capture-Token': globalThis.PacificFrontCapture.token } });
    let data;
    try { data = await response.json(); } catch { throw new Error('本地服务尚未更新，请重启求解器服务后重新复制脚本。'); }
    if (!response.ok) throw Object.assign(new Error(data.error ?? '本机采集连接失败。'), { status: response.status });
    return data;
  }

  function installBridge() {
    check(location.origin === GAME_ORIGIN, '请在亚洲服太平洋战线游戏页面运行采集脚本。');
    globalThis.PacificFrontCapture.dispose?.();
    let timer = null, connected = false, polling = false, disposed = false, lastRequestId = null;
    const clientId = crypto.randomUUID();
    const panel = document.createElement('div');
    panel.id = 'pacific-front-capture-bridge';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#11242e;color:#e4eceb;border:1px solid #84caba;border-radius:8px;padding:12px;width:270px;font:13px Microsoft YaHei,sans-serif;box-shadow:0 4px 20px #0008;';
    const button = document.createElement('button');
    button.textContent = '连接／打开本地求解器';
    button.style.cssText = 'cursor:pointer;background:#e7bf79;color:#18252b;border:0;border-radius:5px;padding:9px;width:100%;font:inherit;';
    const status = document.createElement('p');
    status.textContent = '连接后，在求解器抓取；默认按阶段和据点自动填入。只读取敌军和区域条件。';
    status.style.cssText = 'margin:10px 0 0;line-height:1.6;';
    panel.append(button, status);
    document.body.append(panel);
    const poll = async () => {
      if (!connected || polling || disposed) return;
      polling = true;
      try {
        const { requestId } = await relayRequest(`game?client=${encodeURIComponent(clientId)}`);
        if (requestId && requestId !== lastRequestId && !disposed) {
          lastRequestId = requestId;
          const result = { type: 'result', clientId, requestId };
          try {
            result.snapshot = readSnapshot(document);
            await new Promise(resolve => setTimeout(resolve, 180));
            check(JSON.stringify(result.snapshot) === JSON.stringify(readSnapshot(document)), '游戏页仍在切换或更新，请等待完成后重试。');
          } catch (error) { delete result.snapshot; result.error = error.message.slice(0, 250); }
          if (disposed) return;
          try {
            await relayRequest('game', { method: 'POST', body: JSON.stringify(result) });
            status.textContent = result.error ?? `已读取${result.snapshot.source.action} · 阶段${result.snapshot.source.stage} · 关键据点${result.snapshot.source.keypoint}。`;
          } catch (error) { if (error.status === 409) status.textContent = '上次请求已取消，保持连接，等待新的抓取。'; else throw error; }
        }
      } catch (error) {
        connected = false;
        status.textContent = error.message === 'Failed to fetch' ? '未能访问本机服务。请确认服务已启动及游戏页的本地网络访问权限；然后重新点击连接。' : error.message;
      } finally { polling = false; if (connected && !disposed) timer = setTimeout(poll, document.hidden ? 3000 : 1500); }
    };
    button.addEventListener('click', async () => {
      if (!/^[a-f0-9]{64}$/.test(globalThis.PacificFrontCapture.token ?? '')) {
        status.textContent = '请从更新后的求解器重新复制采集脚本，这份脚本缺少本次服务的配对码。'; return;
      }
      // 窗口隔离时返回引用可能显示closed；只打开页面，不用窗口引用判断连接。
      window.open(`${PLANNER_ORIGIN}/`, 'pacific-front-planner-capture');
      clearTimeout(timer);
      button.disabled = true;
      status.textContent = '正在连接本机服务；若浏览器询问本地网络访问，请确认是本机求解器的连接。';
      try {
        await relayRequest('game', { method: 'POST', body: JSON.stringify({ type: 'connect', clientId }) });
        if (disposed) return;
        connected = true;
        status.textContent = '本机服务已连接。手动切换据点，再到求解器点击抓取。';
        void poll();
      } catch (error) { connected = false; status.textContent = `${error.message}；请检查本机服务或浏览器的本地网络访问权限后重试。`; }
      finally { button.disabled = false; }
    });
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVisible);
    globalThis.PacificFrontCapture.dispose = () => {
      disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); panel.remove();
      if (connected) { connected = false; return relayRequest('game', { method: 'POST', body: JSON.stringify({ type: 'disconnect', clientId }), keepalive: true }).catch(() => {}); }
    };
  }

  globalThis.PacificFrontCapture?.dispose?.();
  globalThis.PacificFrontCapture = { GAME_ORIGIN, PLANNER_ORIGIN, CHANNEL, token: pairingToken, relayRequest, readSnapshot, validateSnapshot, mergeSnapshot, mergeAutoSnapshot, installBridge };
  if (typeof location !== 'undefined' && location.origin === GAME_ORIGIN) installBridge();
})();
