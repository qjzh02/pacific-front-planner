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

test('全体带入16%人工样本还原四组已核对原战力，不受8%白名单限制', async () => {
  await withSample('./html/关键区域-提升比例核对.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [145, 152, 165, 142]);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, 0.16);
    assert.equal(snapshot.source.enemyPowerIncrease, undefined);
    globalThis.PacificFrontCapture.validateSnapshot(snapshot);
  });
});

test('任意明确比例和多层全体舰种增益统一加算，保留区域并去除带入', async () => {
  await withSample('./html/关键区域-提升比例核对.txt', async page => {
    const results = await page.evaluate(() => {
      const container = sample.querySelector('[class*="_conditions_"]');
      const header = container.querySelector('[class*="_subheader_"]').cloneNode(true);
      const body = container.querySelector('[class*="_bodyZone_"]').cloneNode(true);
      const globalRow = body.querySelector('[class*="_rowLabel_"]').cloneNode(true);
      const snapshots = [];
      const typedSection = document.createElement('div'); typedSection.className = '_section_test';
      typedSection.innerHTML = '<div class="_label_test">敌方战力：</div><div class="_statRow_test"><img class="_shipIcon_test" src="/icon_destroyer_standard-test.webp"><span class="_statLabel_test">驱逐舰</span><span class="_pctValue_test">+0%</span></div>';
      const bases = [145, 152, 165, 142];
      for (const [carriedGlobal, carriedTyped, regionalGlobal, regionalTyped] of [
        [[0.16], [], [], []], [[0.1, 0.12], [0.16, 0.16, 0.16], [0.08, 0.12], [0.16, 0.16]],
        [[], [], [0.125, 0.375], [0.2, 0.24, 0.12]], [[1.25], [0.375], [0.5], [0.125]],
      ]) {
        container.replaceChildren();
        for (const [category, globals, typed] of [['带入', carriedGlobal, carriedTyped], ['区域', regionalGlobal, regionalTyped]]) {
          if (!globals.length && !typed.length) continue;
          const h = header.cloneNode(true), b = body.cloneNode(false); h.textContent = category;
          for (const rate of globals) { const row = globalRow.cloneNode(true); row.querySelector('[class*="_pctValue_"]').textContent = `+${rate * 100}%`; b.append(row); }
          for (const rate of typed) { const section = typedSection.cloneNode(true); section.querySelector('[class*="_pctValue_"]').textContent = `+${rate * 100}%`; b.append(section); }
          container.append(h, b);
        }
        const carried = carriedGlobal.reduce((a, b) => a + b, 0), regional = regionalGlobal.reduce((a, b) => a + b, 0);
        const carriedDestroyer = carriedTyped.reduce((a, b) => a + b, 0), regionalDestroyer = regionalTyped.reduce((a, b) => a + b, 0);
        sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]').forEach((node, i) => {
          node.textContent = String(Math.round(bases[i] * (1 + carried + regional + ([1, 3].includes(i) ? carriedDestroyer + regionalDestroyer : 0))));
        });
        snapshots.push({ snapshot: PacificFrontCapture.readSnapshot(sample), regional, regionalDestroyer });
      }
      return snapshots;
    });
    for (const { snapshot, regional, regionalDestroyer } of results) {
      const rates = [regional, regional + regionalDestroyer, regional, regional + regionalDestroyer];
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [145, 152, 165, 142].map((base, i) => Math.round(base * (1 + rates[i]))));
      if (regional || regionalDestroyer) snapshot.enemies.forEach((enemy, i) => assert.ok(Math.abs(enemy.powerIncrease - rates[i]) < 1e-8));
      globalThis.PacificFrontCapture.validateSnapshot(snapshot);
    }
  });
});

test('双驱逐带入16%加算还原，水雷不匹配驱逐区域增益', async () => {
  for (const [file, powers, rates] of [
    ['双驱逐提升', [178, 210, 204, 202], null],
    ['水雷', [113, 180, 161, 186], [0, 0.16, 0.16, 0.16]],
  ]) await withSample(`./html/关键区域-${file}.txt`, async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), powers);
    assert.deepEqual(snapshot.source[rates ? 'enemyPowerIncreases' : 'ignoredEnemyPowerIncreases'],
      [{ type: 'destroyer', rate: rates ? 0.16 : 0.32 }]);
    if (rates) assert.deepEqual(snapshot.enemies.map(enemy => enemy.powerIncrease), rates);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    globalThis.PacificFrontCapture.validateSnapshot(snapshot);
  });
});

test('全部敌军类型两条16%支持同栏、分栏、多带入及带入区域混合', async () => {
  await withSample('./html/关键区域-双驱逐提升.txt', async page => {
    const results = await page.evaluate(() => {
      const types = [['aircraft', '飞机', 'card_ship_plane'], ['battleship', '战列舰', 'icon_battleship_standard'],
        ['cruiser', '巡洋舰', 'icon_cruiser_standard'], ['destroyer', '驱逐舰', 'icon_destroyer_standard'],
        ['submarine', '潜艇', 'icon_submarine_standard'], ['coastal_artillery', '岸防炮', 'card_ship_coastal_artillery'],
        ['naval_mine', '水雷', 'card_ship_naval_mine']];
      const container = sample.querySelector('[class*="_conditions_"]');
      const header = container.querySelector('[class*="_subheader_"]').cloneNode(true);
      const body = container.querySelector('[class*="_bodyZone_"]').cloneNode(false);
      const section = container.querySelector('[class*="_section_"]').cloneNode(true);
      const snapshots = [];
      for (const [type, name, icon] of types) for (const layout of ['同栏', '分栏', '多带入', '混合', '区域']) {
        const first = section.cloneNode(true), second = section.cloneNode(true);
        for (const node of [first, second]) {
          node.querySelector('img').src = `/assets/${icon}-test.webp`;
          node.querySelector('[class*="_statLabel_"]').textContent = name;
        }
        const h = header.cloneNode(true), b = body.cloneNode(false);
        h.textContent = layout === '区域' ? '区域' : '带入'; b.append(first);
        container.replaceChildren(h, b);
        if (layout === '同栏') first.append(second.querySelector('[class*="_statRow_"]'));
        else if (layout === '混合' || layout === '多带入') {
          const next = header.cloneNode(true), nextBody = body.cloneNode(false);
          next.textContent = layout === '混合' ? '区域' : '带入'; nextBody.append(second); container.append(next, nextBody);
        } else b.append(second);
        sample.querySelectorAll('[class*="_enemy_"]').forEach(card => {
          card.querySelector('[class*="_cardTypeIcon_"]').src = `/assets/${icon}-test.webp`;
          const power = card.querySelector('[class*="_powerValue_"]'); power.textContent = '132'; power.classList.add('_buffed_test');
        });
        snapshots.push({ type, layout, snapshot: PacificFrontCapture.readSnapshot(sample) });
      }
      return { snapshots };
    });
    assert.equal(results.snapshots.length, 35);
    for (const { type, layout, snapshot } of results.snapshots) {
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), Array(4).fill(layout === '区域' ? 132 : layout === '混合' ? 116 : 100));
      if (layout === '区域' || layout === '混合') {
        assert.deepEqual(snapshot.enemies.map(enemy => enemy.powerIncrease), Array(4).fill(layout === '区域' ? 0.32 : 0.16));
      }
      const key = layout === '区域' ? 'enemyPowerIncreases' : 'ignoredEnemyPowerIncreases';
      assert.deepEqual(snapshot.source[key], [{ type, rate: layout === '混合' ? 0.16 : 0.32 }]);
      globalThis.PacificFrontCapture.validateSnapshot(snapshot);
    }
  });
});

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

test('区域增益效果减100%导入为增益失效，带入8%还原且全域忽略', async () => {
  await withSample('./html/关键区域-增益效果-100%25.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [151, 126, 153, 120]);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, 0.08);
    assert.equal(snapshot.source.enemyPowerIncreases, undefined);
    assert.equal(snapshot.condition.buffsDisabled, true);
    assert.equal(snapshot.condition.debuffsDisabled, false);
    assert.equal(snapshot.condition.buffsReduced, false);
    assert.equal(snapshot.condition.debuffsReduced, false);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    const ignored = await page.evaluate(() => {
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      return ['带入', '指定', '全域'].map(label => {
        header.textContent = label;
        return PacificFrontCapture.readSnapshot(sample).condition.buffsDisabled;
      });
    });
    assert.deepEqual(ignored, [false, false, false]);
  });
});

test('区域减益50%样本导入为减益削弱，保留敌军并忽略全域条件', async () => {
  await withSample('./html/关键区域-减益--50%25.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [177, 186, 154, 171]);
    assert.equal(snapshot.condition.debuffsReduced, true);
    assert.equal(snapshot.condition.buffsReduced, false);
    assert.equal(snapshot.condition.buffsDisabled, false);
    assert.equal(snapshot.condition.debuffsDisabled, false);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
  });
});

test('增益减益50%与100%统一映射，支持混合并忽略带入指定全域', async () => {
  await withSample('./html/关键区域-减益--50%25.txt', async page => {
    const results = await page.evaluate(() => {
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      const row = header.nextElementSibling.querySelector('[class*="_statRow_"]');
      const label = row.querySelector('[class*="_statLabel_"]'), rate = row.querySelector('[class*="_pctValue_"]');
      const cases = [], ignored = [], mixed = [];
      for (const [name, percentage] of [['增益效果', '-50%'], ['增益效果', '-100%'], ['减益效果', '−50%'], ['减益效果', '-100%']]) {
        label.textContent = name; rate.textContent = percentage; header.textContent = '区域';
        cases.push(PacificFrontCapture.readSnapshot(sample).condition);
        for (const section of ['带入', '指定', '全域']) {
          header.textContent = section;
          ignored.push(PacificFrontCapture.readSnapshot(sample).condition);
        }
      }
      header.textContent = '区域'; label.textContent = '增益效果';
      const second = row.cloneNode(true); second.querySelector('[class*="_statLabel_"]').textContent = '减益效果'; row.parentElement.append(second);
      for (const buffRate of ['-50%', '-100%']) for (const debuffRate of ['-50%', '-100%']) {
        rate.textContent = buffRate; second.querySelector('[class*="_pctValue_"]').textContent = debuffRate;
        mixed.push(PacificFrontCapture.readSnapshot(sample).condition);
      }
      return { cases, ignored, mixed };
    });
    const flags = ['buffsReduced', 'buffsDisabled', 'debuffsReduced', 'debuffsDisabled'];
    const activeFlags = condition => flags.filter(flag => condition[flag]);
    assert.deepEqual(results.cases.map(activeFlags), flags.map(flag => [flag]));
    assert.ok(results.ignored.every(condition => activeFlags(condition).length === 0));
    assert.deepEqual(results.mixed.map(activeFlags), [
      ['buffsReduced', 'debuffsReduced'], ['buffsReduced', 'debuffsDisabled'],
      ['buffsDisabled', 'debuffsReduced'], ['buffsDisabled', 'debuffsDisabled'],
    ]);
    assert.ok([...results.cases, ...results.mixed].every(condition => Object.values(condition.global).every(rate => rate === 0)));
  });
});

test('区域增益效果拒绝缺失、重复、其他比例和未知内容', async () => {
  await withSample('./html/关键区域-增益效果-100%25.txt', async page => {
    const errors = await page.evaluate(() => {
      const header = [...sample.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      const row = header.nextElementSibling.querySelector('[class*="_statRow_"]');
      const pct = row.querySelector('[class*="_pctValue_"]');
      const original = pct.innerHTML;
      const errors = [], run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      for (const value of ['-25%', '-99%', '-101%', '+100%']) { pct.textContent = value; run(); }
      pct.innerHTML = original;
      const duplicate = row.cloneNode(true); row.parentElement.append(duplicate); run(); duplicate.remove();
      const extra = document.createElement('span'); extra.textContent = '未知条件'; row.append(extra); run(); extra.remove();
      pct.remove(); run();
      return errors;
    });
    assert.equal(errors.length, 7);
    errors.forEach(message => assert.match(message, /无法.*识别.*区域/));
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

test('岸防炮战力提升按卡面匹配，保留区域显示值且支持带入还原', async () => {
  await withSample('./html/关键区域-存在未知战力提升图标-岸防炮.txt', async page => {
    const regional = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(regional.enemies.map(enemy => enemy.power), [177, 187, 204, 201]);
    assert.deepEqual(regional.enemies.map(enemy => enemy.powerIncrease), [0.16, 0.16, 0.16, 0]);
    assert.deepEqual(regional.source.enemyPowerIncreases, [{ type: 'coastal_artillery', rate: 0.16 }]);
    assert.equal(regional.condition.allowedTypes, null);
    const carried = await page.evaluate(() => {
      sample.querySelector('[class*="_subheader_"]').textContent = '带入';
      return PacificFrontCapture.readSnapshot(sample);
    });
    assert.deepEqual(carried.enemies.map(enemy => enemy.power), [153, 161, 176, 201]);
    assert.deepEqual(carried.source.ignoredEnemyPowerIncreases, [{ type: 'coastal_artillery', rate: 0.16 }]);
    assert.equal(carried.source.enemyPowerIncreases, undefined);
  });
});

test('两层带入按8%加16%还原，覆盖七组用户驱逐舰实测', async () => {
  await withSample('./html/关键区域-多项带入敌方提升叠加.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [131, 154, 146, 137]);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, 0.08);
    assert.deepEqual(snapshot.source.ignoredEnemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }]);
    assert.equal(snapshot.condition.buffsDisabled, false); // 此样本增益失效也在带入栏目
    assert.equal(snapshot.source.enemyPowerIncreases, undefined);
    for (const [base, displayed] of [[137, 170], [177, 219], [207, 257], [161, 200], [145, 180], [164, 203], [139, 172]]) {
      assert.equal(Math.round(base * 1.24), displayed);
      const restored = await page.evaluate(displayed => {
        sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]')[3].textContent = String(displayed);
        return PacificFrontCapture.readSnapshot(sample);
      }, displayed);
      assert.equal(restored.enemies[3].power, base);
    }
  });
});

test('带入与区域按原战力加算，只去掉带入并保留潜艇区域16%', async () => {
  await withSample('./html/关键区域-既有带入又有区域提升叠加.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [145, 164, 161, 153]);
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.powerIncrease), [0, 0, 0.16, 0]);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, 0.08);
    assert.deepEqual(snapshot.source.ignoredEnemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }]);
    assert.deepEqual(snapshot.source.enemyPowerIncreases, [{ type: 'submarine', rate: 0.16 }]);
    assert.equal(Math.round(snapshot.enemies[2].power / 1.16), 139);
    assert.equal(Math.round(139 * 1.24), 172);
    await page.evaluate(snapshot => PacificFrontCapture.validateSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  });
});

test('多层带入仍拒绝未知类型、无效比例、无法还原和缺少加成标记', async () => {
  await withSample('./html/关键区域-既有带入又有区域提升叠加.txt', async page => {
    const errors = await page.evaluate(() => {
      const headers = [...sample.querySelectorAll('[class*="_subheader_"]')];
      const carried = headers.find(node => node.textContent.trim() === '带入').nextElementSibling;
      const regional = headers.find(node => node.textContent.trim() === '区域').nextElementSibling;
      const typedRow = carried.querySelector('[class*="_statRow_"]');
      const icon = typedRow.querySelector('img'), label = typedRow.querySelector('[class*="_statLabel_"]');
      const src = icon.src, name = label.textContent;
      const errors = [], run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      icon.src = '/assets/icon_unknown_standard-test.webp'; label.textContent = '潜艇'; run(); icon.src = src; label.textContent = name;
      const rate = regional.querySelector('[class*="_pctValue_"]'), originalRate = rate.innerHTML;
      rate.textContent = '+NaN%'; run(); rate.innerHTML = originalRate;
      const power = sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]')[2];
      const originalPower = power.textContent, classes = power.className;
      power.textContent = '3'; run(); power.textContent = originalPower;
      power.className = classes.replace('_buffed_', '_normal_'); run();
      return errors;
    });
    assert.equal(errors.length, 4);
    assert.match(errors[0], /未知/);
    assert.match(errors[1], /比例/);
    assert.match(errors[2], /无法还原/);
    assert.match(errors[3], /加成标记/);
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

test('不同舰种分栏带入16%样本分别还原，不将两个栏目误判为重复', async () => {
  await withSample('./html/关键据点-舰种提升重复.txt', async page => {
    const snapshot = await page.evaluate(() => PacificFrontCapture.readSnapshot(sample));
    assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), [190, 191, 188, 186]);
    assert.deepEqual(snapshot.source.ignoredEnemyPowerIncreases, [{ type: 'destroyer', rate: 0.16 }, { type: 'battleship', rate: 0.16 }]);
    assert.equal(snapshot.source.enemyPowerIncreases, undefined);
    assert.equal(snapshot.source.ignoredEnemyPowerIncrease, undefined);
    assert.deepEqual(snapshot.condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(snapshot.condition.allowedTypes, null);
    await page.evaluate(snapshot => PacificFrontCapture.validateSnapshot(snapshot), snapshot);
  });
});

test('全部支持舰种可单栏或分栏独立提升，未知内容拒绝', async () => {
  await withSample('./html/关键据点-舰种提升重复.txt', async page => {
    const results = await page.evaluate(() => {
      const types = [['aircraft', '飞机', 'card_ship_plane-test.webp'], ['battleship', '战列舰', 'icon_battleship_standard-test.webp'],
        ['cruiser', '巡洋舰', 'icon_cruiser_standard-test.webp'], ['destroyer', '驱逐舰', 'icon_destroyer_standard-test.webp'],
        ['submarine', '潜艇', 'icon_submarine_standard-test.webp'], ['coastal_artillery', '岸防炮', 'card_ship_coastal_artillery-test.webp']];
      const header = sample.querySelector('[class*="_subheader_"]'), body = header.nextElementSibling;
      const template = body.querySelector('[class*="_section_"]').cloneNode(true);
      const sections = types.map(([, name, file]) => {
        const section = template.cloneNode(true);
        section.querySelector('img').src = `/assets/${file}`;
        section.querySelector('[class*="_statLabel_"]').textContent = name;
        return section;
      });
      sample.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]').forEach(power => power.classList.add('_buffed_test'));
      const snapshots = [];
      for (const category of ['带入', '区域']) for (const split of [false, true]) {
        header.textContent = category;
        if (split) body.replaceChildren(...sections.map(section => section.cloneNode(true)));
        else {
          const merged = sections[0].cloneNode(true);
          merged.append(...sections.slice(1).map(section => section.querySelector('[class*="_statRow_"]').cloneNode(true)));
          body.replaceChildren(merged);
        }
        snapshots.push({ category, split, snapshot: PacificFrontCapture.readSnapshot(sample) });
      }
      header.textContent = '带入';
      body.replaceChildren(sections[0].cloneNode(true));
      const extra = [];
      sections.slice(1).forEach(section => {
        const nextHeader = header.cloneNode(true), nextBody = body.cloneNode(false);
        nextBody.append(section.cloneNode(true)); header.parentElement.append(nextHeader, nextBody);
        extra.push(nextHeader, nextBody);
      });
      const separateHeaders = PacificFrontCapture.readSnapshot(sample);
      extra.forEach(node => node.remove());
      const errors = [], run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      body.replaceChildren(...sections.map(section => section.cloneNode(true)));
      body.lastElementChild.querySelector('img').src = '/assets/icon_unknown_standard-test.webp'; run();
      body.lastElementChild.replaceWith(sections.at(-1).cloneNode(true));
      body.lastElementChild.querySelector('[class*="_statLabel_"]').textContent = '驱逐舰'; run();
      body.lastElementChild.replaceWith(sections.at(-1).cloneNode(true));
      body.lastElementChild.querySelector('[class*="_pctValue_"]').textContent = '+NaN%'; run();
      body.lastElementChild.replaceWith(sections.at(-1).cloneNode(true));
      body.lastElementChild.append(document.createTextNode('未知条件')); run();
      body.lastElementChild.replaceWith(sections.at(-1).cloneNode(true));
      return { snapshots, separateHeaders, types: types.map(([type]) => type), errors };
    });
    const boosts = results.types.map(type => ({ type, rate: 0.16 }));
    for (const { category, snapshot } of results.snapshots) {
      assert.deepEqual(snapshot.source[category === '带入' ? 'ignoredEnemyPowerIncreases' : 'enemyPowerIncreases'], boosts);
      assert.deepEqual(snapshot.enemies.map(enemy => enemy.power), category === '带入' ? [164, 191, 188, 160] : [190, 222, 218, 186]);
      if (category === '区域') assert.deepEqual(snapshot.enemies.map(enemy => enemy.powerIncrease), [0.16, 0.16, 0.16, 0.16]);
    }
    assert.deepEqual(results.separateHeaders.source.ignoredEnemyPowerIncreases, boosts);
    assert.equal(results.errors.length, 4);
    assert.ok(results.errors.every(error => /未知|不一致|比例/.test(error)));
  });
});

test('舰种提升支持多个已知类型，拒绝未知、不一致及无效比例', async () => {
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
      second.querySelector('[class*="_statLabel_"]').textContent = '巡洋舰';
      const third = second.cloneNode(true); third.querySelector('[class*="_pctValue_"]').textContent = '-16%'; section.append(third); run(); third.remove();
      second.remove();
      icon.src = 'https://example.invalid/icon_unknown_standard-test.webp'; run();
      icon.src = original; label.textContent = '驱逐舰'; run(); label.textContent = '巡洋舰';
      const pct = row.querySelector('[class*="_pctValue_"]');
      pct.textContent = '-16%'; run(); pct.textContent = '+16%';
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      header.textContent = '带入'; pct.textContent = '+NaN%'; run(); pct.textContent = '+16%';
      header.textContent = '全域';
      const ignored = PacificFrontCapture.readSnapshot(sample);
      return { multiple, otherTypes, errors, ignored };
    });
    assert.deepEqual(result.multiple, [{ type: 'cruiser', rate: 0.16 }, { type: 'destroyer', rate: 0.16 }]);
    assert.equal(result.errors.length, 5);
    assert.deepEqual(result.otherTypes, ['battleship', 'aircraft']);
    assert.equal(result.ignored.source.enemyPowerIncreases, undefined);
    assert.deepEqual(result.ignored.enemies.map(enemy => enemy.power), [181, 180, 157, 151]);
    assert.match(result.errors[0], /比例/);
    assert.match(result.errors[1], /未知/);
    assert.match(result.errors[2], /不一致/);
    assert.match(result.errors[3], /比例/);
    assert.match(result.errors[4], /比例/);
  });
});

test('带入舰种还原拒绝未知敌军类型、缺失加成标记、不一致数值及区域缺失比例', async () => {
  await withSample('./html/关键区域-巡洋舰战力提升.txt', async page => {
    const errors = await page.evaluate(() => {
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      header.textContent = '带入';
      const board = sample.querySelector('[class*="_enemies_"]');
      const icon = board.querySelector('[class*="_cardTypeIcon_"]'), power = board.querySelector('[class*="_powerValue_"]');
      const src = icon.src, classes = power.className, value = power.textContent;
      const errors = [], run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (error) { errors.push(error.message); } };
      icon.src = 'https://example.invalid/icon_unknown_standard-test.webp'; run(); icon.src = src;
      power.className = classes.replace('_buffed_', '_normal_'); run(); power.className = classes;
      power.textContent = '4'; run(); power.textContent = value;
      const regionHeader = header.cloneNode(true); regionHeader.textContent = '区域';
      const regionBody = header.nextElementSibling.cloneNode(true);
      const regionSection = regionBody.querySelector('[class*="_section_"]');
      regionSection.querySelector('[class*="_pctValue_"]').remove();
      header.parentElement.append(regionHeader, regionBody); run();
      return errors;
    });
    assert.equal(errors.length, 4);
    assert.match(errors[0], /敌军.*类型/);
    assert.match(errors[1], /加成标记/);
    assert.match(errors[2], /还原/);
    assert.match(errors[3], /比例/);
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

test('带入还原拒绝无效比例、未知区域内容和不一致战力', async () => {
  await withSample('./html/关键区域-存在带入百分比加成.txt', async page => {
    const errors = await page.evaluate(() => {
      const errors = [];
      const run = () => { try { PacificFrontCapture.readSnapshot(sample); } catch (e) { errors.push(e.message); } };
      const rate = sample.querySelector('[class*="_conditions_"] [class*="_pctValue_"]');
      rate.textContent = '+NaN%'; run(); rate.textContent = '+8%';
      const header = sample.querySelector('[class*="_conditions_"] [class*="_subheader_"]');
      const body = header.nextElementSibling;
      const regionHeader = header.cloneNode(true), regionBody = body.cloneNode(true);
      regionHeader.textContent = '区域'; regionBody.append(document.createTextNode('未知条件')); header.parentElement.append(regionHeader, regionBody);
      run(); regionHeader.remove(); regionBody.remove();
      const power = sample.querySelector('[class*="_enemies_"] [class*="_powerValue_"]');
      power.textContent = '7'; run(); power.textContent = '143';
      power.className = power.className.replace('_buffed_', '_normal_'); run();
      return errors;
    });
    assert.equal(errors.length, 4);
    assert.match(errors[0], /比例/);
    assert.match(errors[1], /不支持/);
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
        model: { globalStacking: 'multiply', rounding: 'conservative', allowEqual: false, revive: false }, beamWidth: 900, captureAuto: false,
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

async function autoPointHtml(page, stage, keypoint, power) {
  const html = await readFile(new URL('./html/关键据点1.txt', import.meta.url), 'utf8');
  return page.evaluate(({ html, stage, keypoint, power }) => {
    const template = document.createElement('template'); template.innerHTML = html;
    template.content.querySelector('[class*="_stageInfo_"] [class*="_title_"]').textContent = `阶段${stage}`;
    template.content.querySelector('[class*="_headerTitle_"]').textContent = `关键据点${keypoint}`;
    template.content.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]').forEach(node => { node.textContent = String(power); });
    return template.innerHTML;
  }, { html, stage, keypoint, power });
}

async function importAutoPoint(page, stage, keypoint, power = keypoint * 100) {
  const html = await autoPointHtml(page, stage, keypoint, power);
  await page.locator('#capture-file').setInputFiles({ name: 'point.txt', mimeType: 'text/plain', buffer: Buffer.from(html) });
  await page.waitForFunction(({ stage, keypoint, power }) => {
    const wave = JSON.parse(localStorage.getItem('pacific-front-planner-v1')).waves[stage - 1];
    const group = wave?.groupConditions.findIndex(condition => condition.captureSource?.keypoint === keypoint);
    return group >= 0 && wave.enemies[group * 4].power === power && document.querySelector('#capture-feedback').textContent.startsWith('已填入');
  }, { stage, keypoint, power });
}

test('自动填入默认兼容旧输入，顺序导入自动扩容、重复更新且刷新可撤销', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.evaluate(() => {
      const input = JSON.parse(localStorage.getItem('pacific-front-planner-v1')); delete input.captureAuto;
      localStorage.setItem('pacific-front-planner-v1', JSON.stringify(input));
    });
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 30);
    assert.equal(await page.locator('#capture-auto').isChecked(), true);
    assert.equal(await page.locator('#capture-target').isDisabled(), true);
    await page.locator('#reset-action').click();
    for (const [stage, keypoint] of [[1, 1], [1, 2], [1, 3], [2, 4], [2, 5], [3, 6]]) await importAutoPoint(page, stage, keypoint);
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves.map(wave => wave.enemies.length), [12, 8, 4]);
    assert.deepEqual(imported.waves.map(wave => wave.groupConditions.map(condition => condition.captureSource.keypoint)), [[1, 2, 3], [4, 5], [6]]);
    assert.deepEqual(imported.cards, before.cards); assert.deepEqual(imported.inventory, before.inventory);
    assert.deepEqual(imported.model, before.model);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 6);
    assert.deepEqual(await savedInput(page), imported);
    await importAutoPoint(page, 1, 2, 222);
    assert.deepEqual((await savedInput(page)).waves.map(wave => wave.enemies.length), [12, 8, 4]);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('[data-wave]').length === 3);
    assert.equal(await page.locator('#capture-auto').isChecked(), true);
    assert.equal((await savedInput(page)).waves[0].enemies[4].power, 222);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
  });
});

test('撤销自动新增组和阶段保留原组及资源的后续修改，刷新后仍可撤销', async () => {
  await withPlanner(async page => {
    await page.locator('#capture-auto').check(); await page.locator('#reset-action').click();
    await importAutoPoint(page, 1, 1); await importAutoPoint(page, 1, 3);
    await page.locator('[data-wave="0"] [data-enemy="0"] .enemy-power').fill('222');
    await page.locator('#capture-undo').click();
    let input = await savedInput(page);
    assert.equal(input.waves[0].enemies.length, 4); assert.equal(input.waves[0].enemies[0].power, 222);
    await importAutoPoint(page, 1, 2); await importAutoPoint(page, 2, 3);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('[data-wave]').length === 2);
    await page.locator('[data-item="standard_firepower"]').fill('9');
    await page.locator('#capture-undo').click();
    input = await savedInput(page);
    assert.deepEqual(input.waves.map(wave => wave.enemies.length), [8]);
    assert.equal(input.waves[0].enemies[0].power, 222); assert.equal(input.inventory.standard_firepower, 9);
    await importAutoPoint(page, 1, 4);
    await page.locator('[data-wave="0"] [data-enemy="8"] .enemy-power').fill('500');
    const changed = await savedInput(page);
    await page.locator('#capture-undo').click();
    assert.match(await page.locator('#capture-feedback').textContent(), /新增.*其他修改/);
    assert.deepEqual(await savedInput(page), changed);
  });
});

test('重置行动终止计算、保留资源设置，刷新后撤销重置不覆盖资源新修改', async () => {
  await withPlanner(async page => {
    await prepareHeavyPlanner(page);
    const before = await savedInput(page);
    await page.locator('#calculate').click(); await page.locator('#pause').click();
    await page.locator('#reset-action').click();
    let input = await savedInput(page);
    assert.deepEqual(input.waves.map(wave => wave.enemies.length), [4]);
    assert.ok(input.waves[0].enemies.every(enemy => enemy.rawPower === '' && enemy.weaknesses.length === 0 && enemy.powerIncrease === undefined));
    assert.equal(input.waves[0].groupConditions[0].captureSource, null);
    for (const key of ['cards', 'inventory', 'model', 'beamWidth', 'computeBudget', 'pauseBackground']) assert.deepEqual(input[key], before[key]);
    assert.equal(await page.locator('#cancel').isVisible(), false); assert.equal(await page.locator('#pause').isVisible(), false);
    assert.match(await page.locator('#result-panel').textContent(), /行动已重置/);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('[data-enemy]').length === 4);
    assert.equal(await page.locator('#capture-undo').textContent(), '撤销重置');
    await page.locator('[data-item="standard_firepower"]').fill('9');
    await page.locator('[data-card="missouri"] .card-health').selectOption('2');
    await page.locator('#capture-undo').click();
    input = await savedInput(page);
    assert.deepEqual(input.waves, before.waves); assert.equal(input.inventory.standard_firepower, 9);
    assert.equal(input.cards.find(card => card.cardId === 'missouri').health, 2);
    assert.match(await page.locator('#capture-feedback').textContent(), /已撤销重置/);
  });
});

test('重置取消正在读取的文件，迟到结果不能重新填回旧行动', async () => {
  await withPlanner(async page => {
    const html = await autoPointHtml(page, 1, 1, 321);
    await page.evaluate(() => {
      const read = File.prototype.text;
      File.prototype.text = function () { return read.call(this).then(text => new Promise(resolve => { window.finishOldCapture = () => resolve(text); })); };
    });
    await page.locator('#capture-file').setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from(html) });
    await page.waitForFunction(() => typeof window.finishOldCapture === 'function');
    await page.locator('#reset-action').click();
    const reset = await savedInput(page);
    await page.evaluate(() => { window.finishOldCapture(); });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await savedInput(page), reset);
    assert.match(await page.locator('#capture-feedback').textContent(), /已重置/);
  });
});

test('实时抓取按游戏标题自动新增阶段和组，无需手动选位置', async () => {
  await withPlanner(async (page, context) => {
    await page.locator('#capture-auto').check(); await page.locator('#reset-action').click();
    const html = (await autoPointHtml(page, 1, 1, 100)).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    await context.route('https://pacificfront.worldofwarships.asia/zh-sg/operations/auto-location-test', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const game = await context.newPage(); await game.goto('https://pacificfront.worldofwarships.asia/zh-sg/operations/auto-location-test');
    await game.evaluate(() => { window.open = () => null; });
    await game.addScriptTag({ content: await pairedScript(page) });
    await game.locator('#pacific-front-capture-bridge button').click();
    await game.waitForFunction(() => document.querySelector('#pacific-front-capture-bridge p').textContent.includes('已连接'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => !document.querySelector('#capture-current').disabled);
    for (const [stage, keypoint] of [[1, 1], [1, 2], [2, 3]]) {
      await game.evaluate(({ stage, keypoint }) => {
        document.querySelector('[class*="_stageInfo_"] [class*="_title_"]').textContent = `阶段${stage}`;
        document.querySelector('[class*="_headerTitle_"]').textContent = `关键据点${keypoint}`;
      }, { stage, keypoint });
      await page.locator('#capture-current').click();
      await page.waitForFunction(keypoint => document.querySelector('#capture-feedback').textContent.startsWith('已填入') &&
        document.querySelector('#capture-feedback').textContent.includes(`关键据点${keypoint}`), keypoint);
    }
    const input = await savedInput(page);
    assert.deepEqual(input.waves.map(wave => wave.enemies.length), [8, 4]);
    assert.deepEqual(input.waves.map(wave => wave.groupConditions.map(condition => condition.captureSource.keypoint)), [[1, 2], [3]]);
  });
});

test('采集状态按空闲连接、后台和抓取中降频，可见时立即刷新', async () => {
  await withPlanner(async page => {
    let connected = false, polls = 0;
    await page.route('**/capture/status', route => { polls++; return route.fulfill({ json: { connected, clientId: connected ? 'test-id' : null, result: null } }); });
    await page.route('**/capture/request', route => route.fulfill({ json: { requestId: route.request().postDataJSON().requestId } }));
    await page.addInitScript(() => {
      window.pollDelays = []; window.testHidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.testHidden });
      const timeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => { window.pollDelays.push(delay); return timeout(callback, delay, ...args); };
    });
    await page.reload();
    await page.waitForFunction(() => window.pollDelays.includes(5000));
    const idlePolls = polls;
    await page.evaluate(() => { window.pollDelays = []; window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.pollDelays.includes(20000));
    assert.ok(polls > idlePolls);
    connected = true;
    await page.evaluate(() => { window.pollDelays = []; window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.pollDelays.includes(2000));
    assert.equal(await page.locator('#capture-current').isEnabled(), true);
    await page.evaluate(() => { window.pollDelays = []; });
    await page.locator('#capture-current').click();
    await page.waitForFunction(() => window.pollDelays.includes(250));
    await page.evaluate(() => { window.pollDelays = []; document.querySelector('#planner').dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => window.pollDelays.includes(2000));
    assert.match(await page.locator('#capture-feedback').textContent(), /输入已改变/);
  });
});

async function prepareHeavyPlanner(page) {
  const cards = JSON.parse(await readFile(new URL('./data/cards.json', import.meta.url), 'utf8')).cards;
  await page.addInitScript(() => {
    window.testHidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.testHidden });
  });
  await page.evaluate(cards => {
    const input = JSON.parse(localStorage.getItem('pacific-front-planner-v1'));
    input.waves = Array.from({ length: 6 }, () => ({ enemies: Array.from({ length: 20 }, () => ({ active: true, power: 999999, rawPower: '999999', weaknesses: [] })) }));
    input.cards = cards.map(card => ({ cardId: card.id, health: 3 }));
    input.computeBudget = 0; input.pauseBackground = true;
    localStorage.setItem('pacific-front-planner-v1', JSON.stringify(input));
  }, cards);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-enemy]').length === 120);
  await page.locator('#planner').dispatchEvent('input');
}

test('计算手动暂停、后台暂停、恢复、取消和修改输入均保留正确状态', async () => {
  await withPlanner(async page => {
    await prepareHeavyPlanner(page);
    assert.equal(await page.locator('#compute-budget').inputValue(), '0');
    assert.equal(await page.locator('#pause-background').isChecked(), true);
    const before = await savedInput(page);
    await page.locator('#calculate').click();
    await page.locator('#pause').click();
    await page.waitForFunction(() => document.querySelector('#result-panel').classList.contains('compute-paused'));
    await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.locator('#pause').textContent(), '继续计算');
    assert.equal(await page.locator('#result-panel').evaluate(node => node.classList.contains('compute-paused')), true);
    await page.locator('#pause').click();
    await page.waitForFunction(() => document.querySelector('#budget-text').textContent.startsWith('已计算'));
    await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('#result-panel').classList.contains('compute-paused'));
    assert.match(await page.locator('#progress-text').textContent(), /后台/);
    const pausedBudget = await page.locator('#budget-text').textContent();
    await page.waitForTimeout(150); // A paused Worker must not accrue execution time.
    assert.equal(await page.locator('#budget-text').textContent(), pausedBudget);
    await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => !document.querySelector('#result-panel').classList.contains('compute-paused'));
    await page.locator('#cancel').click();
    assert.deepEqual(await savedInput(page), before);
    assert.equal(await page.locator('#calculate').isEnabled(), true);
    assert.equal(await page.locator('#pause').isVisible(), false);
    await page.locator('#calculate').click(); await page.locator('#pause').click();
    await page.waitForFunction(() => document.querySelector('#result-panel').classList.contains('compute-paused'));
    await page.locator('[aria-label="第1波敌军1总战力"]').fill('123');
    assert.equal(await page.locator('#calculate').isEnabled(), true);
    assert.match(await page.locator('#result-panel').textContent(), /输入已改变/);
    assert.deepEqual((await savedInput(page)).inventory, before.inventory);
  });
});

test('Worker预算结束显示未完成标记，复制方案保留警示并保存预算设置', async () => {
  await withPlanner(async page => {
    await prepareHeavyPlanner(page);
    // Only the test Worker's clock is accelerated; production budget values stay 30/60 seconds.
    const worker = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
    await page.route('**/worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `let testTime = 0; Object.defineProperty(performance, 'now', { value: () => testTime += 15000 });\n${worker}` }));
    await page.locator('.model-settings > summary').click();
    await page.locator('#compute-budget').selectOption('30');
    const before = await savedInput(page);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 30);
    assert.match(await page.locator('#result-panel').textContent(), /已达到计算预算/);
    assert.match(await page.locator('.group-result').first().textContent(), /搜索未完成/);
    assert.match(await page.locator('.group-result').last().textContent(), /尚未搜索/);
    await page.evaluate(() => { window.copiedPlan = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPlan = text; } } }); });
    await page.locator('#copy-result').click();
    assert.match(await page.evaluate(() => window.copiedPlan), /已达到计算预算/);
    assert.match(await page.evaluate(() => window.copiedPlan), /尚未搜索/);
    assert.deepEqual(await savedInput(page), before);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 30);
    assert.equal(await page.locator('#compute-budget').inputValue(), '30');
  });
});

test('双提升与水雷导入、来源、Worker计算、保存、刷新和撤销一致', async () => {
  for (const mode of ['双驱逐提升', '双驱逐区域', '水雷', '提升比例核对', '通用叠加']) await withPlanner(async page => {
    const before = await savedInput(page);
    let html = await readFile(new URL(`./html/关键区域-${mode === '双驱逐区域' ? '双驱逐提升' : mode === '通用叠加' ? '提升比例核对' : mode}.txt`, import.meta.url), 'utf8');
    if (mode === '通用叠加') html = await page.evaluate(html => {
      const template = document.createElement('template'); template.innerHTML = html;
      const conditions = template.content.querySelector('[class*="_conditions_"]');
      const headers = conditions.querySelectorAll('[class*="_subheader_"]');
      const region = headers[1].nextElementSibling;
      const global = headers[0].nextElementSibling.querySelector('[class*="_rowLabel_"]').cloneNode(true);
      global.querySelector('[class*="_pctValue_"]').textContent = '+8%'; region.replaceChildren(global);
      const typed = document.createElement('div'); typed.className = '_section_test';
      typed.innerHTML = '<div class="_label_test">敌方战力：</div><div class="_statRow_test"><img class="_shipIcon_test" src="/icon_destroyer_standard-test.webp"><span class="_statLabel_test">驱逐舰</span><span class="_pctValue_test">+16%</span></div>';
      region.append(typed);
      template.content.querySelectorAll('[class*="_enemies_"] [class*="_powerValue_"]').forEach((power, i) => { power.textContent = String([180, 213, 205, 199][i]); });
      return template.innerHTML;
    }, html);
    if (mode === '双驱逐区域') html = await page.evaluate(html => {
      const template = document.createElement('template'); template.innerHTML = html;
      template.content.querySelector('[class*="_conditions_"] [class*="_subheader_"]').textContent = '区域';
      return template.innerHTML;
    }, html);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from(html) });
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    const expected = mode === '水雷' ? [113, 180, 161, 186] : mode === '双驱逐区域' ? [235, 277, 204, 202] :
      mode === '提升比例核对' ? [145, 152, 165, 142] : mode === '通用叠加' ? [157, 188, 178, 176] : [178, 210, 204, 202];
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), expected);
    assert.match(await page.locator('#capture-feedback').textContent(), ['提升比例核对', '通用叠加'].includes(mode) ? /带入敌方战力＋16%/ : mode === '水雷' ? /驱逐舰.*16%/ : /驱逐舰.*32%/);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards); assert.deepEqual(imported.inventory, before.inventory);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 3);
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 30);
    assert.deepEqual(await savedInput(page), imported);
    await page.locator('#capture-undo').click();
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已撤销'));
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('分栏多舰种带入导入、来源说明、计算、刷新和撤销保持一致', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键据点-舰种提升重复.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [190, 191, 188, 186]);
    assert.deepEqual(imported.waves[0].groupConditions[1].captureSource.ignoredEnemyPowerIncreases,
      [{ type: 'destroyer', rate: 0.16 }, { type: 'battleship', rate: 0.16 }]);
    assert.match(await page.locator('#capture-feedback').textContent(), /驱逐舰/);
    assert.match(await page.locator('#capture-feedback').textContent(), /战列舰/);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards); assert.deepEqual(imported.inventory, before.inventory);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 3);
    assert.match(await page.locator('.group-result').nth(1).textContent(), /敌方最终战力/);
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 30);
    assert.deepEqual(await savedInput(page), imported);
    await page.locator('#capture-undo').click();
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已撤销'));
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('Worker复用相同输入的搜索结果，页面说明准确且不修改保存输入', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => document.querySelectorAll('.group-result').length === 3);
    const footers = await page.locator('.group-result .result-footer').allTextContents();
    assert.match(footers[0], /检查 .* 个搜索分支/);
    assert.match(footers[1], /复用相同输入的搜索结果/);
    assert.match(footers[2], /复用相同输入的搜索结果/);
    assert.deepEqual(await savedInput(page), before);
    assert.equal(await page.locator('#calculate').isEnabled(), true);
    assert.equal(await page.locator('#cancel').isVisible(), false);
  });
});

test('四种增益减益条件导入、Worker显示、保存和撤销保持一致', async () => {
  for (const [label, percent, flag, display] of [
    ['增益效果', '-50%', 'buffsReduced', '增益效果减少50%'],
    ['增益效果', '-100%', 'buffsDisabled', '增益失效'],
    ['减益效果', '-50%', 'debuffsReduced', '减益效果减少50%'],
    ['减益效果', '-100%', 'debuffsDisabled', '减益失效'],
  ]) await withPlanner(async page => {
    const before = await savedInput(page);
    const html = await readFile(new URL('./html/关键区域-减益--50%25.txt', import.meta.url), 'utf8');
    const source = await page.evaluate(({ html, label, percent }) => {
      const template = document.createElement('template'); template.innerHTML = html;
      const header = [...template.content.querySelectorAll('[class*="_subheader_"]')].find(node => node.textContent.trim() === '区域');
      const row = header.nextElementSibling.querySelector('[class*="_statRow_"]');
      row.querySelector('[class*="_statLabel_"]').textContent = label;
      row.querySelector('[class*="_pctValue_"]').textContent = percent;
      return template.innerHTML;
    }, { html, label, percent });
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles({ name: 'effect-condition.html', mimeType: 'text/html', buffer: Buffer.from(source) });
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page), condition = imported.waves[0].groupConditions[1];
    for (const key of ['buffsDisabled', 'debuffsDisabled', 'buffsReduced', 'debuffsReduced']) assert.equal(condition[key], key === flag);
    assert.deepEqual(condition.global, { firepower: 0, survivability: 0, mobility: 0 });
    assert.equal(await page.locator(`[aria-label="第1波第2组${display}"]`).isChecked(), true);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [177, 186, 154, 171]);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[0].groupConditions[0], before.waves[0].groupConditions[0]);
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#copy-result')));
    assert.ok((await page.locator('#result-panel .group-result').nth(1).textContent()).includes(`本组战场条件：${display}`));
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
    assert.equal(await page.locator(`[aria-label="第1波第2组${display}"]`).isChecked(), true);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('修改后续波次人数及增删波次保留已有折叠状态和输入', async () => {
  await withPlanner(async page => {
    const opened = () => page.locator('#enemies .wave-input').evaluateAll(waves => waves.map(wave => wave.open));
    assert.deepEqual(await opened(), [true, false]);
    await page.locator('[aria-label="第1波敌军数量"]').selectOption('20');
    const before = await savedInput(page);
    await page.locator('[data-wave="0"] > summary').click();
    await page.locator('[data-wave="1"] > summary').click();
    assert.deepEqual(await opened(), [false, true]);
    await page.locator('[aria-label="第2波敌军数量"]').selectOption('12');
    assert.deepEqual(await opened(), [false, true]);
    await page.locator('#add-wave').click();
    assert.deepEqual(await opened(), [false, true, true]);
    await page.locator('[data-wave="1"] > summary').click();
    await page.locator('[aria-label="第3波敌军数量"]').selectOption('20');
    assert.deepEqual(await opened(), [false, false, true]);
    const changed = await savedInput(page);
    assert.deepEqual(changed.waves[0], before.waves[0]);
    assert.equal(changed.waves[1].enemies.length, 12);
    assert.equal(changed.waves[2].enemies.length, 20);
    assert.deepEqual(changed.cards, before.cards);
    assert.deepEqual(changed.inventory, before.inventory);
    await page.locator('[data-wave="2"] > summary').click();
    assert.deepEqual(await opened(), [false, false, false]);
    await page.locator('#add-wave').click();
    assert.deepEqual(await opened(), [false, false, false, true]);
    await page.locator('#remove-wave').click();
    assert.deepEqual(await opened(), [false, false, false]);
  });
});

test('岸防炮提升样本导入、中文来源、计算、保存和撤销正确', async () => {
  await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-存在未知战力提升图标-岸防炮.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [177, 187, 204, 201]);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.powerIncrease), [0.16, 0.16, 0.16, 0]);
    assert.match(await page.locator('.capture-source').textContent(), /区域敌方岸防炮战力＋16%/);
    assert.equal(await page.locator('[aria-label*="允许岸防炮"]').count(), 0);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[0].groupConditions[0], before.waves[0].groupConditions[0]);
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#copy-result')));
    assert.match(await page.locator('#result-panel').textContent(), /区域敌方岸防炮战力＋16%/);
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.match(await page.locator('.capture-source').textContent(), /区域敌方岸防炮战力＋16%/);
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('两层增益样本导入、来源、Worker计算、保存和撤销保持一致', async () => {
  for (const [file, powers, increases] of [
    ['多项带入敌方提升叠加', [131, 154, 146, 137], [undefined, undefined, undefined, undefined]],
    ['既有带入又有区域提升叠加', [145, 164, 161, 153], [0, 0, 0.16, 0]],
  ]) await withPlanner(async page => {
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL(`./html/关键区域-${file}.txt`, import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), powers);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.powerIncrease), increases);
    assert.match(await page.locator('.capture-source').textContent(), /带入.*驱逐舰.*16%.*(?:已还原|已去除).*带入.*8%.*(?:已还原|已去除)/);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    assert.equal(await page.locator('[aria-label*="允许潜艇"]').count(), 0);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#copy-result')));
    if (file.startsWith('既有')) {
      assert.match(await page.locator('.capture-source').textContent(), /区域.*潜艇.*16%/);
      assert.match(await page.locator('.capture-source').textContent(), /已去除带入，保留区域增益/);
      assert.match(await page.locator('#result-panel').textContent(), /敌方原战力139.*区域战力＋16%/);
    }
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

test('增益失效样本导入目标组后保存、计算和撤销，保留其他组与资源', async () => {
  await withPlanner(async page => {
    await page.locator('[aria-label="第1波第2组增益失效"]').uncheck();
    const before = await savedInput(page);
    await page.locator('#capture-target').selectOption('0:1');
    await page.locator('#capture-file').setInputFiles(fileURLToPath(new URL('./html/关键区域-增益效果-100%25.txt', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#capture-feedback').textContent.startsWith('已填入'));
    const imported = await savedInput(page);
    assert.deepEqual(imported.waves[0].enemies.slice(4).map(enemy => enemy.power), [151, 126, 153, 120]);
    assert.equal(imported.waves[0].groupConditions[1].buffsDisabled, true);
    assert.equal(imported.waves[0].groupConditions[1].captureSource.ignoredEnemyPowerIncrease, 0.08);
    assert.equal(await page.locator('[aria-label="第1波第2组增益失效"]').isChecked(), true);
    assert.deepEqual(imported.waves[0].enemies.slice(0, 4), before.waves[0].enemies.slice(0, 4));
    assert.deepEqual(imported.waves[0].groupConditions[0], before.waves[0].groupConditions[0]);
    assert.deepEqual(imported.waves[1], before.waves[1]);
    assert.deepEqual(imported.cards, before.cards);
    assert.deepEqual(imported.inventory, before.inventory);
    await page.locator('#calculate').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#copy-result')));
    assert.match(await page.locator('#result-panel').textContent(), /本组战场条件：增益失效/);
    assert.deepEqual(await savedInput(page), imported);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('.capture-source')));
    assert.equal(await page.locator('[aria-label="第1波第2组增益失效"]').isChecked(), true);
    assert.deepEqual((await savedInput(page)).waves, imported.waves);
    await page.locator('#capture-undo').click();
    assert.deepEqual((await savedInput(page)).waves, before.waves);
  });
});

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
