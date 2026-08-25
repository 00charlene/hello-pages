/* store.js ─ 單字資料層
 * 全部資料都放在這台裝置的 localStorage，沒有伺服器。
 * 複習排程用 Leitner 盒子法：答對往上一盒（間隔變長），答錯掉回第一盒。
 */
(function (global) {
  'use strict';

  var WORDS_KEY = 'vocab.words.v1';
  var CFG_KEY = 'vocab.config.v1';

  /* 盒子編號 → 下次複習間隔（天）。最後一盒視為「已掌握」。 */
  var INTERVALS = [0, 1, 2, 4, 8, 16, 32];
  var MAX_BOX = INTERVALS.length - 1;
  var MASTER_BOX = 5;               // 到這一盒就算已掌握
  var DAY = 86400000;

  var MODELS = [
    { id: 'claude-opus-5', label: 'Claude Opus 5（最準，預設）', effort: true },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5（較快較便宜）', effort: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（最便宜）', effort: false }
  ];

  var DEFAULT_CFG = {
    apiKey: '',
    model: 'claude-opus-5',
    learnLang: '英文',
    nativeLang: '繁體中文'
  };

  var words = [];
  var config = Object.assign({}, DEFAULT_CFG);

  /* ───────── 內部工具 ───────── */

  function uid() {
    return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function str(v) {
    return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  }

  function key(word) {
    return str(word).toLowerCase().replace(/\s+/g, ' ');
  }

  function readJSON(k, fallback) {
    try {
      var raw = global.localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('讀取 ' + k + ' 失敗：', e);
      return fallback;
    }
  }

  function writeJSON(k, value) {
    try {
      global.localStorage.setItem(k, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('寫入 ' + k + ' 失敗：', e);
      return false;
    }
  }

  /* 把任意來源的物件正規化成一筆完整的單字紀錄 */
  function normalize(raw) {
    var w = raw || {};
    var box = Number(w.box);
    if (!isFinite(box) || box < 0) box = 0;
    if (box > MAX_BOX) box = MAX_BOX;

    return {
      id: str(w.id) || uid(),
      word: str(w.word),
      phonetic: str(w.phonetic),
      pos: str(w.pos),
      meaning: str(w.meaning),
      example: str(w.example),
      exampleZh: str(w.exampleZh || w.example_zh),
      note: str(w.note),
      source: str(w.source) || 'manual',
      box: box,
      due: Number(w.due) || 0,
      seen: Number(w.seen) || 0,
      right: Number(w.right) || 0,
      wrong: Number(w.wrong) || 0,
      createdAt: Number(w.createdAt) || Date.now(),
      reviewedAt: Number(w.reviewedAt) || 0
    };
  }

  function persist() {
    return writeJSON(WORDS_KEY, words);
  }

  /* ───────── 生命週期 ───────── */

  function load() {
    var savedWords = readJSON(WORDS_KEY, []);
    words = (Array.isArray(savedWords) ? savedWords : [])
      .map(normalize)
      .filter(function (w) { return w.word; });

    var savedCfg = readJSON(CFG_KEY, {});
    config = Object.assign({}, DEFAULT_CFG, savedCfg && typeof savedCfg === 'object' ? savedCfg : {});
    if (!MODELS.some(function (m) { return m.id === config.model; })) {
      config.model = DEFAULT_CFG.model;
    }
  }

  /* ───────── 設定 ───────── */

  function getConfig() {
    return Object.assign({}, config);
  }

  function setConfig(patch) {
    config = Object.assign({}, config, patch || {});
    writeJSON(CFG_KEY, config);
    return getConfig();
  }

  function modelInfo(id) {
    var wanted = id || config.model;
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === wanted) return MODELS[i];
    }
    return MODELS[0];
  }

  /* ───────── 讀取 ───────── */

  function all() {
    return words.slice();
  }

  function get(id) {
    for (var i = 0; i < words.length; i++) {
      if (words[i].id === id) return words[i];
    }
    return null;
  }

  function findByWord(word) {
    var k = key(word);
    if (!k) return null;
    for (var i = 0; i < words.length; i++) {
      if (key(words[i].word) === k) return words[i];
    }
    return null;
  }

  function isDue(w, now) {
    return w.due <= (now || Date.now());
  }

  function isMastered(w) {
    return w.box >= MASTER_BOX;
  }

  function stats() {
    var now = Date.now();
    var due = 0, mastered = 0, fresh = 0;
    words.forEach(function (w) {
      if (isDue(w, now)) due++;
      if (isMastered(w)) mastered++;
      if (!w.seen) fresh++;
    });
    return { total: words.length, due: due, mastered: mastered, fresh: fresh };
  }

  function bytes() {
    try {
      var a = (global.localStorage.getItem(WORDS_KEY) || '').length;
      var b = (global.localStorage.getItem(CFG_KEY) || '').length;
      return a + b;
    } catch (e) {
      return 0;
    }
  }

  /* ───────── 寫入 ───────── */

  /* 回傳 {status:'added'|'merged'|'skipped', word} */
  function add(raw, opts) {
    var options = opts || {};
    var rec = normalize(raw);
    if (!rec.word) return { status: 'skipped', reason: 'empty', word: null };

    var existing = findByWord(rec.word);
    if (existing) {
      if (!options.merge) return { status: 'skipped', reason: 'duplicate', word: existing };
      /* 只補上原本空白的欄位，不覆蓋使用者已經寫好的內容 */
      ['phonetic', 'pos', 'meaning', 'example', 'exampleZh', 'note'].forEach(function (f) {
        if (!existing[f] && rec[f]) existing[f] = rec[f];
      });
      persist();
      return { status: 'merged', word: existing };
    }

    words.push(rec);
    persist();
    return { status: 'added', word: rec };
  }

  function addMany(list, opts) {
    var result = { added: 0, merged: 0, skipped: 0, words: [] };
    (list || []).forEach(function (raw) {
      var r = add(raw, opts);
      if (r.status === 'added') { result.added++; result.words.push(r.word); }
      else if (r.status === 'merged') { result.merged++; result.words.push(r.word); }
      else result.skipped++;
    });
    return result;
  }

  function update(id, patch) {
    var w = get(id);
    if (!w) return null;
    var merged = normalize(Object.assign({}, w, patch, { id: w.id }));
    var idx = words.indexOf(w);
    words[idx] = merged;
    persist();
    return merged;
  }

  function remove(id) {
    var w = get(id);
    if (!w) return false;
    words.splice(words.indexOf(w), 1);
    persist();
    return true;
  }

  function clear() {
    words = [];
    persist();
  }

  /* 記錄一次作答，重新排下次複習時間 */
  function grade(id, correct) {
    var w = get(id);
    if (!w) return null;
    var now = Date.now();

    w.seen++;
    w.reviewedAt = now;
    if (correct) {
      w.right++;
      w.box = Math.min(w.box + 1, MAX_BOX);
    } else {
      w.wrong++;
      w.box = 0;
    }
    /* 第 0 盒間隔是 0 天 → 同一輪之後還會再遇到 */
    w.due = now + INTERVALS[w.box] * DAY;
    persist();
    return w;
  }

  /* ───────── 出題 ───────── */

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* scope: 'due' | 'all' | 'weak' */
  function buildQueue(scope, size) {
    var now = Date.now();
    var pool = words.slice();

    if (scope === 'due') {
      pool = pool.filter(function (w) { return isDue(w, now); });
    } else if (scope === 'weak') {
      pool.sort(function (a, b) {
        if (a.box !== b.box) return a.box - b.box;
        return (b.wrong - b.right) - (a.wrong - a.right);
      });
      pool = pool.slice(0, Math.max(size * 3, size));
    }

    if (scope === 'due') {
      pool.sort(function (a, b) {
        if (a.box !== b.box) return a.box - b.box;
        return a.due - b.due;
      });
      pool = pool.slice(0, Math.max(size * 2, size));
    }

    return shuffle(pool).slice(0, size);
  }

  /* ───────── 匯出 / 匯入 ───────── */

  function exportData() {
    return JSON.stringify({
      app: 'vocab-practice',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: words.length,
      words: words
    }, null, 2);
  }

  /* 匯入不刪除既有資料，同一個字會補齊空欄位 */
  function importData(text) {
    var data = JSON.parse(text);
    var list = Array.isArray(data) ? data : (data && Array.isArray(data.words) ? data.words : null);
    if (!list) throw new Error('檔案裡找不到 words 陣列');

    var report = { added: 0, merged: 0, skipped: 0 };
    list.forEach(function (raw) {
      var rec = normalize(raw);
      if (!rec.word) { report.skipped++; return; }
      var existing = findByWord(rec.word);
      if (existing) {
        ['phonetic', 'pos', 'meaning', 'example', 'exampleZh', 'note'].forEach(function (f) {
          if (!existing[f] && rec[f]) existing[f] = rec[f];
        });
        /* 保留進度較好的那一份 */
        if (rec.box > existing.box) { existing.box = rec.box; existing.due = rec.due; }
        existing.seen += rec.seen;
        existing.right += rec.right;
        existing.wrong += rec.wrong;
        report.merged++;
      } else {
        words.push(rec);
        report.added++;
      }
    });
    persist();
    return report;
  }

  global.Store = {
    INTERVALS: INTERVALS,
    MAX_BOX: MAX_BOX,
    MASTER_BOX: MASTER_BOX,
    MODELS: MODELS,
    load: load,
    getConfig: getConfig,
    setConfig: setConfig,
    modelInfo: modelInfo,
    all: all,
    get: get,
    findByWord: findByWord,
    isDue: isDue,
    isMastered: isMastered,
    stats: stats,
    bytes: bytes,
    add: add,
    addMany: addMany,
    update: update,
    remove: remove,
    clear: clear,
    grade: grade,
    buildQueue: buildQueue,
    exportData: exportData,
    importData: importData
  };
})(window);
