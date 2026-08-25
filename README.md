# 單字練習室

一個純靜態的單字學習網站。可以自己打單字、拍照讓 AI 找出單字、在照片上框選看不懂的地方請 AI 辨識，
最後在複習區用間隔複習法把它們背起來。

沒有後端、沒有 build 步驟、沒有 npm —— 檔案 push 上去就是網站。

## 功能

| 頁面 | 做什麼 |
| --- | --- |
| ✍️ 新增單字 | 單筆輸入（可按「AI 幫我補齊」自動補音標／詞性／釋義／例句），或一次批次貼上一整串 |
| 📷 照片辨識 | 上傳／拍照 →「掃描整張圖」找出所有值得學的字，或在圖上**拖曳框選**只問框裡的內容（可框多處） |
| 📚 我的單字 | 搜尋、篩選（今天要複習／還沒複習／學習中／已掌握）、排序、編輯、刪除、匯出／匯入 JSON |
| 🎯 複習 | 四種題型：看英文想中文、看中文想英文、看中文拼英文、混合出題 |
| ⚙️ 設定 | API key、模型、學習語言／母語 |

## 開始使用

1. 打開網站，先到「⚙️ 設定」。
2. 到 [Claude Console](https://platform.claude.com/settings/keys) 建一組 API key，貼進來按「儲存設定」，
   再按「測試連線」確認可以用。
3. 之後就可以用「📷 照片辨識」和「AI 幫我補齊」了。

手動新增單字和複習**不需要** API key，只有 AI 相關功能才需要。

### 關於 API key 的安全性

這是純靜態網站（GitHub Pages），沒有伺服器可以幫你藏 key，所以做法是**你自己的 key 存在你自己的瀏覽器裡**，
由瀏覽器直接呼叫 Claude API（用官方的 `anthropic-dangerous-direct-browser-access` header）。

這代表：

- key 存在這台裝置的 `localStorage`，任何能操作這個瀏覽器的人都讀得到。
- 頁面上的任何腳本（包含瀏覽器擴充功能）理論上都讀得到。
- **請用一組專門給這個網站的 key，並在 Console 設好用量上限。** 不要用公司或正式產品的 key。
- 不想留著的時候，按設定頁的「忘記這組 key」就會刪掉。

如果之後想改成不必讓使用者自備 key，就要加一個小後端（例如 Cloudflare Workers）當代理，
把 key 放在伺服器端。那時候只需要改 `js/ai.js` 裡的 `ENDPOINT` 和 headers。

## 資料存在哪裡

全部在瀏覽器的 `localStorage`，不會上傳到任何伺服器 —— 只有你主動送去辨識的照片會傳給 Claude API。

因此：**換裝置或清瀏覽器資料前，先到「我的單字」按「匯出 JSON」備份。** 匯入時不會覆蓋現有資料，
同一個字只會補上空白欄位、並保留進度較好的那一份。

## 複習是怎麼排的

Leitner 盒子法。每個字有一個 0～6 的熟練度，答對往上一格、答錯掉回 0，
下次出現的間隔依序是 **0 / 1 / 2 / 4 / 8 / 16 / 32 天**。到第 5 格就算「已掌握」。

答錯的字間隔是 0 天，所以同一輪之後很快會再遇到。

## 檔案結構

```
index.html        版面與所有畫面
css/style.css     樣式
js/store.js       資料層：localStorage、去重、間隔複習排程、匯出匯入
js/ai.js          呼叫 Claude API、圖片縮放／裁切、結構化輸出的 schema 與提示語
js/app.js         介面邏輯：分頁、表單、照片框選、列表、複習、設定
```

## 部署

Settings → Pages → Source 選 `main` 分支的根目錄即可。沒有 build step，push 完等一下就更新。

本機測試建議起一個 server（`python3 -m http.server`）而不是直接開檔案，行為比較接近線上。

## 用到的 API

Claude [Messages API](https://platform.claude.com/docs/en/api/messages/create)，搭配：

- [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) —— base64 圖片輸入。
  送出前一律在瀏覽器端重新壓成 JPEG、長邊縮到 1600px 以內控制成本；
  框選出來的小區域則會放大到至少 900px，字才看得清楚。
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) —— 用
  `output_config.format` 指定 JSON schema，直接拿到乾淨的單字卡陣列，不用自己 parse 自由文字。

預設模型是 `claude-opus-5`，設定頁可以換成 Sonnet 5 或 Haiku 4.5 省錢。
