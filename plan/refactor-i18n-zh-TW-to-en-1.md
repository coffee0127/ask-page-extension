---
goal: Translate AskPage Chrome Extension UI from Traditional Chinese (zh-TW) to English with glossary and chunking scripts
version: 1.1
date_created: 2026-07-18
last_updated: 2026-07-20
owner: AskPage maintainer
status: 'In progress'
tags: [refactor, i18n, translation, process]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

本計畫將 doggy8088/ask-page-extension 擴充功能的硬編碼繁體中文 UI 字串翻譯為英文，並**採用 Chrome 原生 `chrome.i18n + _locales` 框架作為最終承載**（基於 chrome-extension-i18n-best-practice 研究[^3]）。該擴充功能無 i18n 框架，字串散落於 `manifest.json`、`popup.html`、`settings.html`(42.7KB)、`settings.js`(86.7KB)、`content.js`(362KB)、`background.js`(26.4KB)，約 640 條含中文字串[^1]。

本計畫產出兩階段成品：(1) **翻譯產出引擎**——雙語 glossary 檔案供翻譯模型遵循、分塊腳本（chunker）將 `content.js` 依函式邊界切分為 ~50K token 區塊確保 template literal 不被切斷、translator 呼叫 Ollama API 翻譯；(2) **i18n 框架承載**（Phase 6）——將翻譯產出承載於 `_locales/en/messages.json` + `_locales/zh_TW/messages.json`，JS 改寫為 `chrome.i18n.getMessage()`，manifest 改用 `__MSG_*__`。執行時語系切換由 `lib/i18n.js` 自建 locale loader 達成。推薦使用 `qwen3.5:397b` 或 `deepseek-v4-flash` 執行翻譯[^2]。

> **已知限制**：`chrome.i18n.getMessage` 僅做 `$name$` 替換，**不解析 ICU MessageFormat**（`{count, plural, ...}` 會原樣輸出）。故計數字串用純 `$count$` 形式，失去單複數區別（如「executed 1 steps」文法不完美但功能正確）。詳見 TRANSLATION-LOG §5。

## 1. Requirements & Constraints

- **REQ-001**: 翻譯目標語言為英文（en），保留繁體中文作為歷史紀錄
- **REQ-002**: 必須保留所有 `${...}` template-literal 佔位符 byte-for-byte（如 `${providerLabel}`、`${model}`、`${MAX_INPUT_CONTEXT_IMAGES}`）
- **REQ-003**: 必須保留斜線命令 token `/clear`、`/summary`、`/screenshot`、`/agent` 不譯；僅翻譯其 `desc` 描述
- **REQ-004**: 必須保留所有 emoji 前綴（📸 ⭕ ✅ ❌ 🤖 💬 💡 🎯 🔄 ➕ 🔍 ✏️ 🗑️ 📤 📥 ⚡ 🟢 🔴 ⏳ 📝 ✨ ⚠️ 🛠️ 📋 📏 🔗 📊）與 Markdown `**bold**` 及 `\n` 換行
- **REQ-005**: 必須保留 AI 提供者名稱（Gemini、OpenAI、Azure OpenAI、Anthropic、DeepSeek、OpenRouter、Groq、Mistral、Ollama）與模型 ID（`gemini-2.0-flash`、`gpt-5.6`、`claude-opus-4-7` 等）不譯
- **REQ-006**: 單引號 `'...'` JS 字串翻譯後若含撇號（don't、can't），必須改用雙引號 `"..."`、template literal 反引號或 `\'` 跳脫，避免打斷語法
- **REQ-007**: 同步更新 completion-trace 偵測：`content.js` 的 `isCompletionTraceMessage()` 比對 `'頁問已經打完收工'` 與 `'頁問提早收工'`，與輸出字串必須同步翻譯（行號以 `rg "頁問已經打完收工" content.js` 確認）
- **REQ-008**: 翻轉 LLM 系統提示語言：`content.js` 的 `buildSystemPrompt` 內 `'As a default, provide responses in zh-tw unless specified otherwise.'` 改為 `'en'`（行號以 `rg "provide responses in zh-tw" content.js` 確認）
- **REQ-009**: `content.js`(362KB) 必須分塊翻譯，每塊 ≤50K token，於函式邊界切分，避免切斷多行 template literal
- **REQ-010**: 保留 HTML 標籤、`aria-label`、`title`、`data-*` 屬性名稱不譯，僅翻譯屬性值中的中文
- **REQ-011**: 採用 Chrome 原生 `chrome.i18n + _locales` 框架承載翻譯，`manifest.json` 新增 `"default_locale": "en"`，建立 `_locales/en/messages.json` 與 `_locales/zh_TW/messages.json`，支援瀏覽器 locale 自動 fallback（zh_TW→en）[^3]
- **REQ-012**: 計數字串的理想形式為 ICU MessageFormat plural（`{count, plural, one {# step} other {# steps}}`），修復「executed 1 steps」文法錯誤。**但 `chrome.i18n.getMessage` 不解析 ICU MessageFormat**（實作驗證確認，僅做 `$name$` 替換），故採純 `$count$ steps` 形式，失去單複數區別——已知限制，詳見 TRANSLATION-LOG §5[^3]
- **REQ-013**: 計畫內行號為參考快照，執行前必須以 `rg` 重新確認實際行號（content.js 行數會隨 commit 變動）
- **REQ-014**: 建置期驗證 `default_locale` messages.json 涵蓋所有 `getMessage` 引用 key（缺 key 回傳空字串會靜默空白 UI）[^3]
- **CON-001**: 擴充功能原本無 `_locales/` 目錄與 `chrome.i18n` 框架；Phase 6 改採 `chrome.i18n + _locales` 框架，Phase 1-5 的就地替換工具保留為翻譯產出引擎
- **CON-002**: `popup.js` 無中文字串，不需處理[^1]
- **CON-003**: `lib/*.min.js` 為第三方函式庫，跳過
- **GUD-001**: 翻譯術語須遵循本計畫 §2 Phase 1 產出的 glossary，確保跨檔案一致（如「代理模式」統一為 "Agent Mode"）
- **GUD-002**: 品牌名「頁問 AskPage」統一為 "AskPage"；單字 Ask 按鈕 `btn.textContent = '問'` 改為 `'Ask'`（行號以 `rg "btn.textContent = '問'" content.js` 確認）
- **GUD-003**: 布林值陣列的中文值（`是`、`需要`、`勾選`、`否`、`不要`、`取消`）保留不譯以維持向後相容（行號以 `rg "'是'|'需要'|'勾選'" content.js` 定位，刻意保留）
- **PAT-001**: 分塊腳本依函式定義起點（`function ...`、`async function ...`）作為安全切分點，保證不切斷 template literal
- **SEC-001**: 翻譯過程不可外洩 API Key 或使用者資料；腳本僅處理原始碼字串

## 2. Implementation Steps

### Implementation Phase 1 — 產出雙語 Glossary 檔案

- GOAL-001: 建立包含 120+ 詞條的雙語 glossary Markdown 檔案，涵蓋品牌、模式、命令、UI chrome、設定、狀態/錯誤訊息、工具呼叫、佔位符、技術術語等類別，供後續翻譯 prompt 引用

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 建立 `scripts/i18n/glossary.zh-TW-en.md` 檔案，含 9 個分類表格（Brand、Modes、Commands、UI-Chrome、Settings、Status/Error、Tool-Calling、Placeholders、Technical-Terms-Keep-As-Is） | ✅ | 2026-07-18 |
| TASK-002 | 填入 Brand 類別：`頁問 AskPage`→AskPage、`頁問`→AskPage、`問`→Ask、`Will 保哥的技術交流中心`→Will's Tech Exchange Center，附註 content.js:533/5248-5249 同步需求 | ✅ | 2026-07-18 |
| TASK-003 | 填入 Modes 類別：`代理模式`→Agent Mode、`詢問模式`→Inquiry Mode、`截圖模式`→Screenshot Mode、`截圖功能`→Screenshot Feature、`含截圖`/`無截圖`→With/No Screenshot、`模式切換`→Mode Switch | ✅ | 2026-07-18 |
| TASK-004 | 填入 Commands 類別：`/clear`→Clear conversation history、`/summary`→Summarize this page、`/screenshot`→Toggle screenshot feature、`/agent`→Toggle inquiry/agent mode，附動態切換描述 | ✅ | 2026-07-18 |
| TASK-005 | 填入 UI-Chrome 類別：`AI 提供者`→AI Provider、`偏好設定`→Settings、`重置設定`→Reset Settings、`匯出`/`匯入`→Export/Import、`上傳圖片`→Upload Image、`標注畫面`→Annotate Screen、`取消`/`儲存`→Cancel/Save、`編輯`/`刪除`→Edit/Delete、`展開`/`收合`→Expand/Collapse、`在 CodePen 開啟`→Open in CodePen | ✅ | 2026-07-18 |
| TASK-006 | 填入 Settings 類別：`提供者類型`→Provider Type、`OpenAI 相容端點`→OpenAI-Compatible Endpoint、`API Key (選填)`→API Key (optional)、`模型名稱`→Model Name、`啟用模型`→Enabled models、`載入所有可用模型`→Load all available models、`測試連線`→Test Connection、`追加提示詞`→Additional Prompt、`系統提示`→System Prompt、`斜線命令`→Slash Commands、`字元`→characters | ✅ | 2026-07-18 |
| TASK-007 | 填入 Status/Error 類別：`系統提示已自動儲存！`→System prompt auto-saved!、`設定已重置！`→Settings reset!、`匯入失敗：檔案格式錯誤`→Import failed: invalid file format、`請求逾時`→Request timed out、`網路連線異常`→Network connection error、`配額已用盡`→Quota exhausted、`找不到指定的模型`→Specified model not found、`未知錯誤`→Unknown error（保留 emoji 前綴） | ✅ | 2026-07-18 |
| TASK-008 | 填入 Tool-Calling 類別：`已選擇工具`→Tool selected、`正在執行工具`→Executing tool、`已執行工具`→Tool executed、`規劃任務`→Planning task、`端點不支援 tool calling`→Endpoint does not support tool calling、`頁問已經打完收工，共執行 ${stats.stepCount} 個步驟`→AskPage finished, executed ${stats.stepCount} steps | ✅ | 2026-07-18 |
| TASK-009 | 填入 Placeholders 類別：`輸入問題後按 Enter；也可貼上或拖曳最多 4 張圖片作為上下文`→Type a question and press Enter; you can also paste or drag up to 4 images as context、`圖片上下文`→Image context、`支援 PNG / JPG / WebP 等圖片，單檔大小上限 10MB`→Supports PNG/JPG/WebP images, max 10MB per file | ✅ | 2026-07-18 |
| TASK-010 | 填入 Technical-Terms-Keep-As-Is 類別：Gemini、OpenAI、Azure OpenAI、Anthropic、DeepSeek、OpenRouter、Groq、Mistral、Ollama、API Key、Endpoint、Deployment Name、Base64、AES-256-GCM、chrome://extensions/、host_permissions、Context Window、TPM、PNG/JPG/WebP、CodePen、DOM、HTML、JSON-LD、OpenGraph、模型 ID 列表 | ✅ | 2026-07-18 |
| TASK-011 | 在 glossary 檔頭加入通用翻譯規則區塊：佔位符保留、emoji 保留、Markdown 保留、撇號跳脫規則、命令 token 不譯、布林值陣列保留、completion-trace 同步、system prompt 翻轉 zh-tw→en | ✅ | 2026-07-18 |

### Implementation Phase 2 — 產出分塊腳本（chunker）

- GOAL-002: 建立 Node.js 分塊腳本 `scripts/i18n/chunk-contentjs.mjs`，將 `content.js` 依函式邊界切分為 6 個 ~50K token 區塊，輸出獨立檔案供逐塊翻譯

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | 建立 `scripts/i18n/chunk-contentjs.mjs`，讀取 `content.js`，以正則 `/^(async\s+)?function\s+\w+|^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(?[^=]*\)?\s*=>/` 偵測函式定義起點作為候選切分點 | ✅ | 2026-07-18 |
| TASK-013 | 實作 token 估算函式 `estimateTokens(text)`：`Math.ceil(text.length / 3)`（中英混合約 3 chars/token），目標每塊 ≤50000 token | ✅ | 2026-07-18 |
| TASK-014 | 實作切分邏輯：動態累加行內容至 token 目標（48000），於最近的安全函式邊界（backtick 平衡）切分（純動態切分，無硬編碼行號，避免 content.js 行數變動導致 split points 過時） | ✅ | 2026-07-19 |
| TASK-015 | 純動態切分（無硬編碼 split points）：依 token 目標在安全函式邊界切分，`PREFERRED_SPLITS` 保留為空陣列作為軟提示介面。當前產出 3 個 chunk：1-3644、3645-7210、7211-9304，重組 byte-identical 通過 | ✅ | 2026-07-19 |
| TASK-016 | 輸出分塊檔至 `scripts/i18n/chunks/content.js.chunk-N.mjs`，每檔含原註解標頭 `// CHUNK N (lines X-Y) of content.js`。動態切分當前產出 **3 個 chunk**（1-3644、3645-7210、7211-9304）；chunk 數隨 content.js 內容自動調整，非固定（chunks 目錄已加入 .gitignore，為產出物） | ✅ | 2026-07-19 |
| TASK-017 | 同時輸出 `scripts/i18n/chunks/chunk-map.json`，記錄每塊的 `chunkIndex`、`startLine`、`endLine`、`tokenEstimate`、`anchorFunction` | ✅ | 2026-07-18 |
| TASK-018 | 實作驗證函式 `validateNoTemplateLiteralSplit()`：掃描每塊邊界，確保不切斷 `` `...` `` template literal（檢查 backtick 配對）與多行字串；失敗時報錯並退出（已實作 backtick 平衡檢查 + 重組等於原檔的權威安全閘，roundtrip byte-identical 驗證通過） | ✅ | 2026-07-18 |
| TASK-019 | 建立 `scripts/i18n/merge-contentjs.mjs`，讀取 6 個翻譯後 chunk 檔與 `chunk-map.json`，依行號區間合併回單一 `content.js`，覆寫前先備份原檔至 `content.js.zh-TW.bak` | ✅ | 2026-07-18 |

### Implementation Phase 3 — 產出翻譯執行腳本

- GOAL-003: 建立 `scripts/i18n/translate.mjs`，以 glossary 與 chunk 為輸入，呼叫 Ollama API 逐塊翻譯並套用保留規則

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | 建立 `scripts/i18n/translate.mjs`，讀取 `glossary.zh-TW-en.md` 與 `chunk-map.json` | ✅ | 2026-07-18 |
| TASK-021 | 實作 Ollama API 呼叫：base URL 預設 `http://localhost:8317/v1`（OpenAI 相容端點，可由 `--ollama` 或 `OLLAMA_URL` 覆寫），自動偵測格式——含 `/v1` 用 `/chat/completions`（OpenAI 相容），否則用 `/api/chat`（Ollama 原生）；model 預設 `qwen3.5:397b`，`stream: false`，`temperature: 0.3`（Ollama 原生模式另帶 `num_ctx: 65536`） | ✅ | 2026-07-18 |
| TASK-022 | 組裝系統提示：嵌入 glossary 全文 + 保留規則（佔位符/emoji/Markdown/命令 token/撇號跳脫）+ 「僅翻譯中文 UI 字串，其餘程式碼 byte-for-byte 保留」 | ✅ | 2026-07-18 |
| TASK-023 | 實作逐塊翻譯迴圈：對每個 chunk 檔發送 API 請求，取回翻譯後內容寫入 `scripts/i18n/chunks/content.js.chunk-N.en.mjs` | ✅ | 2026-07-18 |
| TASK-024 | 實作翻譯後驗證：對每塊執行 `${...}` 佔位符計數比對（原檔 vs 譯檔數量須一致）、backtick 配對檢查、單引號字串撇號掃描（若含撇號且未跳脫則警告）（佔位符計數比對已實作；引號掃描留待 Phase 4 手動 + `rg`） | ✅ | 2026-07-18 |
| TASK-025 | 實作 `--dry-run` 旗標：僅輸出 prompt 預覽與 chunk 對應表，不呼叫 API（已驗證 dry-run 輸出 7 chunks + 5 small files） | ✅ | 2026-07-18 |
| TASK-026 | 處理小檔案：對 `manifest.json`、`popup.html`、`settings.html`、`settings.js`、`background.js` 各自整檔送翻（皆 < 128K token，不需分塊） | ⚠️ N/A | 2026-07-19 | 由 Phase 6 i18n 框架取代（未用 LLM 整檔送翻；改用 glossary 直接產出 _locales） |

### Implementation Phase 4 — 套用翻譯並驗證

- GOAL-004: 套用翻譯結果至原始檔案，執行 lint 與手動抽檢，確保擴充功能可正常載入

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | 執行 `node scripts/i18n/merge-contentjs.mjs` 合併譯文 chunk 回 `content.js`；備份原檔 | ⚠️ N/A | 2026-07-19 | 由 Phase 6 取代（未用 chunk 翻譯流程；content.js 直接重構為 getMessage） |
| TASK-028 | 手動套用 `manifest.json`、`popup.html`、`settings.html`、`settings.js`、`background.js` 譯文（由 translate.mjs 輸出或人工貼入）——**若採 Phase 6 則此任務由 TASK-038..043 取代** | ⚠️ N/A | 2026-07-19 | 由 Phase 6 TASK-038..043 取代 |
| TASK-029 | 翻轉 `content.js` 的 `buildSystemPrompt` 系統提示 `zh-tw`→`en`（行號以 `rg "provide responses in zh-tw" content.js` 確認）；檢查 Gemini 語言限制錯誤訊息是否需移除「繁體中文」提及 | ✅ | 2026-07-19 | content.js:2692 `zh-tw`→`en` |
| TASK-030 | 同步更新 completion-trace：確認 `isCompletionTraceMessage()` 的比對字串與輸出字串譯文一致（行號以 `rg "頁問已經打完收工" content.js` 確認） | ✅ | 2026-07-19 | isCompletionTraceMessage 雙語偵測（zh + en）；輸出用 getMessage |
| TASK-031 | 執行 `npm run lint`（ESLint webextensions 環境）確認無語法錯誤 | ✅ | 2026-07-19 | PASS |
| TASK-032 | 載入擴充功能至 Chrome（Developer Mode > Load unpacked），測試：對話框開啟、設定頁顯示、斜線命令 `/clear`/`/summary`、模式切換、錯誤訊息顯示；**若採 Phase 6，額外測試 locale 切換**（macOS 系統語言切繁中→重啟 Chrome 驗證 UI 顯示中文、切英文→顯示英文） | ⏳ 待使用者 | 2026-07-19 | 需 Chrome 環境手動測試 |
| TASK-033 | 全文搜尋殘留中文字元：`rg -n '[\x{4e00}-\x{9fff}]' manifest.json popup.html settings.html settings.js content.js background.js`，預期僅剩布林值陣列的 `是/需要/勾選/否/不要/取消`（行號以 `rg "'是'|'需要'|'勾選'" content.js` 定位，刻意保留） | ✅ | 2026-07-19 | 殘留皆為刻意保留（detection markers、boolean arrays、main-world、logs、註解、footer credit、HTML fallback）；詳見 TRANSLATION-LOG.md §4 |

### Implementation Phase 5 — 補遺與收尾

- GOAL-005: 補查未覆蓋區域並產出翻譯紀錄

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-034 | 補查 `content.js:9251-9303`（DeepSeek/OpenRouter/Groq/Mistral provider 區段）是否有未翻譯的 API Key 錯誤訊息 | ✅ | 2026-07-19 | locales agent 已涵蓋（526 keys 含各 provider 錯誤訊息） |
| TASK-035 | 補查 `style.css` 是否含中文 `content:` 偽元素或註解（若採 Phase 6，改用 `__MSG_xxx__` 讓 Chrome 自動替換） | ✅ | 2026-07-19 | 3 個 content: 改 __MSG_*__（code_expand/collapse/streaming_status）；註解保留 |
| TASK-036 | 補查 `settings.js:1999` 至檔尾是否有殘留中文 | ✅ | 2026-07-19 | 殘留皆為刻意保留 |
| TASK-037 | 產出 `scripts/i18n/TRANSLATION-LOG.md`，記錄每檔翻譯條數、使用模型、API token 用量、已知未譯項、**Chrome Web Store 列表本地化步驟**（見 TASK-046） | ✅ | 2026-07-19 | scripts/i18n/TRANSLATION-LOG.md 產出 |

### Implementation Phase 6 — 採用 `chrome.i18n + _locales` 框架作為最終承載

- GOAL-006: 將 LLM 翻譯產出承載於 Chrome 原生 i18n 框架，支援多 locale 擴充與執行時 locale 自動選擇，修復 G1-G6 缺口[^3]

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-038 | 於 `manifest.json` 新增 `"default_locale": "en"`；`name`/`description`/`short_name`/`commands.*.description` 改為 `__MSG_extName__`/`__MSG_extDescription__` 等 | ✅ | 2026-07-19 | default_locale + 5 __MSG_*__；另加 short_name |
| TASK-039 | 建立 `_locales/en/messages.json` 與 `_locales/zh_TW/messages.json`，將 glossary 140+ 詞條轉為 `{"key":{"message":"...","description":"..."}}` 結構；含佔位符的條目宣告 `placeholders`（如 `$count$`→`{"content":"$1"}`） | ✅ | 2026-07-19 | 526 keys，en/zh_TW 對稱 |
| TASK-040 | 擴充 `translate.mjs`：新增 `--output-mode=i18n` 旗標，產出 `messages.json` 而非就地替換；LLM prompt 改為「產生 JSON key-value，key 用 snake_case（如 `settings_provider_type`、`cmd_clear_desc`、`agent_finished`）」 | ✅ | 2026-07-19 |
| TASK-041 | 將 `content.js`/`settings.js`/`background.js` 中硬編碼字串改為 `chrome.i18n.getMessage('key')` 或 `getMessage('key', [subs])`；template literal `` `已複製 ${n} 個` `` 改為 `getMessage('items_copied', [String(n)])` 搭配 `$count$` 佔位符 | ✅ | 2026-07-19 | 371/100/18 getMessage calls；boolean arrays 保留；completion-trace 雙語偵測 |
| TASK-042 | `settings.html`/`popup.html` 改用 `data-i18n="key"` + `data-i18n-placeholder="key"` 屬性 + 啟動腳本（`document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = chrome.i18n.getMessage(el.dataset.i18n))`）；content script 注入的 HTML 仍須 `getMessage`（Chrome 不自動替換 HTML） | ✅ | 2026-07-19 | 4/91 data-i18n attrs；lib/i18n-bootstrap.js 含 data-i18n-html 支援 |
| TASK-043 | `style.css` 若有中文 `content:` 改為 `__MSG_xxx__`（Chrome 自動替換 CSS）；manifest 與 CSS 的 `__MSG_*__` 自動替換，HTML/JS 需 `getMessage` | ✅ | 2026-07-19 | 3 個 content: 改 __MSG_*__ |
| TASK-044 | 套用 ICU 複數於計數字串：`agent_finished` 理想用 `{count, plural, one {AskPage finished, executed # step} other {AskPage finished, executed # steps}}` 修復「executed 1 steps」文法錯誤 | ⚠️ 部分 | 2026-07-19 | chrome.i18n.getMessage 不解析 ICU MessageFormat（僅 $name$ 替換）；改用純 $count$ steps，失去單複數區別。已知限制，詳見 TRANSLATION-LOG.md §5 |
| TASK-045 | 保留 `_locales/zh_TW/messages.json` 完整繁中內容（從原檔萃取），修復 G4——zh-TW 使用者依瀏覽器 locale 自動取得中文 UI（fallback 鏈：zh_TW→en） | ✅ | 2026-07-19 | zh_TW 526 keys 完整繁中 |
| TASK-046 | Chrome Web Store 列表本地化：於 Developer Dashboard "Add a new language" UI 逐語系輸入標題/說明/截圖（獨立於 `_locales`）；於 `TRANSLATION-LOG.md` 記錄步驟。注意：`_locales` 不影響 Store 頁面顯示，僅影響瀏覽器內 manifest 名稱 | ⏳ 待使用者 | 2026-07-19 | 步驟記錄於 TRANSLATION-LOG.md §7；需 Dashboard 手動操作 |
| TASK-047 | 新增建置期檢查腳本 `scripts/i18n/validate-messages.mjs`：確認 `default_locale` messages.json 涵蓋所有 `getMessage` 引用的 key（缺 key 回傳空字串會靜默空白 UI），反之亦然；缺漏即報錯 | ✅ | 2026-07-19 |

### Implementation Phase 7 — 翻譯安全強化（修復 G7/G8/G9/G10）

- GOAL-007: 強化翻譯後自動驗證，從 warn-only 升級為 fail-fast，捕捉語法與語義漂移

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-048 | `translate.mjs` 的 `validatePlaceholders` 改為 fail-fast：`${...}` 數量不一致時 **不寫入** 譯檔並拋錯（修復 G7，原僅 warn 不 abort）；以 `--strict=false` 可關閉 | ✅ | 2026-07-19 |
| TASK-049 | 新增 `scripts/i18n/validate-syntax.mjs`：對每個譯後 chunk 用 `node --check` 做 AST 語法驗證（捕捉撇號未跳脫、引號打斷、template literal 損壞），失敗即拒絕該 chunk（修復 G8/G10） | ✅ | 2026-07-19 |
| TASK-050 | 新增撇號安全自動掃描：對譯後檔以 `node --check` 解析，找出所有含 `'` 的單引號字串節點並報錯（自動化 G10，取代手動 `rg`）；`rg -n "don't\|can't\|won't\|isn't\|doesn't\|it's" content.js settings.js background.js` 確認所有 hit 在雙引號或反引號內 | ✅ | 2026-07-19 |
| TASK-051 | 修正 `chunk-contentjs.mjs` 的 `anchorFunction` 偵測：掃描 chunk 起始行往後 5 行內首個 `function`/`const`/`let` 宣告名稱，而非僅看 `startLine-1` 行（修復 G9，原全為 `(file start)`） | ✅ | 2026-07-19 |

## 3. Alternatives

- **ALT-001**: ~~改用 Chrome i18n 框架（新增 `_locales/en/messages.json` + `_locales/zh_TW/messages.json` 並重構所有字串為 `chrome.i18n.getMessage()`）。優點：標準化、可擴充多語；缺點：重構量大（640+ 字串）、需改動所有 JS/HTML 引用點、超出「翻譯」範圍。未採用，採就地替換以最小變動達成英文 UI。~~
  - **現已採用為 Phase 6**。理由：(a) 未來 locale 擴充為純資料檔新增、零程式碼變動，長期成本低於就地替換；(b) content script isolated world 可同步用 `getMessage`，無技術阻礙；(c) 執行時語系切換由 `lib/i18n.js` 自建 loader 滿足。保留 Phase 1-5 翻譯引擎，Phase 6 改變承載方式，最小變動取得原生 i18n 的佔位符/fallback/manifest 整合好處。注意：`chrome.i18n.getMessage` 不解析 ICU MessageFormat，複數需 JS 端處理或純 `$count$` 形式（已知限制）。
- **ALT-005**: 純就地字串替換（不採 `_locales`）。優點：最小變動、單一語言最快達成；缺點：無未來 locale 擴充路徑（每加一語言需重跑 LLM pipeline）、無執行時語言切換、無複數處理、現有 zh-TW 使用者失去偏好語言、manifest name 硬編碼無法隨 locale 變動。**僅適用確定永遠只支援英文的場景**；否則推薦 Phase 6。
- **ALT-002**: 整檔送翻 `content.js`（不分塊）給 1M 上下文模型如 `deepseek-v4-flash`。優點：一次完成、術語自動一致；缺點：362KB 檔案 API 回應可能截斷、單次成本高、錯誤重試需整檔重來。未採用為主流程，但可作為 `deepseek-v4-flash` 使用者的 `--no-chunk` 選項。
- **ALT-003**: 使用商用 API（DeepSeek API、OpenAI）取代本地 Ollama。優點：品質穩定；缺點：需外送原始碼、有隱私與成本考量。未採用，保留 Ollama 本地/雲端選項。
- **ALT-004**: 以 `gpt-oss:120b` 本地單 GPU 執行。優點：Apache 2.0、agentic 強；缺點：128K 上下文對 362KB content.js 偏緊需分塊、中文非強項。列為備選，不為主流程。
- **ALT-006**: 採 i18next（vendored `lib/i18next.min.js` ~13KB gz 或引入 bundler）+ `_locales` for manifest。優點：執行時 `changeLanguage()` 不需重啟瀏覽器、巢狀 key、翻譯工具鏈優；缺點：需 bundler 或 vendored lib、兩套系統並存（i18next for UI + `_locales` for manifest）。**僅在需 in-session 語言切換或與 web app 共用翻譯 JSON 時採用**；否則 Phase 6 的純 `chrome.i18n` + `lib/i18n.js` loader 已足夠（uBlock Origin 與 Google 官方範例皆採純 `chrome.i18n`）[^3]。

## 4. Dependencies

- **DEP-001**: Node.js ≥18（執行 `.mjs` 腳本與 ES module）
- **DEP-002**: Ollama 或 OpenAI 相容服務（base URL 預設 `http://localhost:8317/v1`，可由 `--ollama` 或 `OLLAMA_URL` 覆寫），已 pull `qwen3.5:397b` 或 `deepseek-v4-flash`
- **DEP-003**: ESLint 與 `npm run lint`（已存在於 repo，驗證翻譯後語法）
- **DEP-004**: Chrome 瀏覽器 Developer Mode（手動載入測試）
- **DEP-005**: ripgrep（`rg`）用於殘留中文掃描（環境已具備）

## 5. Files

- **FILE-001**: `scripts/i18n/glossary.zh-TW-en.md`（新建）— 雙語詞彙表，140+ 詞條，11 分類
- **FILE-002**: `scripts/i18n/chunk-contentjs.mjs`（新建）— content.js 分塊腳本
- **FILE-003**: `scripts/i18n/chunks/content.js.chunk-N.mjs`（腳本產出，已加入 .gitignore）— 分塊檔，數量隨 content.js 動態調整
- **FILE-004**: `scripts/i18n/chunks/chunk-map.json`（新建，腳本產出）— 分塊索引
- **FILE-005**: `scripts/i18n/translate.mjs`（新建）— Ollama API 翻譯執行腳本（Phase 7 新增 `--output-mode=i18n` 與 fail-fast）
- **FILE-006**: `scripts/i18n/merge-contentjs.mjs`（新建）— 譯文合併腳本
- **FILE-007**: `scripts/i18n/TRANSLATION-LOG.md`（新建）— 翻譯紀錄（含 Store 列表本地化步驟）
- **FILE-008**: `manifest.json`（修改）— 新增 `default_locale: "en"`、name/description/commands.*.description 改 `__MSG_*__`（Phase 6）
- **FILE-009**: `popup.html`（修改）— 3 條字串改 `data-i18n` 屬性（Phase 6）
- **FILE-010**: `settings.html`（修改）— 103 條字串改 `data-i18n`/`data-i18n-placeholder`（Phase 6）
- **FILE-011**: `settings.js`（修改）— 104 條字串改 `chrome.i18n.getMessage()`（Phase 6）
- **FILE-012**: `content.js`（修改）— 402 條字串改 `getMessage()` + 系統提示 zh-tw→en + completion-trace 同步（Phase 6）
- **FILE-013**: `background.js`（修改）— 30 條字串改 `getMessage()`（Phase 6）
- **FILE-014**: `content.js.zh-TW.bak`（新建備份）— 翻譯前原檔備份
- **FILE-015**: `_locales/en/messages.json`（新建，Phase 6）— 英文訊息表（default_locale）
- **FILE-016**: `_locales/zh_TW/messages.json`（新建，Phase 6）— 繁中訊息表（從原檔萃取，保留現有中文使用者體驗）
- **FILE-017**: `scripts/i18n/validate-messages.mjs`（新建，Phase 6）— key 涵蓋驗證腳本
- **FILE-018**: `scripts/i18n/validate-syntax.mjs`（新建，Phase 7）— `node --check` AST 語法驗證
- **FILE-019**: `style.css`（修改，若有中文 `content:`）— 改 `__MSG_*__`（Phase 6）

## 6. Testing

- **TEST-001**: `node scripts/i18n/chunk-contentjs.mjs` 產出 chunk 檔與 chunk-map.json，重組檢查 PASSED（chunks 重組 byte-identical 等於原 content.js）；動態切分產出 3 個 chunk（44.7K/45K/30.3K token，全 ≤ HARD_MAX）
- **TEST-002**: `node scripts/i18n/translate.mjs --dry-run` 輸出 prompt 預覽與 chunk 對應表，確認每塊 token 估算 ≤50000
- **TEST-003**: 翻譯後 `${...}` 佔位符計數比對：每塊原檔與譯檔的 `${` 出現次數一致（Phase 7 後為 fail-fast，不一致即拒寫）
- **TEST-004**: `npm run lint` 通過，無 ESLint 錯誤
- **TEST-005**: Chrome 載入擴充功能後，對話框、設定頁、斜線命令、模式切換、錯誤訊息皆顯示英文
- **TEST-006**: `rg -n '[\x{4e00}-\x{9fff}]'` 僅回傳布林值陣列中文（行號執行前以 `rg "'是'|'需要'|'勾選'" content.js` 重新定位，刻意保留）
- **TEST-007**: completion-trace 功能測試：觸發 agent 模式任務完成，確認 `isCompletionTraceMessage()`（`content.js:532-535`）正確偵測譯文後的完成訊息（與 `5288-5289` 同步）
- **TEST-008**: 引號安全掃描：`rg -n "don't|can't|won't|isn't|doesn't|it's" content.js settings.js background.js` 確認所有含撇號字串皆使用雙引號或反引號或已跳脫（Phase 7 後由 `validate-syntax.mjs` 自動化）
- **TEST-009**: `node scripts/i18n/validate-messages.mjs` 通過——`_locales/en/messages.json` 涵蓋所有 `getMessage` 引用 key，反之亦然
- **TEST-010**: `node scripts/i18n/validate-syntax.mjs` 對所有譯後 chunk 通過 `node --check` AST 語法驗證
- **TEST-011**: locale 切換測試——macOS 系統語言切繁體中文→重啟 Chrome→擴充功能 UI 顯示中文；切英文→顯示英文（驗證 `_locales` fallback 鏈 zh_TW→en）
- **TEST-012**: ICU 複數測試——觸發 stepCount=1 的完成訊息，確認顯示 "executed 1 step"（非 "1 steps"）；stepCount=5 顯示 "5 steps"

## 7. Risks & Assumptions

- **RISK-001**: 模型可能誤譯 `${...}` 佔位符或 emoji，導致程式執行錯誤。對策：翻譯後自動計數比對（Phase 7 fail-fast）+ lint + 手動載入測試
- **RISK-002**: 多行 template literal（如 content.js:4375-4383 截圖測試訊息）若被分塊切斷，合併後語法錯誤。對策：分塊腳本強制切分於函式邊界 + backtick 平衡檢查 + 重組 byte-identical 驗證
- **RISK-003**: completion-trace 偵測字串（`content.js:532-535` vs `5288-5289`）若未同步翻譯，agent 模式完成偵測失效。對策：glossary 標註同步需求 + TASK-030 手動驗證
- **RISK-004**: 系統提示翻轉 zh-tw→en 後，既有使用者的 AI 回答語言改變。對策：為預期行為，於 CHANGELOG 記錄
- **RISK-005**: `content.js:9251-9303` 與 `settings.js` 檔尾可能有未偵測的中文字串。對策：Phase 5 補查 + 殘留中文掃描
- **RISK-006**: Ollama 本地模型 128K 上下文對 50K token chunk 綽綽有餘，但若使用者改用較小上下文模型可能截斷。對策：translate.mjs 預設 `num_ctx: 65536`，chunk 上限 50000 token
- **RISK-007**: 計畫內行號為快照，content.js 行數隨 commit 變動會導致行號偏移，照行號逐行編輯可能改錯位置。對策：REQ-013 要求執行前以 `rg` 重新確認 + 以字串特徵定位（如 `rg "provide responses in zh-tw"`、`rg "頁問已經打完收工"`）
- **RISK-008**: `chrome.i18n` 執行時語言綁定瀏覽器 UI locale，無法在擴充功能內切換語言而不重啟瀏覽器。對策：settings 頁由 `lib/i18n.js` 自建 loader 繞過；content.js/background.js 仍依瀏覽器 locale；若未來需全域 in-session 切換，引入 i18next（ALT-006）
- **RISK-009**: 缺 key 時 `getMessage` 回傳空字串（非 key 名），導致靜默空白 UI。對策：REQ-014 + TASK-047 建置期 `validate-messages.mjs` 涵蓋檢查
- **ASSUMPTION-001**: repo 處於 `main` 分支 commit 47c3829 狀態；**行號可能隨 commit 變動**，執行前應 `git pull` 並以 `rg` 重新確認（REQ-013）
- **ASSUMPTION-002**: 使用者已安裝 Ollama 並 pull 至少一款推薦模型；若無，翻譯腳本會在 API 連線失敗時報錯
- **ASSUMPTION-003**: 布林值陣列中文保留不譯不影響功能，因英文 `true`/`false` 已在陣列中（行號執行前以 `rg` 重新定位）
- **ASSUMPTION-004**: glossary 140+ 詞條覆蓋 640 條字串的主要重複模式；一次性字串由模型依規則自行翻譯
- **ASSUMPTION-005**: AskPage 無 bundler 且傾向維持 vendored `lib/*.min.js` 模式 → 採 Phase 6 純 `chrome.i18n`（非 i18next），避免引入 bundler
- **ASSUMPTION-006**: 未來可能需保留 zh-TW 與第三 locale → 採 `_locales` 而非就地替換，使 locale 擴充為純資料檔新增

### Implementation Phase 8 — 審查報告修復（.review-reports/i18n/report.md）

- GOAL-008: 修復審查報告指出的 4 個嚴重 + 5 個建議問題，使發布流程、執行時語系傳播、分塊安全與文件與 v1.0 實作一致

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-052 | [嚴重] manifest `default_locale` 由 `zh_TW` 改為 `en`，與 `lib/i18n.js` `AVAILABLE_LOCALES[0]=en`、plan、README、TRANSLATION-LOG 的 fallback 契約一致；非 en/zh-TW 瀏覽器不再 fallback 到 zh_TW 造成語言混用 | ✅ | 2026-07-20 |
| TASK-053 | [嚴重] 發布壓縮檔納入 `_locales`：`npm run package`、`release.yml`、`manual-build.yml`、`quality-check.yml` 的 zip 指令加入 `_locales/`；CI 上傳前驗證壓縮檔內含兩份 `messages.json` | ✅ | 2026-07-20 |
| TASK-054 | [嚴重] 已開啟分頁收到語言變更：`lib/i18n.js` 註冊 `chrome.storage.onChanged`，`ASKPAGE_LOCALE_PREF` 變動時 `applyLocale(newValue)`；`content.js` 改從 `askpageI18n.getLocale()` 取得 AI 回覆語系，並在 `onChange` 重建已開啟的對話框 | ✅ | 2026-07-20 |
| TASK-055 | [嚴重] 分塊工具改用 AST 頂層邊界：`chunk-contentjs.mjs` 以 `acorn`（vendored `lib/acorn.min.js` 或 Node 內建）解析頂層節點 `loc.start.line`，在 `HARD_MAX_TOKENS` 內選最近頂層邊界，並對每個 chunk `node --check`；廢棄 backtick-parity heuristic | ✅ | 2026-07-20 |
| TASK-056 | [建議] `validate:i18n` 納入 build：新增 `npm run validate:i18n`（`validate-messages.mjs --locale=en` + `--locale=zh_TW`），`build` 改為 `npm run lint && npm test && npm run validate:i18n`；`validate-syntax.mjs` 無 chunk 時仍檢查 `out/` whole-file 輸出 | ✅ | 2026-07-20 |
| TASK-057 | [建議] 內建命令描述跟隨語系：`settings.js` `BUILT_IN_COMMANDS` 改為 `getBuiltInCommands()` 函式，`renderCommands` 每次渲染時呼叫，描述不再固定於模組載入語系 | ✅ | 2026-07-20 |
| TASK-058 | [建議] 替代值 `$&`/`$$` 當純文字：`lib/i18n.js` `buildMessage` placeholder 替換改用 replacement function `() => value`，避免 visible 值被 `String.replace` 當成特殊替代語法 | ✅ | 2026-07-20 |
| TASK-059 | [建議] 補 i18n 模組測試：新增 `tests/i18n-loader.test.js` 涵蓋初始選擇、偏好覆蓋、`storage.onChanged` 傳播、`$&`/`$$` 替代、缺 key fallback、切換後內建命令描述 | ✅ | 2026-07-20 |
| TASK-060 | [建議] 文件同步：`scripts/i18n/README.md` 與 `TRANSLATION-LOG.md` 更新為 `default_locale: en`、529 keys、`t()` 呼叫、AST chunker，移除過時的 526 keys / 7 chunks / `chrome.i18n.getMessage` 呼叫數描述 | ✅ | 2026-07-20 |

## 8. Related Specifications / Further Reading

- **i18n 最佳實務研究報告**：`plan/i18n/research/chrome-extension-i18n-best-practice.md`
- repo：[doggy8088/ask-page-extension](https://github.com/doggy8088/ask-page-extension)
- Ollama API 文件：https://github.com/ollama/ollama/blob/main/docs/api.md
- Chrome Extension i18n API reference：https://developer.chrome.com/docs/extensions/reference/api/i18n
- messages.json 格式：https://developer.chrome.com/docs/extensions/how-to/ui/localization-message-formats
- manifest default_locale：https://developer.chrome.com/docs/extensions/reference/manifest
- Google 官方 i18n 範例：https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/il8n
- uBlock Origin（純 chrome.i18n 教科書範例）：https://github.com/gorhill/uBlock/blob/master/platform/chromium/manifest.json
- FormatJS ICU MessageFormat 語法（供未來引入複數支援參考）：https://formatjs.io/docs/core-concepts/icu-syntax/

[^1]: ask-page-extension repo 調查 — [GitHub doggy8088/ask-page-extension](https://github.com/doggy8088/ask-page-extension)；檔案大小與中文字串計數由 research 子代理 grep 抽取
[^2]: 模型推薦 — [Qwen3.5 Ollama library](https://ollama.com/library/qwen3.5)、[DeepSeek V4 Flash Ollama library](https://ollama.com/library/deepseek-v4-flash)、[HF Qwen3.5-397B-A17B](https://huggingface.co/Qwen/Qwen3.5-397B-A17B)
[^3]: Chrome i18n 最佳實務研究 — [Chrome i18n API reference](https://developer.chrome.com/docs/extensions/reference/api/i18n)、[messages.json 格式](https://developer.chrome.com/docs/extensions/how-to/ui/localization-message-formats)、[Google i18n 範例](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/il8n)、[uBlock Origin](https://github.com/gorhill/uBlock/blob/master/platform/chromium/manifest.json)；完整研究報告 `plan/i18n/research/chrome-extension-i18n-best-practice.md`