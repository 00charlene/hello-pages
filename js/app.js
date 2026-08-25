/* app.js ─ 介面邏輯：分頁、新增、照片框選、列表、複習、設定 */
(function (global) {
  'use strict';

  var Store = global.Store;
  var AI = global.AI;

  /* ───────── 小工具 ───────── */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function setStatus(sel, msg, kind) {
    var el = $(sel);
    if (!el) return;
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = kind === 'busy' ? '<span class="spinner"></span>' + esc(msg) : esc(msg);
  }

  /* 把按鈕鎖住並顯示轉圈，回傳解鎖函式 */
  function busy(btn, label) {
    if (!btn) return function () {};
    var original = btn.innerHTML;
    btn.classList.add('is-busy');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + esc(label || '處理中…');
    return function () {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      btn.innerHTML = original;
    };
  }

  function plural(n, unit) { return n + ' ' + (unit || '個'); }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function dueLabel(w) {
    var diff = w.due - Date.now();
    if (diff <= 0) return { text: '待複習', due: true };
    var days = Math.ceil(diff / 86400000);
    return { text: days <= 1 ? '明天' : days + ' 天後', due: false };
  }

  /* AI 回來的 snake_case 欄位轉成 store 用的格式 */
  function fromAI(raw, source) {
    return {
      word: raw.word,
      phonetic: raw.phonetic,
      pos: raw.pos,
      meaning: raw.meaning,
      example: raw.example,
      exampleZh: raw.example_zh,
      note: raw.note,
      source: source || 'ai'
    };
  }

  /* ───────── 分頁 ───────── */

  function showTab(name) {
    $$('#tabs .tab').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tab === name);
    });
    $$('.panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
    if (name === 'list') renderList();
    if (name === 'review') resetReviewSetup();
    if (name === 'settings') $('#statBytes').textContent = fmtBytes(Store.bytes());
    try { global.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { global.scrollTo(0, 0); }
  }

  function refreshStats() {
    var s = Store.stats();
    $('#statTotal').textContent = s.total;
    $('#statDue').textContent = s.due;
    $('#statMastered').textContent = s.mastered;
  }

  /* ───────── 新增單字：單筆 ───────── */

  var ONE_FIELDS = {
    word: '#fWord', phonetic: '#fPhonetic', pos: '#fPos',
    meaning: '#fMeaning', example: '#fExample', exampleZh: '#fExampleZh', note: '#fNote'
  };

  function readOne() {
    var out = {};
    Object.keys(ONE_FIELDS).forEach(function (k) { out[k] = $(ONE_FIELDS[k]).value.trim(); });
    return out;
  }

  function writeOne(data) {
    Object.keys(ONE_FIELDS).forEach(function (k) { $(ONE_FIELDS[k]).value = data && data[k] ? data[k] : ''; });
  }

  function initAddOne() {
    $('#btnSaveOne').addEventListener('click', function () {
      var data = readOne();
      if (!data.word) {
        setStatus('#statusOne', '至少要填單字。', 'err');
        $('#fWord').focus();
        return;
      }
      data.source = 'manual';
      var r = Store.add(data, { merge: true });
      if (r.status === 'skipped') {
        setStatus('#statusOne', '這個字沒辦法加入，檢查一下內容。', 'err');
        return;
      }
      writeOne(null);
      $('#fWord').focus();
      refreshStats();
      setStatus('#statusOne', r.status === 'merged'
        ? '「' + r.word.word + '」原本就在單字庫裡，只補上了空白的欄位（沒有蓋掉舊內容）。到「我的單字」可以直接編輯。'
        : '已加入「' + r.word.word + '」。', 'ok');
    });

    $('#btnEnrichOne').addEventListener('click', function () {
      var data = readOne();
      if (!data.word) {
        setStatus('#statusOne', '先填單字，才有東西可以補。', 'err');
        return;
      }
      var done = busy(this, 'Claude 查字中…');
      setStatus('#statusOne', '正在請 Claude 補齊資料…', 'busy');
      AI.enrich([{ word: data.word, meaning: data.meaning }]).then(function (res) {
        var got = (res.words || [])[0];
        if (!got) throw new Error('Claude 沒有回傳這個字的資料。');
        var filled = fromAI(got, 'manual');
        /* 只補空欄位，不蓋掉自己寫的內容 */
        Object.keys(ONE_FIELDS).forEach(function (k) {
          if (!data[k] && filled[k]) $(ONE_FIELDS[k]).value = filled[k];
        });
        setStatus('#statusOne', '補齊了。看一下沒問題就按「加入單字庫」。', 'ok');
      }).catch(function (err) {
        setStatus('#statusOne', err.message, 'err');
      }).then(done);
    });

    $('#btnClearOne').addEventListener('click', function () {
      writeOne(null);
      setStatus('#statusOne', '');
      $('#fWord').focus();
    });

    $('#fWord').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btnEnrichOne').click(); }
    });
  }

  /* ───────── 新增單字：批次 ───────── */

  function parseBulk(text) {
    return text.split('\n').map(function (line) {
      var t = line.trim();
      if (!t) return null;
      var m = t.match(/^(.+?)\s*[=＝:：]\s*(.+)$/);
      return m ? { word: m[1].trim(), meaning: m[2].trim() } : { word: t, meaning: '' };
    }).filter(Boolean);
  }

  function initAddBulk() {
    $('#btnSaveBulk').addEventListener('click', function () {
      var items = parseBulk($('#fBulk').value);
      if (!items.length) {
        setStatus('#statusBulk', '還沒貼上任何單字。', 'err');
        return;
      }
      if (items.length > 60) {
        setStatus('#statusBulk', '一次最多 60 個字，先分批處理吧。', 'err');
        return;
      }

      var btn = this;
      var useAI = $('#bulkEnrich').checked;

      function commit(list) {
        var r = Store.addMany(list, { merge: true });
        $('#fBulk').value = '';
        refreshStats();
        var msg = '加入 ' + plural(r.added) + '；補齊 ' + plural(r.merged);
        if (r.skipped) msg += '；跳過 ' + plural(r.skipped) + '（重複或空白）';
        setStatus('#statusBulk', msg + '。', 'ok');
      }

      if (!useAI) {
        commit(items.map(function (it) {
          return { word: it.word, meaning: it.meaning, source: 'manual' };
        }));
        return;
      }

      var done = busy(btn, '查 ' + items.length + ' 個字…');
      setStatus('#statusBulk', '正在請 Claude 補齊 ' + items.length + ' 個字，字多的時候要等一下…', 'busy');
      AI.enrich(items).then(function (res) {
        var got = res.words || [];
        var byKey = {};
        got.forEach(function (g) { byKey[String(g.word || '').trim().toLowerCase()] = g; });

        var merged = items.map(function (it, i) {
          var hit = byKey[it.word.toLowerCase()] || got[i];
          if (!hit) return { word: it.word, meaning: it.meaning, source: 'manual' };
          var rec = fromAI(hit, 'manual');
          if (it.meaning) rec.meaning = it.meaning;   /* 使用者自己寫的意思優先 */
          return rec;
        });
        commit(merged);
      }).catch(function (err) {
        setStatus('#statusBulk', err.message + '（單字沒有被加入，可以取消勾選 AI 補齊後再存）', 'err');
      }).then(done);
    });

    $('#btnClearBulk').addEventListener('click', function () {
      $('#fBulk').value = '';
      setStatus('#statusBulk', '');
    });
  }

  /* ───────── 照片辨識 ───────── */

  var photo = { img: null, url: '', boxes: [] };

  function clearPhoto() {
    if (photo.url) URL.revokeObjectURL(photo.url);
    photo = { img: null, url: '', boxes: [] };
    $('#photoImg').removeAttribute('src');
    $('#photoStage').hidden = true;
    $('#photoEmpty').hidden = false;
    $('#btnDropPhoto').disabled = true;
    $('#fPhoto').value = '';
    renderBoxes();
    setStatus('#statusPhoto', '');
  }

  function renderBoxes() {
    var layer = $('#boxLayer');
    $$('.sel-box', layer).forEach(function (el) {
      if (!el.classList.contains('is-drawing')) el.remove();
    });

    photo.boxes.forEach(function (b, i) {
      var el = document.createElement('div');
      el.className = 'sel-box';
      el.style.left = (b.x * 100) + '%';
      el.style.top = (b.y * 100) + '%';
      el.style.width = (b.w * 100) + '%';
      el.style.height = (b.h * 100) + '%';
      el.innerHTML = '<span class="tag">' + (i + 1) + '</span>' +
                     '<button class="kill" type="button" title="刪除這個框">✕</button>';
      el.querySelector('.kill').addEventListener('click', function (e) {
        e.stopPropagation();
        photo.boxes.splice(i, 1);
        renderBoxes();
      });
      layer.appendChild(el);
    });

    var n = photo.boxes.length;
    /* 辨識進行中時按鈕內容被 busy() 換掉了，別去動它 */
    var counter = $('#boxCount');
    if (counter) counter.textContent = n;
    var scanBtn = $('#btnScanBoxes');
    if (!scanBtn.classList.contains('is-busy')) scanBtn.disabled = n === 0;
    $('#btnClearBoxes').disabled = n === 0;
    $('#boxHint').textContent = n
      ? '已框選 ' + n + ' 個區域。可以繼續框，或按「只辨識框選區域」。點框右上角的 ✕ 可以刪掉它。'
      : '在圖片上按住並拖曳，就能框出一個區域；框好後按下方按鈕送給 AI。';
  }

  function initPhotoPicker() {
    $('#fPhoto').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      setStatus('#statusPhoto', '讀取圖片中…', 'busy');
      AI.loadImage(file).then(function (r) {
        if (photo.url) URL.revokeObjectURL(photo.url);
        photo = { img: r.img, url: r.url, boxes: [] };
        $('#photoImg').src = r.url;
        $('#photoEmpty').hidden = true;
        $('#photoStage').hidden = false;
        $('#btnDropPhoto').disabled = false;
        renderBoxes();
        setStatus('#statusPhoto', r.img.naturalWidth + '×' + r.img.naturalHeight +
          ' 已載入。可以掃描整張圖，或自己框出不會的字。', 'ok');
      }).catch(function (err) {
        setStatus('#statusPhoto', err.message, 'err');
        $('#fPhoto').value = '';
      });
    });

    $('#btnDropPhoto').addEventListener('click', clearPhoto);
    $('#btnClearBoxes').addEventListener('click', function () {
      photo.boxes = [];
      renderBoxes();
    });
  }

  /* 在圖片上拖曳框選。座標一律換算成 0~1 的比例，
     這樣不管圖片在畫面上被縮放成多大，對應回原圖都是準的。 */
  function initBoxDrawing() {
    var layer = $('#boxLayer');
    var drawing = null;

    function pos(e) {
      var r = layer.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      };
    }

    layer.addEventListener('pointerdown', function (e) {
      if (e.target !== layer) return;          /* 點在既有的框或 ✕ 上就不畫新框 */
      if (e.button !== undefined && e.button !== 0) return;
      if (photo.boxes.length >= 12) {
        setStatus('#statusPhoto', '一次最多框 12 個區域，先辨識完再繼續。', 'err');
        return;
      }

      var start = pos(e);
      var el = document.createElement('div');
      el.className = 'sel-box is-drawing';
      layer.appendChild(el);
      drawing = { start: start, el: el };

      layer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    layer.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e);
      var box = {
        x: Math.min(drawing.start.x, p.x),
        y: Math.min(drawing.start.y, p.y),
        w: Math.abs(p.x - drawing.start.x),
        h: Math.abs(p.y - drawing.start.y)
      };
      drawing.box = box;
      drawing.el.style.left = (box.x * 100) + '%';
      drawing.el.style.top = (box.y * 100) + '%';
      drawing.el.style.width = (box.w * 100) + '%';
      drawing.el.style.height = (box.h * 100) + '%';
    });

    function finish() {
      if (!drawing) return;
      var box = drawing.box;
      drawing.el.remove();
      drawing = null;

      var img = photo.img;
      /* 太小的框通常是誤觸；也不送小於 12px 的區域 */
      var okSize = box && img &&
        box.w * img.naturalWidth >= 12 && box.h * img.naturalHeight >= 12 &&
        box.w > 0.01 && box.h > 0.01;

      if (okSize) {
        photo.boxes.push(box);
        setStatus('#statusPhoto', '');
      } else if (box) {
        setStatus('#statusPhoto', '這個框太小了，再拖大一點。', 'err');
      }
      renderBoxes();
    }

    layer.addEventListener('pointerup', finish);
    layer.addEventListener('pointercancel', finish);
  }

  /* ───────── 辨識結果候選清單 ───────── */

  var candidates = [];

  function renderCandidates() {
    var wrap = $('#candList');
    wrap.innerHTML = '';

    candidates.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'cand' + (c.on ? '' : ' is-off');

      var chips = '';
      if (c.boxNo) chips += '<span class="chip">框 ' + c.boxNo + '</span>';
      if (c.pos) chips += '<span class="chip">' + esc(c.pos) + '</span>';
      if (c.phonetic) chips += esc(c.phonetic) + ' ';
      if (c.note) chips += esc(c.note);
      if (Store.findByWord(c.word)) chips += '<span class="chip">已在單字庫</span>';

      row.innerHTML =
        '<input type="checkbox" ' + (c.on ? 'checked' : '') + ' aria-label="要不要加入這個字">' +
        '<div class="cand-body">' +
          '<input class="ce ce-word" value="' + esc(c.word) + '" placeholder="單字">' +
          '<input class="ce ce-meaning" value="' + esc(c.meaning) + '" placeholder="意思">' +
          '<input class="ce ce-example" value="' + esc(c.example) + '" placeholder="例句">' +
          '<div class="cand-meta">' + chips + '</div>' +
        '</div>';

      row.querySelector('input[type=checkbox]').addEventListener('change', function (e) {
        candidates[i].on = e.target.checked;
        row.classList.toggle('is-off', !e.target.checked);
      });
      row.querySelector('.ce-word').addEventListener('input', function (e) { candidates[i].word = e.target.value; });
      row.querySelector('.ce-meaning').addEventListener('input', function (e) { candidates[i].meaning = e.target.value; });
      row.querySelector('.ce-example').addEventListener('input', function (e) { candidates[i].example = e.target.value; });

      wrap.appendChild(row);
    });

    $('#candCard').hidden = candidates.length === 0;
    setStatus('#statusCand', candidates.length ? '辨識出 ' + plural(candidates.length) + '。' : '');
  }

  function showResults(list, source) {
    candidates = list.map(function (raw) {
      var rec = fromAI(raw, source);
      rec.on = true;
      rec.boxNo = typeof raw.image_index === 'number' ? raw.image_index + 1 : 0;
      return rec;
    }).filter(function (c) { return c.word; });

    renderCandidates();
    if (candidates.length) {
      $('#candCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function initPhotoScan() {
    $('#btnScanAll').addEventListener('click', function () {
      if (!photo.img) return;
      var done = busy(this, 'Claude 讀圖中…');
      setStatus('#statusPhoto', '正在讓 Claude 掃描整張圖，通常要 10～30 秒…', 'busy');
      AI.scanPhoto(photo.img).then(function (res) {
        var list = res.words || [];
        showResults(list, 'photo');
        setStatus('#statusPhoto', list.length
          ? '找到 ' + plural(list.length) + '，請在下面挑選。'
          : 'Claude 在這張圖裡沒找到可學的單字，換一張或框小一點試試。', list.length ? 'ok' : 'err');
      }).catch(function (err) {
        setStatus('#statusPhoto', err.message, 'err');
      }).then(done);
    });

    $('#btnScanBoxes').addEventListener('click', function () {
      if (!photo.img || !photo.boxes.length) return;
      var n = photo.boxes.length;
      var done = busy(this, '辨識 ' + n + ' 個框…');
      setStatus('#statusPhoto', '正在辨識 ' + n + ' 個框選區域…', 'busy');
      AI.scanBoxes(photo.img, photo.boxes).then(function (res) {
        var list = res.words || [];
        showResults(list, 'crop');
        setStatus('#statusPhoto', list.length
          ? '框選區域裡找到 ' + plural(list.length) + '。'
          : '框裡看不出單字，試著框大一點、或把字拍清楚一些。', list.length ? 'ok' : 'err');
      }).catch(function (err) {
        setStatus('#statusPhoto', err.message, 'err');
      }).then(done);
    });

    $('#btnCandAll').addEventListener('click', function () {
      candidates.forEach(function (c) { c.on = true; });
      renderCandidates();
    });
    $('#btnCandNone').addEventListener('click', function () {
      candidates.forEach(function (c) { c.on = false; });
      renderCandidates();
    });
    $('#btnCandDrop').addEventListener('click', function () {
      candidates = [];
      renderCandidates();
    });

    $('#btnCandSave').addEventListener('click', function () {
      var picked = candidates.filter(function (c) { return c.on && c.word.trim(); });
      if (!picked.length) {
        setStatus('#statusCand', '沒有勾選任何單字。', 'err');
        return;
      }
      var r = Store.addMany(picked, { merge: true });
      candidates = [];
      renderCandidates();
      refreshStats();
      var msg = '加入 ' + plural(r.added) + '；補齊 ' + plural(r.merged);
      if (r.skipped) msg += '；跳過 ' + plural(r.skipped);
      toast(msg, 'ok');
      setStatus('#statusPhoto', msg + '。可以繼續框其他地方。', 'ok');
    });
  }

  /* ───────── 我的單字 ───────── */

  function filterSort(list, q, filter, sort) {
    var now = Date.now();
    var needle = q.trim().toLowerCase();

    var out = list.filter(function (w) {
      if (needle) {
        var hay = (w.word + ' ' + w.meaning + ' ' + w.example + ' ' +
                   w.exampleZh + ' ' + w.note).toLowerCase();
        if (hay.indexOf(needle) === -1) return false;
      }
      if (filter === 'due') return Store.isDue(w, now);
      if (filter === 'new') return !w.seen;
      if (filter === 'learning') return w.seen > 0 && !Store.isMastered(w);
      if (filter === 'mastered') return Store.isMastered(w);
      return true;
    });

    out.sort(function (a, b) {
      if (sort === 'old') return a.createdAt - b.createdAt;
      if (sort === 'az') return a.word.toLowerCase().localeCompare(b.word.toLowerCase());
      if (sort === 'due') return a.due - b.due;
      if (sort === 'weak') return (a.box - b.box) || (b.wrong - a.wrong);
      return b.createdAt - a.createdAt;
    });
    return out;
  }

  function renderList() {
    var list = filterSort(Store.all(), $('#qSearch').value, $('#qFilter').value, $('#qSort').value);
    var wrap = $('#wordList');
    var total = Store.all().length;

    $('#listCount').textContent = total
      ? '顯示 ' + list.length + ' / ' + total + ' 個單字'
      : '';

    if (!total) {
      wrap.innerHTML = '<div class="empty"><p>單字庫還是空的。</p>' +
        '<p class="hint">先到「新增單字」打幾個字，或用「照片辨識」拍一張講義。</p></div>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<div class="empty"><p>沒有符合條件的單字。</p></div>';
      return;
    }

    wrap.innerHTML = list.map(function (w) {
      var dots = '';
      for (var i = 1; i <= Store.MAX_BOX; i++) dots += '<i class="' + (i <= w.box ? 'on' : '') + '"></i>';
      var d = dueLabel(w);

      return '<div class="word" data-id="' + w.id + '">' +
        '<div class="word-main">' +
          '<div class="word-head">' +
            '<b>' + esc(w.word) + '</b>' +
            (w.phonetic ? '<span class="phon">' + esc(w.phonetic) + '</span>' : '') +
            (w.pos ? '<span class="pos">' + esc(w.pos) + '</span>' : '') +
          '</div>' +
          (w.meaning ? '<div class="word-mean">' + esc(w.meaning) + '</div>'
                     : '<div class="word-mean" style="color:var(--bad)">（還沒有意思）</div>') +
          (w.example ? '<div class="word-ex">' + esc(w.example) +
              (w.exampleZh ? '<br>' + esc(w.exampleZh) : '') + '</div>' : '') +
          (w.note ? '<div class="word-note">📎 ' + esc(w.note) + '</div>' : '') +
        '</div>' +
        '<div class="word-side">' +
          '<div class="level" title="熟練度 ' + w.box + ' / ' + Store.MAX_BOX + '">' + dots + '</div>' +
          '<span class="due' + (d.due ? ' is-due' : '') + '">' + d.text + '</span>' +
          '<div class="word-actions">' +
            '<button class="icon-btn" data-act="edit" title="編輯">✎</button>' +
            '<button class="icon-btn danger" data-act="del" title="刪除">🗑</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function initList() {
    ['#qSearch', '#qFilter', '#qSort'].forEach(function (sel) {
      $(sel).addEventListener('input', renderList);
      $(sel).addEventListener('change', renderList);
    });

    $('#wordList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.closest('.word').dataset.id;
      var w = Store.get(id);
      if (!w) return;

      if (btn.dataset.act === 'del') {
        if (!global.confirm('確定要刪除「' + w.word + '」？')) return;
        Store.remove(id);
        renderList();
        refreshStats();
        toast('已刪除「' + w.word + '」');
      } else {
        openEdit(w);
      }
    });

    $('#btnExport').addEventListener('click', function () {
      if (!Store.all().length) {
        setStatus('#statusList', '單字庫是空的，沒東西可以匯出。', 'err');
        return;
      }
      var blob = new Blob([Store.exportData()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vocab-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      setStatus('#statusList', '已匯出 ' + plural(Store.all().length) + '。', 'ok');
    });

    $('#fImport').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var r = Store.importData(String(reader.result));
          renderList();
          refreshStats();
          setStatus('#statusList', '匯入完成：新增 ' + plural(r.added) +
            '、合併 ' + plural(r.merged) + '、跳過 ' + plural(r.skipped) + '。', 'ok');
        } catch (err) {
          setStatus('#statusList', '匯入失敗：' + err.message, 'err');
        }
        $('#fImport').value = '';
      };
      reader.onerror = function () {
        setStatus('#statusList', '讀不到這個檔案。', 'err');
        $('#fImport').value = '';
      };
      reader.readAsText(file);
    });

    $('#btnWipe').addEventListener('click', function () {
      var n = Store.all().length;
      if (!n) return;
      if (!global.confirm('這會刪掉全部 ' + n + ' 個單字和複習進度，而且無法復原。\n' +
                          '建議先按「匯出 JSON」備份。\n\n確定要清空嗎？')) return;
      Store.clear();
      renderList();
      refreshStats();
      setStatus('#statusList', '單字庫已清空。', 'ok');
    });
  }

  /* ───────── 編輯彈窗 ───────── */

  var EDIT_FIELDS = {
    word: '#eWord', phonetic: '#ePhonetic', pos: '#ePos',
    meaning: '#eMeaning', example: '#eExample', exampleZh: '#eExampleZh', note: '#eNote'
  };
  var editingId = null;

  function openEdit(w) {
    editingId = w.id;
    Object.keys(EDIT_FIELDS).forEach(function (k) { $(EDIT_FIELDS[k]).value = w[k] || ''; });
    setStatus('#statusEdit', '');
    $('#editModal').hidden = false;
    $('#eWord').focus();
  }

  function closeEdit() {
    editingId = null;
    $('#editModal').hidden = true;
  }

  function initEdit() {
    $('#btnEditCancel').addEventListener('click', closeEdit);
    $('#editModal').addEventListener('click', function (e) {
      if (e.target === $('#editModal')) closeEdit();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#editModal').hidden) closeEdit();
    });

    $('#btnEditSave').addEventListener('click', function () {
      if (!editingId) return;
      var patch = {};
      Object.keys(EDIT_FIELDS).forEach(function (k) { patch[k] = $(EDIT_FIELDS[k]).value.trim(); });
      if (!patch.word) {
        setStatus('#statusEdit', '單字不能空白。', 'err');
        return;
      }
      var clash = Store.findByWord(patch.word);
      if (clash && clash.id !== editingId) {
        setStatus('#statusEdit', '單字庫裡已經有「' + patch.word + '」了。', 'err');
        return;
      }
      Store.update(editingId, patch);
      closeEdit();
      renderList();
      refreshStats();
      toast('已更新', 'ok');
    });

    $('#btnEditEnrich').addEventListener('click', function () {
      var word = $('#eWord').value.trim();
      if (!word) {
        setStatus('#statusEdit', '先填單字。', 'err');
        return;
      }
      var done = busy(this, '查字中…');
      setStatus('#statusEdit', '正在請 Claude 補齊…', 'busy');
      AI.enrich([{ word: word, meaning: $('#eMeaning').value.trim() }]).then(function (res) {
        var got = (res.words || [])[0];
        if (!got) throw new Error('Claude 沒有回傳這個字的資料。');
        var filled = fromAI(got, 'manual');
        Object.keys(EDIT_FIELDS).forEach(function (k) {
          if (!$(EDIT_FIELDS[k]).value.trim() && filled[k]) $(EDIT_FIELDS[k]).value = filled[k];
        });
        setStatus('#statusEdit', '補齊了，記得按儲存。', 'ok');
      }).catch(function (err) {
        setStatus('#statusEdit', err.message, 'err');
      }).then(done);
    });
  }

  /* ───────── 複習 ───────── */

  var quiz = null;

  function resetReviewSetup() {
    if (quiz) return;                     /* 複習進行中就不要打斷 */
    var s = Store.stats();
    $('#reviewSetup').hidden = false;
    $('#reviewStage').hidden = true;
    $('#reviewDone').hidden = true;
    setStatus('#statusReview', s.total
      ? '單字庫共 ' + s.total + ' 個字，其中 ' + s.due + ' 個今天該複習。'
      : '單字庫是空的，先去新增幾個字吧。');
  }

  function pickMode(mode, w) {
    var m = mode;
    if (m === 'mixed') {
      var pool = ['en2zh', 'zh2en', 'spell'];
      m = pool[Math.floor(Math.random() * pool.length)];
    }
    /* 沒有中文意思的字沒辦法從中文出題，退回看英文猜意思 */
    if ((m === 'zh2en' || m === 'spell') && !w.meaning) m = 'en2zh';
    return m;
  }

  function renderQuestion() {
    var w = quiz.queue[quiz.idx];
    quiz.mode = pickMode(quiz.baseMode, w);
    quiz.revealed = false;

    $('#rBar').style.width = (quiz.idx / quiz.queue.length * 100) + '%';
    $('#rCount').textContent = (quiz.idx + 1) + ' / ' + quiz.queue.length;

    var isSpell = quiz.mode === 'spell';
    $('#rSpellWrap').hidden = !isSpell;
    $('#rBack').hidden = true;
    $('#rBack').innerHTML = '';
    $('#rRevealRow').hidden = false;
    $('#rGradeRow').hidden = true;
    $('#btnReveal').textContent = isSpell ? '檢查' : '顯示答案';

    if (quiz.mode === 'en2zh') {
      $('#rPrompt').textContent = '這個字是什麼意思？';
      $('#rFront').textContent = w.word;
    } else if (quiz.mode === 'zh2en') {
      $('#rPrompt').textContent = '這個意思的' + (Store.getConfig().learnLang || '英文') + '是什麼？';
      $('#rFront').textContent = w.meaning;
    } else {
      $('#rPrompt').textContent = '請拼出這個意思的單字';
      $('#rFront').textContent = w.meaning;
      $('#rSpellInput').value = '';
      $('#rSpellInput').focus();
    }
  }

  function normalizeSpelling(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:'"]/g, '');
  }

  function reveal() {
    if (!quiz || quiz.revealed) return;
    var w = quiz.queue[quiz.idx];
    quiz.revealed = true;

    var html = '';
    if (quiz.mode === 'spell') {
      var typed = $('#rSpellInput').value;
      var hit = normalizeSpelling(typed) === normalizeSpelling(w.word);
      html += '<p class="verdict ' + (hit ? 'ok' : 'no') + '">' +
              (hit ? '✓ 拼對了' : '✗ 你打的是「' + esc(typed || '（空白）') + '」') + '</p>';
    }

    html += '<p class="ans">' + esc(w.word) +
            (w.phonetic ? ' <span style="font-size:.7em;color:var(--fg-dim)">' + esc(w.phonetic) + '</span>' : '') +
            '</p>';
    if (w.pos) html += '<p class="row dim">' + esc(w.pos) + '</p>';
    if (w.meaning) html += '<p class="row">' + esc(w.meaning) + '</p>';
    if (w.example) html += '<p class="row dim">' + esc(w.example) + '</p>';
    if (w.exampleZh) html += '<p class="row dim">' + esc(w.exampleZh) + '</p>';
    if (w.note) html += '<p class="row dim">📎 ' + esc(w.note) + '</p>';

    $('#rBack').innerHTML = html;
    $('#rBack').hidden = false;
    $('#rRevealRow').hidden = true;
    $('#rGradeRow').hidden = false;
  }

  function grade(correct) {
    if (!quiz || !quiz.revealed) return;
    var w = quiz.queue[quiz.idx];
    Store.grade(w.id, correct);

    if (correct) quiz.right++;
    else { quiz.wrong++; quiz.missed.push(w); }

    quiz.idx++;
    refreshStats();
    if (quiz.idx >= quiz.queue.length) finishQuiz();
    else renderQuestion();
  }

  function finishQuiz() {
    /* 提早結束時只結算已經答過的題目，不要拿整個題庫當分母 */
    var answered = Math.max(1, quiz.idx);
    var right = quiz.right;
    var missed = quiz.missed;

    $('#reviewStage').hidden = true;
    $('#reviewDone').hidden = false;
    $('#rScore').innerHTML = '答對 <b>' + right + '</b> / ' + answered +
      '（' + Math.round(right / answered * 100) + '%）' +
      (quiz.idx < quiz.queue.length ? '　·　這輪提早結束了' : '');

    $('#rMissed').innerHTML = missed.length
      ? '<p class="hint">這些字待加強，它們很快會再出現：</p><div class="word-list">' +
        missed.map(function (w) {
          return '<div class="word"><div class="word-main">' +
            '<div class="word-head"><b>' + esc(w.word) + '</b></div>' +
            '<div class="word-mean">' + esc(w.meaning || '（沒有意思）') + '</div>' +
          '</div></div>';
        }).join('') + '</div>'
      : '<p class="hint">全部答對，漂亮。</p>';

    quiz = null;
  }

  function initReview() {
    $('#btnStartReview').addEventListener('click', function () {
      var size = parseInt($('#rSize').value, 10) || 20;
      var scope = $('#rScope').value;
      var queue = Store.buildQueue(scope, size);

      if (!queue.length) {
        var s = Store.stats();
        setStatus('#statusReview', s.total
          ? '目前沒有到期的單字。把「範圍」改成「全部單字」或「最不熟的」就可以先練。'
          : '單字庫是空的，先去新增幾個字吧。', 'err');
        return;
      }

      quiz = {
        queue: queue,
        idx: 0,
        baseMode: $('#rMode').value,
        mode: null,
        revealed: false,
        right: 0,
        wrong: 0,
        missed: []
      };
      $('#reviewSetup').hidden = true;
      $('#reviewDone').hidden = true;
      $('#reviewStage').hidden = false;
      renderQuestion();
    });

    $('#btnReveal').addEventListener('click', reveal);
    $('#btnRight').addEventListener('click', function () { grade(true); });
    $('#btnWrong').addEventListener('click', function () { grade(false); });

    $('#btnQuitReview').addEventListener('click', function () {
      if (quiz && quiz.idx < quiz.queue.length &&
          !global.confirm('要結束這一輪嗎？已經答過的題目都已經存下來了。')) return;
      if (quiz && quiz.idx > 0) { finishQuiz(); return; }
      quiz = null;
      resetReviewSetup();
    });

    $('#btnAgain').addEventListener('click', function () {
      $('#reviewDone').hidden = true;
      resetReviewSetup();
    });

    $('#rSpellInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); reveal(); }
    });

    document.addEventListener('keydown', function (e) {
      if (!quiz || $('#reviewStage').hidden) return;
      if (!$('#editModal').hidden) return;
      var typing = document.activeElement === $('#rSpellInput');
      if (e.key === 'Enter' && !quiz.revealed && !typing) { e.preventDefault(); reveal(); }
    });
  }

  /* ───────── 設定 ───────── */

  function initSettings() {
    var sel = $('#fModel');
    sel.innerHTML = Store.MODELS.map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.label) + '</option>';
    }).join('');

    var cfg = Store.getConfig();
    $('#fKey').value = cfg.apiKey;
    $('#fModel').value = cfg.model;
    $('#fLearn').value = cfg.learnLang;
    $('#fNative').value = cfg.nativeLang;

    $('#btnPeekKey').addEventListener('click', function () {
      var input = $('#fKey');
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      this.textContent = hidden ? '隱藏' : '顯示';
    });

    $('#btnSaveCfg').addEventListener('click', function () {
      Store.setConfig({
        apiKey: $('#fKey').value.trim(),
        model: $('#fModel').value,
        learnLang: $('#fLearn').value.trim() || '英文',
        nativeLang: $('#fNative').value.trim() || '繁體中文'
      });
      $('#statBytes').textContent = fmtBytes(Store.bytes());
      setStatus('#statusCfg', '設定已儲存在這台裝置。', 'ok');
    });

    $('#btnTestCfg').addEventListener('click', function () {
      var typed = $('#fKey').value.trim();
      if (!typed) {
        setStatus('#statusCfg', '先貼上 API key。', 'err');
        return;
      }
      /* 測試用的是目前輸入框的值，所以先存起來 */
      Store.setConfig({ apiKey: typed, model: $('#fModel').value });
      var done = busy(this, '測試中…');
      setStatus('#statusCfg', '正在呼叫 Claude API…', 'busy');
      AI.ping().then(function () {
        setStatus('#statusCfg', '連線成功，可以開始用照片辨識了。', 'ok');
      }).catch(function (err) {
        setStatus('#statusCfg', err.message, 'err');
      }).then(done);
    });

    $('#btnForgetKey').addEventListener('click', function () {
      if (!global.confirm('要從這台裝置移除 API key 嗎？單字資料不會被刪掉。')) return;
      Store.setConfig({ apiKey: '' });
      $('#fKey').value = '';
      setStatus('#statusCfg', 'API key 已移除。', 'ok');
    });
  }

  /* ───────── 啟動 ───────── */

  function init() {
    Store.load();

    $('#tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (btn) showTab(btn.dataset.tab);
    });

    initAddOne();
    initAddBulk();
    initPhotoPicker();
    initBoxDrawing();
    initPhotoScan();
    initList();
    initEdit();
    initReview();
    initSettings();

    refreshStats();
    renderBoxes();
    renderList();

    if (!Store.getConfig().apiKey) {
      setStatus('#statusCfg', '還沒設定 API key。照片辨識和 AI 補齊需要它，手動新增和複習不用。');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
