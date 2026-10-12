import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createCaptureRelay } from './capture-relay.mjs';
import './game-capture.js';

// 使用现有浏览器运行时，不给项目新增 npm 依赖。
const script = await readFile(new URL('./game-capture.js', import.meta.url), 'utf8');
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CAPTURE_BROWSER ? { executablePath: process.env.CAPTURE_BROWSER } : {}) });
});
after(async () => { await browser?.close(); });

async function withSample(file, run) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.abort());
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
    const html = await readFile(new URL(file, import.meta.url), 'utf8');
    await page.evaluate(html => {
      const template = document.createElement('template');
      template.innerHTML = html;
      window.sample = template.content;
    }, html);
    return await run(page);
  } finally { await page.close(); }
}

test('据点1读取四敌军与弱点，不把奖励当战力', async () => {
  await withSample('./html/关键据点1.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [136, 145, 146, 130]);
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.weaknesses), [
      ['debuff_three_shells', 'debuff_plane'], ['debuff_vertical_lines', 'debuff_ring_projectile'],
      ['debuff_ring_projectile', 'debuff_single_shell'], ['debuff_ring_projectile', 'debuff_single_shell'],
    ]);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
  });
});

test('据点2只读取区域12%，忽略指定条件', async () => {
  await withSample('./html/关键据点2.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.condition.global, { firepower: 0.12, survivability: 0, mobility: 0.12 });
    assert.equal(snapshot.source.stage, 1);
    assert.equal(snapshot.source.keypoint, 1);
  });
});

test('据点4忽略带入，只录入区域火力24%', async () => {
  await withSample('./html/关键据点4.html', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.condition.global, { firepower: 0.24, survivability: 0, mobility: 0 });
    assert.equal(snapshot.source.stage, 2);
    assert.equal(snapshot.source.keypoint, 4);
  });
});

test('区域敌方战力提升直接使用已提升数值，不重复放大', async () => {
  await withSample('./html/关键区域5.txt', async page => {
    const snapshot = await page.evaluate(() => {
      // 模拟未放置我方阵容的页面；设定数值不是原样本战斗前战力的推断。
      const board = sample.querySelector('[class*="_enemies_"]');
      const powers = [...board.querySelectorAll('[class*="_powerValue_"]')];
      powers.forEach((node, index) => { node.className = '_powerValue_1i76f_345'; node.textContent = String([108, 216, 324, 432][index]); });
      board.querySelectorAll('[class*="_damage"]').forEach(node => { node.className = '_vuln_1i76f_261'; });
      return PacificFrontCapture.readSnapshot(sample);
    });
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [108, 216, 324, 432]);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(snapshot.source.enemyPowerIncrease, 0.08);
  });
});

test('已经受我方减益的敌军战力拒绝当作初始值导入', async () => {
  await withSample('./html/关键区域5.txt', async page => {
    const error = await page.evaluate(() => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { return error.message; } });
    assert.match(error, /我方减益/);
  });
});

test('带入敌方提升缺少原战力时拒绝倒推取整后的数值', async () => {
  await withSample('./html/关键区域5.txt', async page => {
    const error = await page.evaluate(() => {
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      header.textContent = '带入';
      try { PacificFrontCapture.readSnapshot(sample); } catch (error) { return error.message; }
    });
    assert.match(error, /带入.*原战力/);
  });
});

test('区域敌方提升来源记录随目标组保存，不变成额外计算倍率', async () => {
  await withSample('./html/关键据点1.txt', async page => {
    const result = await page.evaluate(() => {
      const snapshot = PacificFrontCapture.readSnapshot(sample);
      snapshot.source.enemyPowerIncrease = 0.08;
      const input = { waves: [{ enemies: snapshot.enemies, groupConditions: [{ global: { firepower: 0.5 } }] }], cards: [], inventory: {} };
      return PacificFrontCapture.mergeSnapshot(input, 0, 0, snapshot);
    });
    assert.deepEqual(result.waves[0].enemies.map(enemy => enemy.power), [136, 145, 146, 130]);
    assert.equal(result.waves[0].groupConditions[0].captureSource.enemyPowerIncrease, 0.08);
    assert.deepEqual(result.waves[0].groupConditions[0].global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(result.waves[0].groupConditions[0].enemyPowerIncrease, undefined);
  });
});

test('未知弱点和未知区域条件拒绝读取', async () => {
  await withSample('./html/关键据点2.txt', async page => {
    const failures = await page.evaluate(() => {
      const errors = [];
      const icon = sample.querySelector('[class*="_enemies_"] [class*="_vulnIcon_"]');
      const original = icon.className;
      icon.className = '_vulnIcon_x_1 _unknown_x_1';
      try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); }
      icon.className = original;
      const region = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域').nextElementSibling;
      region.append(document.createTextNode('未知效果'));
      try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); }
      return errors;
    });
    assert.match(failures[0], /弱点/);
    assert.match(failures[1], /区域/);
  });
});

test('只替换目标组，保留资源和其他组，并清空旧条件', async () => {
  await withSample('./html/关键据点1.txt', async page => {
    const result = await page.evaluate(() => {
      const input = { waves: [{ enemies: Array.from({ length: 8 }, () => ({ active: true, power: 999, weaknesses: [] })),
        groupConditions: [{ global: { firepower: 0.5 } }, { global: { mobility: 0.5 }, buffsDisabled: true }] }],
        cards: [{ cardId: 'missouri', health: 2 }], inventory: { special_restore_health: 7 }, model: { revive: false } };
      const merged = PacificFrontCapture.mergeSnapshot(input, 0, 1, PacificFrontCapture.readSnapshot(sample));
      return { input, merged };
    });
    assert.equal(result.input.waves[0].enemies[4].power, 999);
    assert.equal(result.merged.waves[0].enemies[0].power, 999);
    assert.deepEqual(result.merged.waves[0].enemies.slice(4).map(enemy => enemy.power), [136, 145, 146, 130]);
    assert.deepEqual(result.merged.cards, result.input.cards);
    assert.deepEqual(result.merged.inventory, result.input.inventory);
    assert.deepEqual(result.merged.model, result.input.model);
    assert.equal(result.merged.waves[0].groupConditions[1].buffsDisabled, false);
    assert.deepEqual(result.merged.waves[0].groupConditions[1].global, { firepower: 0, survivability: 0, mobility: 0 });
  });
});

async function withPlanner(run) {
  const relay = createCaptureRelay(globalThis.PacificFrontCapture.validateSnapshot);
  const relayServer = http.createServer(async (request, response) => { if (!await relay(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve));
  const relayOrigin = `http://127.0.0.1:${relayServer.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const staticFiles = new Set(['index.html', 'app.js', 'solver.js', 'worker.js', 'styles.css', 'game-capture.js', 'data/cards.json', 'data/items.json']);
  const contentTypes = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = url.pathname.slice(1) || 'index.html';
    if (url.origin !== 'http://127.0.0.1:8765' || !staticFiles.has(file)) return route.abort();
    await route.fulfill({ status: 200, contentType: contentTypes[file.split('.').at(-1)] + '; charset=utf-8',
      body: await readFile(new URL(file, import.meta.url)) });
  });
  await context.route('http://127.0.0.1:8765/capture/**', async route => {
    const url = new URL(route.request().url());
    const headers = { ...route.request().headers(), host: new URL(relayOrigin).host };
    if (headers.origin === 'http://127.0.0.1:8765') headers.origin = relayOrigin;
    const response = await route.fetch({ url: `${relayOrigin}${url.pathname}${url.search}`, headers });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:8765/');
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 30);
    assert.ok((await page.evaluate(() => [...document.querySelectorAll('[data-item]')].map(input => Number(input.value))))
      .every(quantity => quantity === 0), '公开版首次打开时库存必须为0');
    const itemCatalog = JSON.parse(await readFile(new URL('./data/items.json', import.meta.url), 'utf8'));
    await page.evaluate(items => {
      const enemy = () => ({ active: true, power: 777, rawPower: '777', weaknesses: ['debuff_plane'] });
      const condition = () => ({ global: { firepower: 0.5, survivability: 0, mobility: 0.2 }, buffsDisabled: true,
        debuffsDisabled: false, buffsReduced: false, debuffsReduced: false, allowedTypes: ['battleship'] });
      localStorage.setItem('pacific-front-planner-v1', JSON.stringify({
        waves: [8, 4].map(count => ({ enemies: Array.from({ length: count }, enemy), groupConditions: Array.from({ length: count / 4 }, condition) })),
        cards: [{ cardId: 'missouri', health: 2 }], inventory: Object.fromEntries(items.map(item => [item.id, 6])),
        model: { globalStacking: 'multiply', rounding: 'conservative', allowEqual: false, revive: false }, beamWidth: 900,
      }));
    }, itemCatalog.items);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#capture-target').options.length === 3);
    await page.locator('#planner').dispatchEvent('input');
    await run(page, context);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); relayServer.closeAllConnections(); await new Promise(resolve => relayServer.close(resolve)); }
}

const savedInput = page => page.evaluate(() => JSON.parse(localStorage.getItem('pacific-front-planner-v1')));
const pairedScript = async page => `globalThis.PacificFrontCaptureToken = ${JSON.stringify(await page.evaluate(async () => (await (await fetch('/capture/config')).json()).token))};\n${script}`;

test('页面文件导入、自动下一组、撤销以及资源修改保留', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键据点1.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [136, 145, 146, 130]);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.equal(imported.waves[0].groupConditions[1].buffsDisabled, false);
    assert.equal(await page.locator('#capture-target').inputValue(), '1:0');
    await page.locator('[aria-label="USS密苏里当前生命"]').selectOption('1');
    await page.locator('#capture-undo').click();
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已撤销'));
    const undone = await savedInput(page);
    assert.deepEqual(undone.waves, before.waves);
    assert.equal(undone.cards[0].health, 1);
    assert.deepEqual(undone.inventory, before.inventory);
  });
});

test('区域敌方战力提升的页面导入与来源说明刷新后保留', async () => {
  await withPlanner(async page => {
    const html = await readFile(new URL('./html/关键区域5.txt', import.meta.url), 'utf8');
    const beforeBattle = await page.evaluate(html => {
      const template = document.createElement('template'); template.innerHTML = html;
      const board = template.content.querySelector('[class*="_enemies_"]');
      board.querySelectorAll('[class*="_powerValue_"]').forEach((node, index) => {
        node.className = '_powerValue_1i76f_345'; node.textContent = String([108, 216, 324, 432][index]);
      });
      board.querySelectorAll('[class*="_damage"]').forEach(node => { node.className = '_vuln_1i76f_261'; });
      return template.innerHTML;
    }, html);
    await page.locator('#capture-file').setInputFiles({ name: 'enemy-boost-before.txt', mimeType: 'text/plain', buffer: Buffer.from(beforeBattle) });
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    assert.deepEqual((await savedInput(page)).waves[0].enemies.slice(0, 4).map(enemy => enemy.power), [108, 216, 324, 432]);
    assert.match(await page.locator('.capture-source').textContent(), /敌方战力＋8%.*已计入/);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.match(await page.locator('.capture-source').textContent(), /敌方战力＋8%.*已计入/);
  });
});

test('刷新保留采集来源和回退记录，未知条件不覆盖输入', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键据点4.html', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#capture-undo').disabled);
    assert.match(await page.locator('.capture-source').textContent(), /阶段2.*关键据点4/);
    assert.deepEqual((await savedInput(page)).waves[0].groupConditions[0].global, { firepower: 0.24, survivability: 0, mobility: 0 });
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
    const badHtml = (await readFile(new URL('./html/关键据点2.txt', import.meta.url), 'utf8')).replace('_firepower_11zg2_19 _standalone_', '_unknown_11zg2_19 _standalone_').replace('>火力</span>', '>未知属性</span>');
    await page.locator('#capture-file').setInputFiles({ name: 'unknown.html', mimeType: 'text/html', buffer: Buffer.from(badHtml) });
    await page.waitForFunction(() => document.querySelector('#capture-feedback').classList.contains('capture-error'));
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('错误来源不能建立连接，撤销不能覆盖目标组的后续手动修改', async () => {
  await withPlanner(async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://example.invalid', source: window,
      data: { channel: PacificFrontCapture.CHANNEL, type: 'ready' } })));
    assert.equal(await page.locator('#capture-current').isDisabled(), true);
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键据点1.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    await page.locator('[aria-label="第1波敌军1总战力"]').fill('1234');
    const manuallyChanged = await savedInput(page);
    await page.locator('#capture-undo').click();
    assert.match(await page.locator('#capture-feedback').textContent(), /已有其他修改/);
    assert.deepEqual(await savedInput(page), manuallyChanged);
  });
});

test('游戏页与求解器通过本机服务完成按钮抓取', async () => {
  await withPlanner(async (page, context) => {
    const before = await savedInput(page);
    const html = (await readFile(new URL('./html/关键据点2.txt', import.meta.url), 'utf8')).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    await context.route('https://pacificfront.worldofwarships.asia/zh-sg/operations/capture-test', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const game = await context.newPage();
    await game.goto('https://pacificfront.worldofwarships.asia/zh-sg/operations/capture-test');
    await game.addScriptTag({ content: await pairedScript(page) });
    const [planner] = await Promise.all([game.waitForEvent('popup'), game.locator('#pacific-front-capture-bridge button').click()]);
    await planner.waitForFunction(() => document.querySelector('#capture-current') && !document.querySelector('#capture-current').disabled);
    await planner.locator('#capture-target').selectOption('0:1');
    await planner.locator('#capture-current').click();
    await planner.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(planner);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [88, 109, 123, 95]);
    assert.deepEqual(imported.waves[0].groupConditions[1].global, { firepower: 0.12, survivability: 0, mobility: 0.12 });
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.equal(await planner.locator('#capture-target').inputValue(), '1:0');
    const after = await savedInput(planner);
    await planner.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://example.invalid', source: window,
      data: { channel: PacificFrontCapture.CHANNEL, type: 'ready' } })));
    assert.deepEqual(await savedInput(planner), after);
  });
});

test('窗口隔离策略下仍能连接并抓取当前据点', async () => {
  await withPlanner(async (page, context) => {
    const html = (await readFile(new URL('./html/关键据点4.html', import.meta.url), 'utf8')).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    await context.route('https://pacificfront.worldofwarships.asia/zh-sg/operations/isolated-test', route => route.fulfill({ status: 200,
      headers: { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin' }, body: html }));
    const game = await context.newPage();
    await game.goto('https://pacificfront.worldofwarships.asia/zh-sg/operations/isolated-test');
    await game.addScriptTag({ content: await pairedScript(page) });
    const [planner] = await Promise.all([game.waitForEvent('popup'), game.locator('#pacific-front-capture-bridge button').click()]);
    try {
      await planner.waitForFunction(() => document.querySelector('#capture-current') && !document.querySelector('#capture-current').disabled, null, { timeout: 10000 });
    } catch (error) {
      throw new Error(`窗口隔离复现：${await game.locator('#pacific-front-capture-bridge p').textContent()}`, { cause: error });
    }
    await planner.locator('#capture-current').click();
    await planner.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    assert.deepEqual((await savedInput(planner)).waves[0].groupConditions[0].global, { firepower: 0.24, survivability: 0, mobility: 0 });
  });
});
