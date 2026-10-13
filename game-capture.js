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

  function readRegion(root) {
    const container = one(root, '_conditions_', '战场条件');
    const condition = blankCondition();
    const result = { condition, enemyPowerIncrease: 0, ignoredEnemyPowerIncrease: 0 };
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
    for (const header of headers.filter(node => text(node) === '带入')) {
      const body = header.nextElementSibling;
      check(body && hasClass(body, '_bodyZone_'), '带入条件内容不完整，未导入。');
      const active = enemyRows(body).filter(row => !nodes(row, '_struckText_').length && enemyRate(row) > 0);
      check(active.length <= 1 && !(active.length && result.ignoredEnemyPowerIncrease), '多项带入敌方提升的叠加规则尚未核对，未导入。');
      if (active.length) {
        const rate = enemyRate(active[0]);
        // shortcut: 两组实测仅核对了8%与整数战力，其他比例收到数据后扩展。
        check(rate === 0.08, '带入敌方提升比例尚未核对，未导入；请提供提升前后的战力。');
        result.ignoredEnemyPowerIncrease = rate;
      }
    }
    const regions = headers.filter(node => text(node) === '区域');
    check(regions.length <= 1, '存在多个区域条件栏目，未导入。');
    // 用户确认全域是下一关带入；与指定一起忽略，只录入当前区域。
    if (!regions.length) return result;
    const body = regions[0].nextElementSibling;
    check(body && hasClass(body, '_bodyZone_'), '区域条件内容缺失，请等待页面更新后重试。');
    const rows = nodes(body, '_statRow_');
    const statIds = { 火力: 'firepower', 存活性: 'survivability', 机动性: 'mobility' };
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
      check(stat && !seen.has(stat) && /^-\d+(?:\.\d+)?%$/.test(valueText), `无法识别区域条件“${text(row)}”，未导入。`);
      const rate = -Number(valueText.slice(0, -1)) / 100;
      check(rate >= 0 && rate <= 1, '区域属性下降比例必须在0%至100%之间。');
      condition.global[stat] = rate;
      seen.add(stat);
    }
    const boosts = enemyRows(body);
    check(boosts.length <= 1, '存在多项敌方战力提升，未导入。');
    if (boosts.length) result.enemyPowerIncrease = enemyRate(boosts[0]);
    check(!(result.enemyPowerIncrease && result.ignoredEnemyPowerIncrease), '区域与带入敌方提升的叠加及取整规则尚未核对，未导入。');
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
        const filename = (icon.getAttribute('src') ?? '').split('/').pop();
        const match = filename.match(/^icon_([a-z]+)_standard-[\w-]+\.webp(?:[?#].*)?$/);
        const type = /^card_ship_plane-[\w-]+\.webp(?:[?#].*)?$/.test(filename) ? 'aircraft' : match?.[1];
        check(UNIT_TYPES.includes(type), '存在未知禁用单位类型图标，未导入。');
        return type;
      });
      check(new Set(banned).size === banned.length && text(section) === '禁用的单位类型', '禁用单位类型重复或包含未知内容，未导入。');
      condition.allowedTypes = UNIT_TYPES.filter(type => !banned.includes(type));
      check(condition.allowedTypes.length > 0, '所有单位类型均被禁用，当前求解器无法导入此限制。');
    }
    const remaining = body.cloneNode(true);
    nodes(remaining, '_statRow_').forEach(node => node.remove());
    enemyRows(remaining).forEach(node => node.remove());
    typeSections(remaining).forEach(node => node.remove());
    // shortcut: 仅核对过区域属性下降、敌方战力提升、禁用类型及禁用变项；其他效果收到样本后扩展。
    check(rows.length + boosts.length + restrictions.length > 0 && !text(remaining), '区域包含尚不支持的条件，未导入；请保留页面样本。');
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
      if (region.ignoredEnemyPowerIncrease) {
        check(hasClass(powerNode, '_buffed_'), `敌军${index + 1}缺少战力加成标记，未导入。`);
        check(Number.isInteger(power), `敌军${index + 1}战力不是已核对的整数，无法还原。`);
        const multiplier = 1 + region.ignoredEnemyPowerIncrease;
        const original = Math.round(power / multiplier);
        // 增幅大于1时，显示值的四舍五入误差除以增幅后小于0.5，可唯一恢复整数。
        check(Math.round(original * multiplier) === power, `敌军${index + 1}显示战力与已核对的取整规则不一致，无法还原。`);
        power = original;
      }
      return { active: true, power, weaknesses };
    });
    const stagePanel = one(root, '_stageInfo_', '阶段信息');
    const stage = text(one(stagePanel, '_title_', '阶段标题')).match(/^阶段\s*(\d+)$/);
    const keypoint = text(one(root, '_headerTitle_', '据点标题')).match(/^关键据点\s*(\d+)$/);
    check(stage && keypoint, '阶段或据点编号无法识别，未导入。');
    const snapshot = { version: 1, source: { action: text(one(root, '_pageHeaderTitle_', '行动名称')),
      stage: Number(stage[1]), keypoint: Number(keypoint[1]), ...(region.enemyPowerIncrease > 0 ? { enemyPowerIncrease: region.enemyPowerIncrease } : {}),
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
    check(source.enemyPowerIncrease === undefined || (Number.isFinite(source.enemyPowerIncrease * 100) &&
      typeof source.enemyPowerIncrease === 'number' && source.enemyPowerIncrease >= 0), '敌方战力提升来源记录无效。');
    check(source.ignoredEnemyPowerIncrease === undefined || (source.ignoredEnemyPowerIncrease === 0.08 && !source.enemyPowerIncrease),
      '带入敌方战力还原来源记录无效。');
    check(Array.isArray(snapshot.enemies) && snapshot.enemies.length === 4, '采集结果必须包含4个敌军。');
    const known = new Set(Object.values(WEAKNESSES));
    for (const enemy of snapshot.enemies) {
      check(enemy?.active === true && Number.isFinite(enemy.power) && enemy.power >= 0 && enemy.power <= 1000000,
        '采集敌军战力无效。');
      check(Array.isArray(enemy.weaknesses) && enemy.weaknesses.length <= 2 && new Set(enemy.weaknesses).size === enemy.weaknesses.length &&
        enemy.weaknesses.every(id => known.has(id)), '采集弱点无效或重复。');
    }
    const condition = snapshot.condition;
    check(condition && STATS.every(stat => Number.isFinite(condition.global?.[stat]) && condition.global[stat] >= 0 && condition.global[stat] <= 1) &&
      FLAGS.every(flag => condition[flag] === false), '采集区域条件无效或首版尚不支持。');
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
      rawPower: String(enemy.power), weaknesses: [...enemy.weaknesses] })));
    target.groupConditions ??= Array.from({ length: target.enemies.length / 4 }, blankCondition);
    target.groupConditions[groupIndex] = { ...blankCondition(), global: { ...snapshot.condition.global },
      allowedTypes: snapshot.condition.allowedTypes === null ? null : [...snapshot.condition.allowedTypes],
      itemsDisabled: snapshot.condition.itemsDisabled ?? false,
      globalInputs: STATS.map(stat => ({ stat, active: snapshot.condition.global[stat] > 0, percent: snapshot.condition.global[stat] * 100 })),
      captureSource: { action: snapshot.source.action, stage: snapshot.source.stage, keypoint: snapshot.source.keypoint,
        ...(snapshot.source.enemyPowerIncrease > 0 ? { enemyPowerIncrease: snapshot.source.enemyPowerIncrease } : {}),
        ...(snapshot.source.ignoredEnemyPowerIncrease > 0 ? { ignoredEnemyPowerIncrease: snapshot.source.ignoredEnemyPowerIncrease } : {}) } };
    return result;
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
    status.textContent = '连接后，在求解器选择目标组并抓取。只读取敌军和区域条件。';
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
      } finally { polling = false; if (connected && !disposed) timer = setTimeout(poll, 1000); }
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
  globalThis.PacificFrontCapture = { GAME_ORIGIN, PLANNER_ORIGIN, CHANNEL, token: pairingToken, relayRequest, readSnapshot, validateSnapshot, mergeSnapshot, installBridge };
  if (typeof location !== 'undefined' && location.origin === GAME_ORIGIN) installBridge();
})();
