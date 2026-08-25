/* ai.js ─ 直接從瀏覽器呼叫 Claude Messages API
 *
 * 因為這是純靜態網站（GitHub Pages），沒有後端可以藏 key，
 * 所以用使用者自己的 API key + `anthropic-dangerous-direct-browser-access` 這個
 * header 直連 API。這個 header 就是官方 SDK 在 dangerouslyAllowBrowser 模式下送的東西。
 */
(function (global) {
  'use strict';

  var ENDPOINT = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2023-06-01';

  /* 送去 API 的圖片邊長上限。視覺 token 數 ≈ ⌈寬/28⌉ × ⌈高/28⌉，
     所以邊長直接決定成本，這裡壓在合理範圍。 */
  var MAX_EDGE = 1600;
  /* 框選區域通常很小，太小的圖 Claude 會看不清楚，放大到至少這個邊長。 */
  var MIN_CROP_EDGE = 900;

  /* ───────── 單字卡的結構化輸出 schema ───────── */

  function wordSchema(withIndex) {
    var props = {
      word: { type: 'string', description: '單字或片語本身，用原形' },
      phonetic: { type: 'string', description: 'IPA 音標，前後加斜線；不確定就給空字串' },
      pos: { type: 'string', description: '詞性縮寫，例如 n. / v. / adj. / adv. / phr.' },
      meaning: { type: 'string', description: '母語釋義' },
      example: { type: 'string', description: '例句' },
      example_zh: { type: 'string', description: '例句的母語翻譯' },
      note: { type: 'string', description: '補充說明；沒有就給空字串' }
    };
    var required = ['word', 'phonetic', 'pos', 'meaning', 'example', 'example_zh', 'note'];

    if (withIndex) {
      props.image_index = { type: 'integer', description: '這個字來自第幾張圖片（從 0 開始）' };
      required.push('image_index');
    }

    return {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          description: '整理好的單字卡；沒有找到任何單字時回傳空陣列',
          items: { type: 'object', properties: props, required: required, additionalProperties: false }
        }
      },
      required: ['words'],
      additionalProperties: false
    };
  }

  /* ───────── 提示語 ───────── */

  function baseSystem(cfg) {
    var learn = cfg.learnLang || '英文';
    var native = cfg.nativeLang || '繁體中文';
    return [
      '你是一位' + learn + '教學助理，服務對象的母語是' + native + '。',
      '你的工作是把使用者給的內容整理成乾淨的單字卡。規則：',
      '1. word 一律用原形：動詞用原形、名詞用單數。如果原文是變化形（複數、過去式…），把原文寫進 note。',
      '2. meaning 用' + native + '，簡潔為主，多個義項用「；」分隔。優先取在該語境下的意思。',
      '3. example 用' + learn + '寫一個 8～15 字的短句；如果來源本身就有完整句子，直接引用那一句。',
      '4. example_zh 是 example 的' + native + '翻譯。',
      '5. phonetic 用 IPA 並前後加斜線，例如 /ˈæp.əl/。不確定就給空字串，不要亂猜。',
      '6. 跳過太簡單的功能詞（the、is、and…）、人名、地名、純數字。',
      '7. 不確定的內容留空字串，不要編造。'
    ].join('\n');
  }

  function photoSystem(cfg) {
    return baseSystem(cfg) + '\n' + [
      '',
      '這次的來源是照片。額外規則：',
      '8. 只整理圖片上真正看得到的文字，看不清楚的字寧可略過也不要猜。',
      '9. 圖片上完全沒有可學的單字時，words 回傳空陣列。'
    ].join('\n');
  }

  function cropSystem(cfg) {
    return photoSystem(cfg) + '\n' + [
      '',
      '每一張圖片都是使用者從大圖上「框選」出來的區域，代表他特別想學框裡面的字。',
      '請專注在框內的文字，並用 image_index 標明每個字來自第幾張圖片（從 0 開始，對應圖片前的標籤）。'
    ].join('\n');
  }

  /* ───────── HTTP ───────── */

  function readableError(status, payload) {
    var apiMsg = payload && payload.error && payload.error.message ? payload.error.message : '';
    if (status === 401) return 'API key 不正確或已失效，請到設定頁重新貼一次。';
    if (status === 403) return '這組 key 沒有權限使用這個模型。' + (apiMsg ? '（' + apiMsg + '）' : '');
    if (status === 400) return '請求被拒絕：' + (apiMsg || '格式有誤');
    if (status === 404) return '找不到這個模型，請在設定頁換一個。' + (apiMsg ? '（' + apiMsg + '）' : '');
    if (status === 413) return '圖片或內容太大，請裁小一點再試。';
    if (status === 429) return '呼叫太頻繁或額度用完了，等一下再試。';
    if (status >= 500) return 'Claude API 暫時出問題（' + status + '），稍後再試。';
    return 'API 回傳錯誤 ' + status + (apiMsg ? '：' + apiMsg : '');
  }

  /* 送一次請求，並把結構化輸出的 JSON parse 回物件 */
  function ask(opts) {
    var cfg = global.Store.getConfig();
    if (!cfg.apiKey) {
      return Promise.reject(new Error('還沒設定 API key，請先到「設定」頁貼上。'));
    }

    var model = global.Store.modelInfo(cfg.model);
    var outputConfig = { format: { type: 'json_schema', schema: opts.schema } };
    /* effort 只有部分模型支援，送給不支援的模型會 400 */
    if (model.effort) outputConfig.effort = opts.effort || 'medium';

    var body = {
      model: model.id,
      max_tokens: opts.maxTokens || 8000,
      system: opts.system,
      messages: [{ role: 'user', content: opts.content }],
      output_config: outputConfig
    };

    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (raw) {
        var payload = null;
        try { payload = raw ? JSON.parse(raw) : null; } catch (e) { /* 不是 JSON 就算了 */ }
        if (!res.ok) throw new Error(readableError(res.status, payload));
        if (!payload) throw new Error('API 回傳了無法解析的內容。');
        return payload;
      });
    }).then(function (payload) {
      if (payload.stop_reason === 'refusal') {
        throw new Error('Claude 拒絕處理這個內容，換一張圖或換個說法再試。');
      }
      var text = (payload.content || [])
        .filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; })
        .join('');
      if (!text) throw new Error('Claude 沒有回傳內容，可能是 max_tokens 太小。');
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('回傳的內容不是預期的 JSON 格式。');
      }
    }).catch(function (err) {
      /* fetch 本身失敗會丟 TypeError：通常是沒網路，或瀏覽器擴充功能把請求擋掉了。
         用 err.name 而不是 instanceof，這樣跨 realm（iframe、測試環境）也判斷得出來。 */
      if (err && err.name === 'TypeError') {
        throw new Error('連不上 Claude API，請檢查網路或擋廣告的擴充功能。');
      }
      throw err;
    });
  }

  /* ───────── 圖片處理 ───────── */

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('沒有選到檔案。'));
      if (!/^image\//.test(file.type)) return reject(new Error('這不是圖片檔。'));
      /* 圖片送出前一定會重新壓成 JPEG 並縮到 MAX_EDGE，所以這裡只擋住連瀏覽器都難解碼的超大檔 */
      if (file.size > 20 * 1024 * 1024) return reject(new Error('圖片超過 20 MB，請先壓縮或改拍小一點。'));

      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('這張圖片讀不出來，換一張試試。'));
      };
      img.src = url;
    });
  }

  /* 把 <img>（或其中一塊區域）畫進 canvas，輸出 base64 的 image block */
  function toImageBlock(img, region, opts) {
    var o = opts || {};
    var sx = region ? Math.round(region.x * img.naturalWidth) : 0;
    var sy = region ? Math.round(region.y * img.naturalHeight) : 0;
    var sw = region ? Math.round(region.w * img.naturalWidth) : img.naturalWidth;
    var sh = region ? Math.round(region.h * img.naturalHeight) : img.naturalHeight;

    sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
    sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));

    var scale = 1;
    var long = Math.max(sw, sh);
    if (o.minEdge && long < o.minEdge) scale = o.minEdge / long;       /* 小框放大，讓文字佔更多像素 */
    if (long * scale > MAX_EDGE) scale = MAX_EDGE / long;              /* 大圖縮小，控制成本 */

    var cw = Math.max(1, Math.round(sw * scale));
    var ch = Math.max(1, Math.round(sh * scale));

    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';                     /* 透明 PNG 轉 JPEG 時避免變黑底 */
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

    var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: dataUrl.slice(dataUrl.indexOf(',') + 1)
      }
    };
  }

  /* ───────── 對外的三個任務 ───────── */

  /* 掃描整張照片 */
  function scanPhoto(img) {
    var cfg = global.Store.getConfig();
    return ask({
      system: photoSystem(cfg),
      effort: 'medium',
      maxTokens: 12000,
      schema: wordSchema(false),
      content: [
        toImageBlock(img, null, {}),
        {
          type: 'text',
          text: '請找出這張圖片裡值得學習的' + (cfg.learnLang || '英文') +
                '單字與片語，整理成單字卡。由重要、實用的字優先，最多 25 個。'
        }
      ]
    });
  }

  /* 只辨識使用者框選的區域；boxes 是 [{x,y,w,h}]（0~1 的比例座標） */
  function scanBoxes(img, boxes) {
    var cfg = global.Store.getConfig();
    var content = [];

    boxes.forEach(function (box, i) {
      content.push({ type: 'text', text: '圖片 ' + i + '：' });
      content.push(toImageBlock(img, box, { minEdge: MIN_CROP_EDGE }));
    });

    content.push({
      type: 'text',
      text: '上面每一張圖都是我從同一張照片上框出來、看不懂的地方。' +
            '請辨識每個框裡的' + (cfg.learnLang || '英文') + '單字或片語並整理成單字卡，' +
            '用 image_index 標明來自第幾張圖。一個框裡如果有多個生字就都列出來。'
    });

    return ask({
      system: cropSystem(cfg),
      effort: 'medium',
      maxTokens: 12000,
      schema: wordSchema(true),
      content: content
    });
  }

  /* 使用者自己打的單字，請 AI 補齊欄位。words 是字串陣列或 {word, meaning} 陣列 */
  function enrich(list) {
    var cfg = global.Store.getConfig();
    var lines = list.map(function (item, i) {
      if (typeof item === 'string') return (i + 1) + '. ' + item;
      var line = (i + 1) + '. ' + item.word;
      if (item.meaning) line += '（我認為的意思：' + item.meaning + '）';
      return line;
    }).join('\n');

    return ask({
      system: baseSystem(cfg) + '\n\n' + [
        '',
        '這次使用者已經給了單字清單，請為每個字補齊資訊。額外規則：',
        '8. word 保持使用者輸入的拼法。如果明顯拼錯，改成正確拼法並在 note 說明原本打的是什麼。',
        '9. 使用者已經寫了自己認為的意思時，把它當作他想要的義項；如果他理解錯了，在 note 溫和地指出來。',
        '10. 輸出的順序與數量要和輸入的清單一致，不要漏掉也不要多加。'
      ].join('\n'),
      effort: 'medium',
      maxTokens: 12000,
      schema: wordSchema(false),
      content: [{ type: 'text', text: '請幫我補齊這些單字：\n' + lines }]
    });
  }

  /* 設定頁的「測試連線」：最小的一次請求 */
  function ping() {
    return ask({
      system: '你在做連線測試，直接照 schema 回答。',
      effort: 'low',
      maxTokens: 1000,
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false
      },
      content: [{ type: 'text', text: '回傳 ok = true。' }]
    });
  }

  global.AI = {
    loadImage: loadImage,
    scanPhoto: scanPhoto,
    scanBoxes: scanBoxes,
    enrich: enrich,
    ping: ping
  };
})(window);
