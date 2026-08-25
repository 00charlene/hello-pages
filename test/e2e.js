/* test/e2e.js ─ 用真實瀏覽器跑一遍完整使用者流程
 *
 *   npm test                          # 測本機檔案（預設）
 *   SITE=https://…/ npm test          # 測已上線的網站
 *
 * 有設 ANTHROPIC_API_KEY 時會連同 AI 辨識一起測（會真的呼叫 API，約 3 次）；
 * 沒設的話會自動跳過那幾項，其餘照跑。
 */
'use strict';

const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const FIXTURE = path.join(__dirname, 'fixtures', 'vocab-sample.jpg');
const KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_TIMEOUT = 180000;

let pass = 0, failed = 0, skipped = 0;
const problems = [];

const check = (name, ok, extra = '') => {
  ok ? pass++ : (failed++, problems.push(`${name} → ${extra}`));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + extra}`);
};
const skip = (name, why) => {
  skipped++;
  console.log(`SKIP  ${name}  （${why}）`);
};
const head = (t) => console.log(`\n=== ${t} ===`);

/* ── 內建靜態伺服器：不必另外開一個 terminal ── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serveRoot() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(ROOT, path.normalize(rel));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}

(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const local = process.env.SITE ? null : await serveRoot();
  const SITE = process.env.SITE || local.url;
  console.log(`測試目標：${SITE}`);
  console.log(KEY ? 'API key：已設定，會測 AI 辨識' : 'API key：未設定，AI 相關項目會跳過');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n), fullPage: true });

  const consoleErrors = [], pageErrors = [], failedReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => failedReqs.push(`${r.url()} ${r.failure()?.errorText}`));

  try {
    head('1. 首次載入');
    const resp = await page.goto(SITE, { waitUntil: 'networkidle' });
    check('頁面回應 200', resp.status() === 200, String(resp.status()));
    check('標題正確', (await page.title()) === '單字練習室', await page.title());
    check('沒有未捕捉的 JS 錯誤', pageErrors.length === 0, pageErrors.join(' | '));
    check('沒有載入失敗的資源', failedReqs.length === 0, failedReqs.join(' | '));
    check('計數器歸零', (await page.textContent('#statTotal')) === '0');
    check('空狀態提示出現', /單字庫還是空的/.test(await page.textContent('#wordList')));
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('CSS 已套用（深色背景）', bg === 'rgb(20, 20, 20)', bg);
    // 迴歸測試：hidden 曾經被 .modal{display:grid} / .btn-row{display:flex} 蓋過去
    const leaked = await page.evaluate(() => [...document.querySelectorAll('[hidden]')]
      .filter(el => getComputedStyle(el).display !== 'none')
      .map(el => el.id || el.className));
    check('掛了 hidden 的元素真的都隱藏', leaked.length === 0, leaked.join(', '));
    await shot('01-載入.png');

    head('2. 新增單字');
    await page.fill('#fWord', 'resilient');
    await page.fill('#fMeaning', '有韌性的');
    await page.click('#btnSaveOne');
    check('單筆新增成功', /已加入/.test(await page.textContent('#statusOne')), await page.textContent('#statusOne'));
    check('計數器 +1', (await page.textContent('#statTotal')) === '1');
    check('表單已清空', (await page.inputValue('#fWord')) === '');

    await page.fill('#fWord', 'RESILIENT');
    await page.click('#btnSaveOne');
    check('重複的字不會變成兩筆（大小寫不敏感）',
      (await page.textContent('#statTotal')) === '1' && /原本就在單字庫/.test(await page.textContent('#statusOne')),
      await page.textContent('#statusOne'));

    await page.fill('#fBulk', 'mitigate = 減輕\nubiquitous = 無所不在的\n\nambiguous ＝ 模稜兩可的');
    await page.uncheck('#bulkEnrich');
    await page.click('#btnSaveBulk');
    check('批次新增（含空行與全形等號）', (await page.textContent('#statTotal')) === '4',
      await page.textContent('#statTotal'));
    await shot('02-新增單字.png');

    head('3. 設定');
    await page.click('.tab[data-tab="settings"]');
    check('設定頁顯示', await page.isVisible('.panel[data-panel="settings"] .card'));
    check('key 欄位預設是密碼型', (await page.getAttribute('#fKey', 'type')) === 'password');
    check('模型選單有三個選項', (await page.locator('#fModel option').count()) === 3);
    check('預設模型是 Opus 5', (await page.inputValue('#fModel')) === 'claude-opus-5');
    if (KEY) {
      await page.fill('#fKey', KEY);
      await page.click('#btnSaveCfg');
      check('設定已儲存', /已儲存/.test(await page.textContent('#statusCfg')));
      await page.click('#btnTestCfg');
      await page.waitForFunction(
        () => !/正在呼叫/.test(document.querySelector('#statusCfg').textContent), { timeout: 90000 });
      const msg = await page.textContent('#statusCfg');
      check('測試連線成功', /連線成功/.test(msg), msg);
      check('key 沒有出現在畫面文字裡', !(await page.textContent('body')).includes(KEY.slice(0, 20)));
    } else {
      skip('測試連線 / key 儲存', '沒有 ANTHROPIC_API_KEY');
    }
    await shot('03-設定.png');

    head('4. 照片上傳與框選');
    await page.click('.tab[data-tab="photo"]');
    check('初始為空狀態', await page.isVisible('#photoEmpty'));
    await page.setInputFiles('#fPhoto', FIXTURE);
    await page.waitForSelector('#photoStage:not([hidden])', { timeout: 15000 });
    check('圖片載入後顯示舞台', await page.isVisible('#photoImg'));
    check('狀態列顯示原圖尺寸', /1000×300/.test(await page.textContent('#statusPhoto')),
      await page.textContent('#statusPhoto'));
    check('框選按鈕預設停用', await page.isDisabled('#btnScanBoxes'));
    await shot('04-照片載入.png');

    const lb = await page.locator('#boxLayer').boundingBox();
    const drag = async (x1, y1, x2, y2) => {
      await page.mouse.move(lb.x + lb.width * x1, lb.y + lb.height * y1);
      await page.mouse.down();
      await page.mouse.move(lb.x + lb.width * (x1 + x2) / 2, lb.y + lb.height * (y1 + y2) / 2, { steps: 5 });
      await page.mouse.move(lb.x + lb.width * x2, lb.y + lb.height * y2, { steps: 5 });
      await page.mouse.up();
    };

    await drag(0.02, 0.08, 0.78, 0.32);
    check('拖曳產生第 1 個框', (await page.locator('#boxLayer .sel-box').count()) === 1);
    await drag(0.02, 0.60, 0.62, 0.92);
    check('拖曳產生第 2 個框', (await page.locator('#boxLayer .sel-box').count()) === 2);
    check('框有編號', (await page.textContent('#boxLayer .sel-box .tag')) === '1');
    check('計數顯示 2', (await page.textContent('#boxCount')) === '2');
    check('框選按鈕已啟用', !(await page.isDisabled('#btnScanBoxes')));
    // 框存的是 0~1 比例，不是像素 —— 圖片被縮放後才對得回原圖
    const geo = await page.locator('#boxLayer .sel-box').first().evaluate(el => el.style.left + ' ' + el.style.width);
    check('框以百分比定位（縮放後仍準確）', /%/.test(geo), geo);
    await shot('05-框選兩處.png');

    await drag(0.90, 0.05, 0.905, 0.06);
    check('太小的框被拒絕', (await page.locator('#boxLayer .sel-box').count()) === 2 &&
      /太小/.test(await page.textContent('#statusPhoto')), await page.textContent('#statusPhoto'));

    // 貼齊上緣的框，✕ 會突出到圖片外；確認中心仍可點擊
    const killHit = await page.evaluate(() => {
      const k = document.querySelector('#boxLayer .sel-box .kill');
      const r = k.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === k;
    });
    check('框的 ✕ 刪除鈕可點擊', killHit);

    let total = 4;
    if (KEY) {
      head('5. 框選辨識（會呼叫 API）');
      await page.click('#btnScanBoxes');
      await page.waitForSelector('#candCard:not([hidden])', { timeout: AI_TIMEOUT });
      const candCount = await page.locator('#candList .cand').count();
      const candWords = await page.locator('#candList .ce-word').evaluateAll(els => els.map(e => e.value));
      check('辨識出候選單字', candCount > 0, String(candCount));
      console.log('      辨識結果：', candWords.join(', '));
      check('有標出來自第幾個框', (await page.locator('#candList .chip').count()) > 0);
      check('候選內容可直接編輯', await page.locator('#candList .ce-word').first().isEditable());
      await shot('06-辨識結果.png');

      const wordsBefore = await page.evaluate(() => Store.all().map(w => w.word.toLowerCase()));
      const before = parseInt(await page.textContent('#statTotal'), 10);
      const dropped = candWords[0].toLowerCase();
      const kept = candWords.slice(1).map(w => w.toLowerCase());
      await page.locator('#candList .cand input[type=checkbox]').first().uncheck();
      check('取消勾選會變灰',
        await page.locator('#candList .cand').first().evaluate(e => e.classList.contains('is-off')));
      await page.click('#btnCandSave');
      const wordsAfter = await page.evaluate(() => Store.all().map(w => w.word.toLowerCase()));
      total = parseInt(await page.textContent('#statTotal'), 10);
      check('勾選的字全部進了單字庫', kept.every(w => wordsAfter.includes(w)),
        kept.filter(w => !wordsAfter.includes(w)).join(', '));
      check('沒勾的字沒有被加入', wordsBefore.includes(dropped) || !wordsAfter.includes(dropped), dropped);
      const expectedNew = kept.filter(w => !wordsBefore.includes(w)).length;
      check('已存在的字合併而非重複新增', total === before + expectedNew,
        `${before} → ${total}，預期新增 ${expectedNew}`);
      check('單字庫沒有重複項目', new Set(wordsAfter).size === wordsAfter.length);
      check('候選清單已清空', await page.isHidden('#candCard'));

      head('6. 整張圖掃描（會呼叫 API）');
      await page.click('#btnScanAll');
      await page.waitForSelector('#candCard:not([hidden])', { timeout: AI_TIMEOUT });
      check('整張圖也能辨識', (await page.locator('#candList .cand').count()) > 0);
      console.log('      整張圖找到：',
        (await page.locator('#candList .ce-word').evaluateAll(e => e.map(x => x.value))).join(', '));
      await page.click('#btnCandDrop');
      check('「丟掉這批結果」可運作', await page.isHidden('#candCard'));
    } else {
      skip('框選辨識 / 整張圖掃描 / 候選清單', '沒有 ANTHROPIC_API_KEY');
    }

    head('7. 我的單字');
    await page.click('.tab[data-tab="list"]');
    check('列表顯示所有單字', (await page.locator('#wordList .word').count()) === total,
      `${await page.locator('#wordList .word').count()} vs ${total}`);
    await page.fill('#qSearch', 'resilient');
    check('可用單字搜尋', (await page.locator('#wordList .word').count()) === 1);
    await page.fill('#qSearch', '有韌性');
    check('可用意思搜尋', (await page.locator('#wordList .word').count()) === 1);
    await page.fill('#qSearch', 'zzz-不存在');
    check('查無結果有提示', /沒有符合條件/.test(await page.textContent('#wordList')));
    await page.fill('#qSearch', '');
    await page.selectOption('#qSort', 'az');
    const first = await page.textContent('#wordList .word b');
    check('可依字母排序', first === 'ambiguous', first);
    await shot('07-我的單字.png');

    await page.locator('#wordList .word [data-act="edit"]').first().click();
    check('編輯彈窗開啟並帶入內容', await page.isVisible('#editModal') &&
      (await page.inputValue('#eWord')) === 'ambiguous', await page.inputValue('#eWord'));
    await page.fill('#eWord', 'mitigate');
    await page.click('#btnEditSave');
    check('撞名會被擋下', /已經有/.test(await page.textContent('#statusEdit')), await page.textContent('#statusEdit'));
    await page.fill('#eWord', 'ambiguous');
    await page.fill('#eNote', 'E2E 測試備註');
    await page.click('#btnEditSave');
    check('編輯已儲存', await page.isHidden('#editModal') && /E2E 測試備註/.test(await page.textContent('#wordList')));

    page.once('dialog', d => d.accept());
    const beforeDel = await page.locator('#wordList .word').count();
    await page.locator('#wordList .word [data-act="del"]').first().click();
    check('刪除可運作', (await page.locator('#wordList .word').count()) === beforeDel - 1);

    head('8. 複習一輪');
    await page.click('.tab[data-tab="review"]');
    await page.selectOption('#rMode', 'en2zh');
    await page.selectOption('#rScope', 'all');
    await page.selectOption('#rSize', '10');
    await page.click('#btnStartReview');
    check('複習開始', await page.isVisible('#reviewStage'));
    const qTotal = parseInt((await page.textContent('#rCount')).split('/')[1], 10);
    check('題數合理', qTotal > 0, await page.textContent('#rCount'));
    check('答案預設隱藏', await page.isHidden('#rBack'));
    check('沒 reveal 前不顯示評分按鈕', await page.isHidden('#rGradeRow'));
    await shot('08-複習題目.png');
    await page.click('#btnReveal');
    check('顯示答案', await page.isVisible('#rBack'));
    check('評分按鈕出現', await page.isVisible('#rGradeRow'));
    await shot('09-複習答案.png');
    for (let i = 0; i < qTotal; i++) {
      if (await page.isHidden('#reviewStage')) break;
      if (await page.isVisible('#rRevealRow')) await page.click('#btnReveal');
      await page.click(i % 3 === 0 ? '#btnWrong' : '#btnRight');
    }
    check('複習完成頁出現', await page.isVisible('#reviewDone'));
    check('分數有顯示', /答對/.test(await page.textContent('#rScore')), await page.textContent('#rScore'));
    await shot('10-複習結算.png');

    head('9. 資料持久化');
    const beforeReload = await page.textContent('#statTotal');
    await page.reload({ waitUntil: 'networkidle' });
    check('重新載入後單字還在', (await page.textContent('#statTotal')) === beforeReload,
      `${beforeReload} → ${await page.textContent('#statTotal')}`);
    check('答對的字被排到未來（待複習 < 總數）',
      parseInt(await page.textContent('#statDue'), 10) < parseInt(beforeReload, 10),
      `待複習 ${await page.textContent('#statDue')} / 總數 ${beforeReload}`);

    check('全程無 console 錯誤', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('全程無未捕捉的例外', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    head('10. 手機（iPhone 13，觸控）');
    const mctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-TW' });
    const m = await mctx.newPage();
    const mErrors = [];
    m.on('pageerror', e => mErrors.push(e.message));
    await m.goto(SITE, { waitUntil: 'networkidle' });
    check('沒有橫向溢出', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      await m.evaluate(() => `scrollW=${document.documentElement.scrollWidth} vw=${window.innerWidth}`));
    await m.screenshot({ path: path.join(SHOTS, '11-手機首頁.png'), fullPage: true });
    await m.click('.tab[data-tab="photo"]');
    await m.setInputFiles('#fPhoto', FIXTURE);
    await m.waitForSelector('#photoStage:not([hidden])', { timeout: 15000 });
    const mb = await m.locator('#boxLayer').boundingBox();
    await m.evaluate(({ b }) => {
      const layer = document.querySelector('#boxLayer');
      const fire = (type, x, y) => layer.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true,
      }));
      const x1 = b.x + b.width * 0.05, y1 = b.y + b.height * 0.1;
      const x2 = b.x + b.width * 0.8, y2 = b.y + b.height * 0.5;
      fire('pointerdown', x1, y1);
      fire('pointermove', (x1 + x2) / 2, (y1 + y2) / 2);
      fire('pointermove', x2, y2);
      fire('pointerup', x2, y2);
    }, { b: mb });
    check('觸控拖曳也能框選', (await m.locator('#boxLayer .sel-box').count()) === 1,
      String(await m.locator('#boxLayer .sel-box').count()));
    await m.screenshot({ path: path.join(SHOTS, '12-手機框選.png'), fullPage: true });
    check('手機版無 JS 錯誤', mErrors.length === 0, mErrors.join(' | '));
  } finally {
    await browser.close();
    if (local) local.close();
  }

  console.log(`\n─────────────`);
  console.log(`通過 ${pass} / ${pass + failed}${skipped ? `，跳過 ${skipped}` : ''}`);
  console.log(`截圖：${path.relative(ROOT, SHOTS)}/`);
  if (problems.length) {
    console.log('\n需要處理：\n' + problems.map(p => '  · ' + p).join('\n'));
    process.exit(1);
  }
})().catch(e => {
  console.error('\n測試中斷：', e.message);
  process.exit(1);
});
