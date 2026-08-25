# CLAUDE.md

給 AI 助理讀的專案說明。人類看的說明在 `README.md`。

## 這是什麼

「單字練習室」—— 一個讓使用者建立自己的單字庫並用間隔複習法背起來的網站。
特色是可以拍照，或在照片上**拖曳框選**看不懂的地方，交給 Claude 辨識成單字卡。

線上網址：https://00charlene.github.io/hello-pages/

## 硬性限制（改動前先讀）

1. **純靜態，沒有建置步驟。** GitHub Pages 直接把 `main` 分支根目錄當網站服務。
   不要引入需要編譯、打包或 transpile 的東西（TypeScript、JSX、SCSS、bundler 都不行）。
2. **`js/*.js` 是傳統 script，不是 ES module。** `index.html` 用 `<script defer>` 依序載入，
   各檔案掛在 `window` 上（`window.Store`、`window.AI`）。這樣直接用 `file://` 開也能跑。
   不要改成 `import`/`export`。
3. **網站本身零相依。** 根目錄的 `package.json` 只是為了跑 `test/e2e.js`，
   `node_modules/` 已被 gitignore。不要讓 `index.html` 依賴任何 npm 套件或 CDN。
4. **沒有後端。** 使用者自備 API key、存在 localStorage，由瀏覽器直連 Claude API。

## 檔案地圖

| 檔案 | 職責 |
| --- | --- |
| `index.html` | 全部版面。五個 `.panel` 分頁 + 一個編輯彈窗 + toast |
| `css/style.css` | 樣式。設計 token 在 `:root` |
| `js/store.js` | 資料層：localStorage 讀寫、去重、Leitner 排程、出題佇列、匯出匯入 |
| `js/ai.js` | Claude API 呼叫、圖片縮放／裁切、JSON schema 與提示語 |
| `js/app.js` | 介面邏輯：分頁、表單、照片框選、列表、複習、設定 |
| `test/e2e.js` | Playwright 流程測試（見下） |

`app.js` 內部按功能分區，每區有 `/* ───── 區塊名 ───── */` 註解，照著放新程式碼。

## 容易踩的坑

**CSS 的 `display` 會蓋過 `hidden` 屬性。**
專案用 `hidden` 屬性控制顯示／隱藏。瀏覽器內建的 `[hidden]{display:none}` 是 UA 層規則，
任何作者層的 `display` 都會贏過它 —— `.modal{display:grid}` 就曾讓編輯彈窗蓋住整個畫面。
`style.css` 開頭有一條 `[hidden]{display:none !important}` 擋住這個問題，**不要刪掉**。
新增有 `display` 的 class 給會被 `hidden` 切換的元素時，記得這條規則的存在。
`test/e2e.js` 有對應的迴歸檢查（「掛了 hidden 的元素真的都隱藏」）。

**`effort` 參數不是每個模型都支援。**
`store.js` 的 `MODELS` 每筆有 `effort` 布林值；Haiku 4.5 送 `output_config.effort` 會 400。
`ai.js` 的 `ask()` 靠這個旗標決定要不要送。新增模型時要一起設對。

**框選座標一律存 0~1 的比例，不存像素。**
圖片在畫面上會被 CSS 縮放，存像素就對不回原圖。`app.js` 的 `initBoxDrawing()` 換算比例，
`ai.js` 的 `toImageBlock()` 再乘回 `naturalWidth/Height` 裁切。

**圖片一定要重新編碼再送。**
`toImageBlock()` 把任何格式（含 iOS 的 HEIC）用 canvas 轉成 JPEG，長邊壓到 1600px 以內控制成本；
框選出來的小區域反過來放大到至少 900px，否則字太小 Claude 讀不出來。透明 PNG 要先填白底。

**重複的字是「合併」不是「拒絕」。**
`Store.add(rec, {merge:true})` 遇到已存在的字只補空欄位、不覆蓋既有內容，回傳 `status:'merged'`。
寫測試或訊息時不要假設它會被拒絕。

**錯誤型別判斷用 `err.name` 不用 `instanceof`。**
`instanceof TypeError` 跨 realm（iframe、測試環境）會失效。

## Claude API 用法

`ai.js` 用原生 `fetch` 打 `POST https://api.anthropic.com/v1/messages`。
不用官方 SDK，因為沒有 bundler（見上面的硬性限制）。

必要 headers：

```
content-type: application/json
x-api-key: <使用者的 key>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true   ← 瀏覽器直連必須
```

- 預設模型 `claude-opus-5`。
- 用 structured outputs（`output_config.format` = `{type:'json_schema', schema}`）拿乾淨的 JSON，
  不需要 beta header。schema 的每個 object 都要 `additionalProperties:false` 和完整的 `required`。
- 回應要先濾出 `type === 'text'` 的 block（可能有 thinking block 在前），再 `JSON.parse`。
- 讀 `content` 前先檢查 `stop_reason === 'refusal'`。

## 測試

```bash
npm run setup      # 只需第一次：安裝 playwright + chromium
npm test           # 測本機檔案（會自己開一個臨時 server）
npm run test:live  # 測已上線的網站
```

有 `ANTHROPIC_API_KEY` 環境變數時會連同 AI 辨識一起測（真的呼叫 API 約 3 次，成本 < US$0.05）；
沒設就自動跳過那幾項。截圖輸出到 `test/screenshots/`（已 gitignore）。

**改完 CSS 或版面一定要跑一次。** 這個專案最嚴重的 bug 是 CSS 疊代造成的，
只有真實瀏覽器抓得到 —— 純邏輯測試（jsdom 之類）讀的是 `hidden` 屬性，看不到疊代結果。

## 慣例

- 註解和使用者可見文字都用**繁體中文**。
- JS 風格刻意保守（`var`、`function`、IIFE），配合「不 transpile」的前提，也和既有程式碼一致。
- 使用者可見的錯誤訊息要具體、可行動（例如「框裡看不出單字，試著框大一點」），
  不要把原始 HTTP 錯誤丟給使用者看 —— `ai.js` 的 `readableError()` 負責轉換。
- 不要把 API key 寫進任何檔案或 log。
