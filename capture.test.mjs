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

test('区域禁用战列舰转换为其余允许类型，并保留敌军数据', async () => {
  await withSample('./html/关键区域-存在禁用战舰.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [161, 125, 166, 169]);
    assert.deepEqual(snapshot.condition.allowedTypes, ['aircraft', 'cruiser', 'destroyer']);
    assert.equal(snapshot.source.stage, 3);
    assert.equal(snapshot.source.keypoint, 6);
  });
});

test('飞机图标命名格式与战列舰共同禁用，只允许巡洋舰和驱逐舰', async () => {
  await withSample('./html/关键区域-存在未知禁用单位图标.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [182, 188, 179, 166]);
    assert.deepEqual(snapshot.condition.allowedTypes, ['cruiser', 'destroyer']);
    assert.equal(snapshot.condition.debuffsReduced, false);
    assert.equal(snapshot.condition.itemsDisabled, false);
  });
});

test('两份禁用变项样本按实际区域栏目禁用道具，忽略带入舰种并还原8%', async () => {
  for (const file of ['./html/关键区域-区域禁用变项.txt', './html/关键区域-全域禁用变项.txt']) {
    await withSample(file, async page => {
      const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
      assert.equal(snapshot.condition.itemsDisabled, true);
      assert.equal(snapshot.condition.allowedTypes, null);
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [86, 113, 114, 95]);
    });
  }
});

test('全域是后续带入条件，不修改当前敌军、舰种或区域属性', async () => {
  await withSample('./html/关键区域-区域条件与全域条件不识别1.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [159, 143, 166, 162]);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0.12, mobility: 0.12 });
    assert.equal(snapshot.source.enemyPowerIncrease, undefined);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, undefined);
  });
  await withSample('./html/关键区域-全域不识别2.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [150, 151, 121, 126]);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(snapshot.condition.allowedTypes, null);
    assert.equal(snapshot.condition.itemsDisabled, false);
  });
});

test('禁用类型支持多个已知舰种，带入限制忽略，未知或缺失图标拒绝', async () => {
  await withSample('./html/关键区域-存在禁用战舰.txt', async page => {
    const results = await page.evaluate(() => {
      const row = sample.querySelector('[class*="_conditions_"] [class*="_iconsRow_"]');
      const extra = row.firstElementChild.cloneNode(true);
      extra.querySelector('img').setAttribute('src', '/assets/icon_cruiser_standard-test.webp'); row.append(extra);
      const multiple = PacificFrontCapture.readSnapshot(sample).condition.allowedTypes;
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      header.textContent = '带入';
      const carried = PacificFrontCapture.readSnapshot(sample).condition.allowedTypes;
      header.textContent = '区域';
      const errors = [];
      const run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (e) { errors.push(e.message); } };
      extra.querySelector('img').setAttribute('src', '/assets/icon_unknown_standard-test.webp'); run();
      row.replaceChildren(); run();
      return { multiple, carried, errors };
    });
    assert.deepEqual(results.multiple, ['aircraft', 'destroyer']);
    assert.equal(results.carried, null);
    assert.equal(results.errors.length, 2);
    assert.match(results.errors[0], /未知.*类型/);
    assert.match(results.errors[1], /类型图标.*缺失/);
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

test('区域舰种战力提升保留显示值，仅记录目标舰种与比例', async () => {
  for (const [file, type, powers] of [
    ['巡洋舰', 'cruiser', [181, 180, 157, 151]],
    ['驱逐舰', 'destroyer', [160, 164, 159, 159]],
  ]) {
    await withSample(`./html/关键区域-${file}战力提升.txt`, async page => {
      const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), powers);
      assert.deepEqual(snapshot.source.enemyPowerIncreases, [{ type, rate: 0.16 }]);
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.powerIncrease), type === 'cruiser' ? [0.16, 0.16, 0.16, 0] : [0.16, 0.16, 0.16, 0.16]);
      assert.equal(snapshot.source.enemyPowerIncrease, undefined);
      assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
      assert.equal(snapshot.condition.allowedTypes, null);
    });
  }
});

test('岸防炮敌军不受驱逐舰区域或带入加成影响，真正未知类型仍拒绝', async () => {
  await withSample('./html/关键区域-敌军3存在未知单位类型.txt', async page => {
    const regional = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(regional.enemies.map(enemy => enemy.power), [215, 202, 167, 175]);
    assert.deepEqual(regional.enemies.map(enemy => enemy.powerIncrease), [0.16, 0.16, 0, 0]);
    assert.deepEqual(regional.source.enemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }]);
    assert.deepEqual(regional.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(regional.source.stage, 3);
    assert.equal(regional.source.keypoint, 5);
    assert.equal(regional.enemies[2].weaknesses.length, 2);
    const carried = await page.evaluate(() => {
      [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域').textContent = '带入';
      return PacificFrontCapture.readSnapshot(sample);
    });
    assert.deepEqual(carried.enemies.map(enemy => enemy.power), [185, 174, 167, 175]);
    assert.deepEqual(carried.source.ignoredEnemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }]);
    assert.equal(carried.source.enemyPowerIncreases, undefined);
    const errors = await page.evaluate(() => {
      const icon = sample.querySelectorAll('[class*="_enemies_"] [class*="_cardTypeIcon_"]')[2];
      icon.src = 'https://example.invalid/card_ship_unknown-test.webp';
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].at(-1);
      return ['区域', '带入'].map(label => {
        header.textContent = label;
        try { PacificFrontCapture.readSnapshot(sample); } catch (error) { return error.message; }
      });
    });
    assert.match(errors[0], /敌军3.*未知单位类型.*区域/);
    assert.match(errors[1], /敌军3.*未知单位类型.*带入/);
  });
});

test('带入舰种16%只还原受影响敌军，覆盖两组已核对的原战力', async () => {
  for (const [file, type, expected] of [
    ['巡洋舰', 'cruiser', [156, 155, 135, 151]],
    ['驱逐舰', 'destroyer', [138, 141, 137, 137]],
  ]) {
    await withSample(`./html/关键区域-${file}战力提升.txt`, async page => {
      const snapshot = await page.evaluate(() => {
        // 同结构改为带入栏目，原战力预期来自用户实测；未执行样本脚本。
        [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域').textContent = '带入';
        return PacificFrontCapture.readSnapshot(sample);
      });
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), expected);
      assert.deepEqual(snapshot.source.ignoredEnemyPowerIncreases, [{ type, rate: 0.16 }]);
      assert.equal(snapshot.source.enemyPowerIncreases, undefined);
      if (type === 'cruiser') {
        const multiple = await page.evaluate(() => {
          const section = sample.querySelector('[class*="_conditions_"] [class*="_section_"]');
          const row = section.querySelector('[class*="_statRow_"]').cloneNode(true);
          row.querySelector('img').src = 'https://example.invalid/icon_destroyer_standard-test.webp';
          row.querySelector('[class*="_statLabel_"]').textContent = '驱逐舰'; section.append(row);
          const fourth = sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]')[3];
          fourth.textContent = '175'; fourth.classList.add('_buffed_test');
          return PacificFrontCapture.readSnapshot(sample);
        });
        assert.deepEqual(multiple.enemies.map(enemy => enemy.power), expected);
        assert.deepEqual(multiple.source.ignoredEnemyPowerIncreases, [{ type: 'cruiser', rate: 0.16 }, { type: 'destroyer', rate: 0.16 }]);
      }
    });
  }
});

test('舰种提升支持多个已知类型，拒绝重复、未知、不一致及未核对带入比例', async () => {
  await withSample('./html/关键区域-巡洋舰战力提升.txt', async page => {
    const result = await page.evaluate(() => {
      const section = sample.querySelector('[class*="_conditions_"] [class*="_section_"]');
      const row = section.querySelector('[class*="_statRow_"]');
      const second = row.cloneNode(true);
      second.querySelector('img').src = 'https://example.invalid/icon_destroyer_standard-test.webp';
      second.querySelector('[class*="_statLabel_"]').textContent = '驱逐舰';
      section.append(second);
      const multiple = PacificFrontCapture.readSnapshot(sample).source.enemyPowerIncreases;
      const otherTypes = [];
      second.remove();
      const icon = row.querySelector('img'), label = row.querySelector('[class*="_statLabel_"]');
      const original = icon.src;
      for (const [type, name, filename] of [['battleship', '战列舰', 'icon_battleship_standard-test.webp'],
        ['aircraft', '飞机', 'card_ship_plane-test.webp']]) {
        icon.src = `https://example.invalid/${filename}`; label.textContent = name;
        otherTypes.push(PacificFrontCapture.readSnapshot(sample).source.enemyPowerIncreases[0].type);
      }
      icon.src = original; label.textContent = '巡洋舰'; section.append(second);
      const errors = [];
      const run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      second.querySelector('img').src = row.querySelector('img').src;
      second.querySelector('[class*="_statLabel_"]').textContent = '巡洋舰'; run();
      second.remove();
      icon.src = 'https://example.invalid/icon_submarine_standard-test.webp'; run();
      icon.src = original; label.textContent = '驱逐舰'; run(); label.textContent = '巡洋舰';
      const pct = row.querySelector('[class*="_pctValue_"]');
      pct.textContent = '-16%'; run(); pct.textContent = '+16%';
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      header.textContent = '带入'; pct.textContent = '+12%'; run(); pct.textContent = '+16%';
      header.textContent = '全域';
      const ignored = PacificFrontCapture.readSnapshot(sample);
      return { multiple, otherTypes, errors, ignored };
    });
    assert.deepEqual(result.multiple, [{ type: 'cruiser', rate: 0.16 }, { type: 'destroyer', rate: 0.16 }]);
    assert.equal(result.errors.length, 5);
    assert.deepEqual(result.otherTypes, ['battleship', 'aircraft']);
    assert.equal(result.ignored.source.enemyPowerIncreases, undefined);
    assert.deepEqual(result.ignored.enemies.map(enemy => enemy.power), [181, 180, 157, 151]);
    assert.match(result.errors[0], /重复/);
    assert.match(result.errors[1], /未知/);
    assert.match(result.errors[2], /不一致/);
    assert.match(result.errors[3], /比例/);
    assert.match(result.errors[4], /带入.*舰种.*未核对/);
  });
});

test('带入舰种还原拒绝未知敌军类型、缺失加成标记、不一致数值及区域叠加', async () => {
  await withSample('./html/关键区域-巡洋舰战力提升.txt', async page => {
    const errors = await page.evaluate(() => {
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      header.textContent = '带入';
      const board = sample.querySelector('[class*="_enemies_"]');
      const icon = board.querySelector('[class*="_cardTypeIcon_"]'), power = board.querySelector('[class*="_powerValue_"]');
      const src = icon.src, classes = power.className, value = power.textContent;
      const errors = [], run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      icon.src = 'https://example.invalid/icon_submarine_standard-test.webp'; run(); icon.src = src;
      power.className = classes.replace('_buffed_', '_normal_'); run(); power.className = classes;
      power.textContent = '4'; run(); power.textContent = value;
      const regionHeader = header.cloneNode(true); regionHeader.textContent = '区域';
      header.parentElement.append(regionHeader, header.nextElementSibling.cloneNode(true)); run();
      return errors;
    });
    assert.equal(errors.length, 4);
    assert.match(errors[0], /敌军.*类型/);
    assert.match(errors[1], /加成标记/);
    assert.match(errors[2], /还原/);
    assert.match(errors[3], /叠加/);
  });
});

test('已经受我方减益的敌军战力拒绝当作初始值导入', async () => {
  await withSample('./html/关键区域5.txt', async page => {
    const error = await page.evaluate(() => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { return error.message; } });
    assert.match(error, /我方减益/);
  });
});

test('带入8%按实测四舍五入规则恢复原战力，覆盖两组已核对的数值案例', async () => {
  await withSample('./html/关键区域-存在带入百分比加成.txt', async page => {
    const first = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(first.enemies.map(enemy => enemy.power), [132, 137, 125, 121]);
    assert.equal(first.source.ignoredEnemyPowerIncrease, 0.08);
    assert.equal(first.source.enemyPowerIncrease, undefined);
    const second = await page.evaluate(() => {
      sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]').forEach((node, i) => {
        node.textContent = String([152, 136, 157, 138][i]);
      });
      return PacificFrontCapture.readSnapshot(sample);
    });
    assert.deepEqual(second.enemies.map(enemy => enemy.power), [141, 126, 145, 128]);
  });
});

test('带入还原拒绝未核对比例、区域与带入叠加和不一致战力', async () => {
  await withSample('./html/关键区域-存在带入百分比加成.txt', async page => {
    const errors = await page.evaluate(() => {
      const errors = [];
      const run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (e) { errors.push(e.message); } };
      const rate = sample.querySelector('[class*="_conditions_"] [class*="_pctValue_"]');
      rate.textContent = '+10%'; run(); rate.textContent = '+8%';
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      const body = header.nextElementSibling;
      const regionHeader = header.cloneNode(true), regionBody = body.cloneNode(true);
      regionHeader.textContent = '区域'; header.parentElement.append(regionHeader, regionBody);
      run(); regionHeader.remove(); regionBody.remove();
      const power = sample.querySelector('[class*="_enemies_"] [class*="_powerValue_"]');
      power.textContent = '7'; run(); power.textContent = '143';
      power.className = power.className.replace('_buffed_', '_normal_'); run();
      return errors;
    });
    assert.equal(errors.length, 4);
    assert.match(errors[0], /比例.*未核对/);
    assert.match(errors[1], /叠加/);
    assert.match(errors[2], /还原/);
    assert.match(errors[3], /加成标记/);
  });
});

test('带入还原仍拒绝已受我方减益的显示战力', async () => {
  await withSample('./html/关键区域5.txt', async page => {
    const error = await page.evaluate(() => {
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      header.textContent = '带入';
      try { PacificFrontCapture.readSnapshot(sample); } catch (error) { return error.message; }
    });
    assert.match(error, /我方减益/);
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

test('岸防炮样本导入目标组后保存区域加成，刷新可撤销且保留资源', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-敌军3存在未知单位类型.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [215, 202, 167, 175]);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.powerIncrease), [0.16, 0.16, 0, 0]);
    assert.deepEqual(imported.waves[0].groupConditions[1].captureSource.enemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }]);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

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

test('舰种提升导入、来源保存、刷新和撤销，不改其他组与资源', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-巡洋舰战力提升.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [181, 180, 157, 151]);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.powerIncrease), [0.16, 0.16, 0.16, 0]);
    assert.deepEqual(imported.waves[0].groupConditions[1].captureSource.enemyPowerIncreases, [{ type: 'cruiser', rate: 0.16 }]);
    assert.equal(imported.waves[0].groupConditions[1].enemyPowerIncreases, undefined);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.match(await page.locator('.capture-source').textContent(), /巡洋舰战力＋16%.*已计入/);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.match(await page.locator('.capture-source').textContent(), /巡洋舰战力＋16%.*已计入/);
    assert.deepEqual((await savedInput(page)).waves[0].enemies.slice(4).map(enemy => enemy.powerIncrease), [0.16, 0.16, 0.16, 0]);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('驱逐舰区域增益随输入刷新进入Worker，旧截图阵容不再误报全胜', async () => {
  await withPlanner(async page => {
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-驱逐舰战力提升.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4).map(e => e.powerIncrease), [0.16, 0.16, 0.16, 0.16]);
    const fixed = await page.evaluate(async () => {
      const { evaluateFormation } = await import('/solver.js');
      const catalog = await (await fetch('/data/cards.json')).json(), items = await (await fetch('/data/items.json')).json();
      const input = JSON.parse(localStorage.getItem('pacific-front-planner-v1'));
      const ids = ['san_diego', 'johnston', 'benson', 'helldiver_essex'];
      return evaluateFormation(ids.map(cardId => ({ cardId })), { ...input, enemies: input.waves[0].enemies.slice(0, 4),
        conditions: input.waves[0].groupConditions[0], global: input.waves[0].groupConditions[0].global,
        cards: ids.map((cardId, i) => ({ cardId, health: [3, 2, 2, 2][i] })) }, catalog, items);
    });
    assert.deepEqual(fixed.positions.map(p => p.enemyPower), [132, 164, 132, 132]);
    assert.equal(fixed.wins, 3);
    await page.evaluate(() => {
      const input = JSON.parse(localStorage.getItem('pacific-front-planner-v1'));
      input.waves = [{ enemies: input.waves[0].enemies.slice(0, 4).map((e, i) => ({ ...e, active: i < 2 })),
        groupConditions: [input.waves[0].groupConditions[0]] }];
      input.cards = ['san_diego', 'johnston'].map(cardId => ({ cardId, health: 3 }));
      input.inventory = Object.fromEntries(Object.keys(input.inventory).map(id => [id, 0]));
      localStorage.setItem('pacific-front-planner-v1', JSON.stringify(input));
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#capture-target').options.length === 1);
    assert.deepEqual((await savedInput(page)).waves[0].enemies.map(e => e.powerIncrease), [0.16, 0.16, 0.16, 0.16]);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelector('#result-panel').textContent.includes('行动配队方案'), null, { timeout: 20000 });
    assert.match(await page.locator('#result-panel .result-badge').first().textContent(), /1\s*\/\s*2/);
    assert.match(await page.locator('#result-panel').textContent(), /敌方原战力138.*区域战力＋16%/);
  });
});

test('Worker重排同波用卡后仍按原组序显示，保存的输入不变', async () => {
  await withPlanner(async page => {
    await page.evaluate(() => {
      const input = JSON.parse(localStorage.getItem('pacific-front-planner-v1'));
      const group = (power, weaknesses) => Array.from({ length: 4 }, (_, i) => ({ active: i === 0, power, rawPower: String(power), weaknesses }));
      input.waves = [{ enemies: [...group(80, []), ...group(110, ['debuff_concentric_target'])], groupConditions: [{}, {}] }];
      input.cards = ['arrow', 'hughes'].map(cardId => ({ cardId, health: 3 }));
      input.inventory = Object.fromEntries(Object.keys(input.inventory).map(id => [id, 0]));
      localStorage.setItem('pacific-front-planner-v1', JSON.stringify(input));
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#capture-target').options.length === 2);
    await page.locator('#planner').dispatchEvent('input');
    const before = await savedInput(page);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelector('#result-panel').textContent.includes('行动配队方案'));
    assert.match(await page.locator('#result-panel .result-badge').first().textContent(), /2\s*\/\s*2/);
    assert.match(await page.locator('#result-panel .section-note').textContent(), /第1波为第2组预留单位.*原组序/);
    const groups = page.locator('#result-panel .group-result');
    assert.match(await groups.nth(0).textContent(), /第1组.*USS休斯/s);
    assert.match(await groups.nth(1).textContent(), /第2组.*HMS箭/s);
    assert.deepEqual(await savedInput(page), before);
  });
});

test('带入8%页面导入恢复原战力，来源刷新保留且可以撤销', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-存在带入百分比加成.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4).map(enemy => enemy.power), [132, 137, 125, 121]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.equal(imported.waves[0].groupConditions[0].captureSource.ignoredEnemyPowerIncrease, 0.08);
    assert.match(await page.locator('.capture-source').textContent(), /带入.*8%.*已还原/);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.match(await page.locator('.capture-source').textContent(), /带入.*已还原/);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('禁用战列舰导入到目标组，舰种选择保存、刷新及撤销正确', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-存在禁用战舰.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].groupConditions[1].allowedTypes, ['aircraft', 'cruiser', 'destroyer']);
    assert.deepEqual(imported.waves[0].groupConditions[0], before.waves[0].groupConditions[0]);
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.equal(await page.locator('[aria-label="第1波第2组限定舰种"]').isChecked(), true);
    assert.equal(await page.locator('[aria-label="第1波第2组允许战列舰"]').isChecked(), false);
    for (const name of ['飞机', '巡洋舰', '驱逐舰']) {
      assert.equal(await page.locator(`[aria-label="第1波第2组允许${name}"]`).isChecked(), true);
    }
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('禁用变项导入、保存与Worker计算一致，撤销恢复原条件', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-区域禁用变项.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    assert.equal((await savedInput(page)).waves[0].groupConditions[0].itemsDisabled, true);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.equal(await page.locator('[aria-label="第1波第1组禁用道具"]').isChecked(), true);
    assert.equal(await page.locator('[aria-label="第1波第2组禁用道具"]').isChecked(), false);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 3);
    const first = page.locator('.group-result').first();
    assert.match(await first.textContent(), /禁用道具/);
    for (const text of await first.locator('.result-items').allTextContents()) {
      assert.match(text, /灰色：不装备/); assert.match(text, /绿色：不装备/);
    }
    assert.deepEqual((await savedInput(page)).inventory, before.inventory);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
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

test('游戏页舰种16%带入通过接口还原，来源刷新保留并可撤销', async () => {
  await withPlanner(async (page, context) => {
    const before = await savedInput(page);
    const html = (await readFile(new URL('./html/关键区域-巡洋舰战力提升.txt', import.meta.url), 'utf8'))
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace('>区域</h3>', '>带入</h3>')
      .replace(/<div id="pacific-front-capture-bridge"[\s\S]*$/, '');
    await context.route('https://pacificfront.worldofwarships.asia/zh-sg/operations/typed-carry-test', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const game = await context.newPage();
    await game.goto('https://pacificfront.worldofwarships.asia/zh-sg/operations/typed-carry-test');
    await game.addScriptTag({ content: await pairedScript(page) });
    const [planner] = await Promise.all([game.waitForEvent('popup'), game.locator('#pacific-front-capture-bridge button').click()]);
    await planner.waitForFunction(() => document.querySelector('#capture-current') && !document.querySelector('#capture-current').disabled);
    await planner.locator('#capture-current').click();
    await planner.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(planner);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4).map(enemy => enemy.power), [156, 155, 135, 151]);
    assert.deepEqual(imported.waves[0].groupConditions[0].captureSource.ignoredEnemyPowerIncreases, [{ type: 'cruiser', rate: 0.16 }]);
    assert.deepEqual(imported.waves[0].enemies.slice(4), before.waves[0].enemies.slice(4));
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.match(await planner.locator('.capture-source').textContent(), /带入.*巡洋舰战力＋16%.*已还原/);
    await planner.reload();
    await planner.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.match(await planner.locator('.capture-source').textContent(), /带入.*巡洋舰战力＋16%.*已还原/);
    await planner.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(planner)).waves, before.waves);
  });
});

test('游戏页按钮抓取带入8%时通过接口填入还原后的战力', async () => {
  await withPlanner(async (page, context) => {
    const html = (await readFile(new URL('./html/关键区域-存在带入百分比加成.txt', import.meta.url), 'utf8'))
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<div id="pacific-front-capture-bridge"[\s\S]*$/, '');
    await context.route('https://pacificfront.worldofwarships.asia/zh-sg/operations/carry-test', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const game = await context.newPage();
    await game.goto('https://pacificfront.worldofwarships.asia/zh-sg/operations/carry-test');
    await game.addScriptTag({ content: await pairedScript(page) });
    const [planner] = await Promise.all([game.waitForEvent('popup'), game.locator('#pacific-front-capture-bridge button').click()]);
    await planner.waitForFunction(() => document.querySelector('#capture-current') && !document.querySelector('#capture-current').disabled);
    await planner.locator('#capture-current').click();
    await planner.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    assert.deepEqual((await savedInput(planner)).waves[0].enemies.slice(0, 4).map(enemy => enemy.power), [132, 137, 125, 121]);
    assert.match(await planner.locator('.capture-source').textContent(), /带入.*已还原/);
  });
});
