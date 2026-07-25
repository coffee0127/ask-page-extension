# AskPage UI Translation Glossary (zh-TW → en)

> 翻譯 doggy8088/ask-page-extension 擴充功能硬編碼 UI 字串時，模型必須遵循本詞彙表與通用規則。
> Source repo: https://github.com/doggy8088/ask-page-extension (commit 47c3829)
> Generated: 2026-07-18

---

## 0. General Translation Rules (MUST follow)

1. **Template-literal 佔位符 `${...}` 必須 byte-for-byte 保留**，不可翻譯、刪除、移位元。例：`${providerLabel}`、`${model}`、`${stats.stepCount}`、`${MAX_INPUT_CONTEXT_IMAGES}`、`${error.message}`。
2. **斜線命令 token 不譯**：`/clear`、`/summary`、`/screenshot`、`/agent` 保持原樣，僅翻譯其 `desc` 描述欄位。
3. **Emoji 前綴保留**：`📸 ⭕ ✅ ❌ 🤖 💬 💡 🎯 🔄 ➕ 🔍 ✏️ 🗑️ 📤 📥 ⚡ 🟢 🔴 ⏳ 📝 ✨ ⚠️ 🛠️ 📋 📏 🔗 📊` 不可刪除或替換。
4. **Markdown 格式保留**：`**bold**`、`` `code` ``、`\n` 換行須原樣保留。
5. **撇號跳脫規則**：翻譯後英文字串若含 `'`（如 don't、can't、isn't、doesn't），且原字串為單引號 `'...'` 包裹，必須改用雙引號 `"..."`、反引號 `` `...` `` 或 `\'` 跳脫，避免打斷 JS 語法。
6. **品牌名**：`頁問 AskPage` / `頁問` → `AskPage`；單字按鈕 `問` → `Ask`（content.js:3190）。
7. **技術術語不譯**：AI 提供者名、模型 ID、API Key、Endpoint、chrome://extensions/ 等保持原樣（見 §9）。
8. **HTML 標籤與屬性名不譯**：`aria-label`、`title`、`data-*` 屬性名保留，僅翻譯屬性值中的中文。
9. **布林值陣列保留**：布林值陣列的 `是/需要/勾選/否/不要/取消` 刻意保留不譯（向後相容）。行號執行前以 `rg "'是'|'需要'|'勾選'" content.js` 重新定位（原 v1.0 稱 6068/6072 已過時，實測為不相關碼）。
10. **Completion-trace 同步**：`content.js:532-535` 的 `isCompletionTraceMessage()` 比對 `'頁問已經打完收工'` 與 `'頁問提早收工'`，翻譯時必須與 `content.js:5288-5289`（原 v1.0 稱 5248-5249 已過時）的輸出字串同步改為 `AskPage finished, executed ${stats.stepCount} steps` / `AskPage stopped early, executed ${stats.stepCount} steps`。執行前以 `rg "頁問已經打完收工" content.js` 確認行號。
11. **系統提示翻轉**：`content.js:2728`（`buildSystemPrompt` 內，原 v1.0 稱 2689 已過時）的 `'As a default, provide responses in zh-tw unless specified otherwise.'` 改為 `'en'`。執行前以 `rg "provide responses in zh-tw" content.js` 確認行號。
12. **僅翻譯中文 UI 字串**：其餘程式碼、註解中的英文、CSS、HTML 結構 byte-for-byte 保留。
13. **（v1.1 Phase 6）i18n 框架承載**：若採 `--output-mode=i18n`，翻譯產出為 `_locales/en/messages.json` 的 `{"key":{"message":"...","description":"..."}}` 結構，key 用 snake_case（如 `settings_provider_type`、`cmd_clear_desc`、`agent_finished`）。含變數的條目用 `placeholders`（`$count$`→`{"content":"$1"}`）。
14. **（v1.1 Phase 6）ICU 複數**：計數字串用 ICU MessageFormat（Chrome 84+ 原生支援），如 `agent_finished`：`{count, plural, one {AskPage finished, executed # step} other {AskPage finished, executed # steps}}`——修復「executed 1 steps」文法錯誤。
15. **（v1.1 Phase 6）`__MSG_*__` 與 getMessage 範圍**：manifest.json 與 CSS 用 `__MSG_*__`（Chrome 自動替換）；HTML 與 JS 需 `chrome.i18n.getMessage('key')`（Chrome 不自動替換 HTML）。content script isolated world 可同步用 `getMessage`。

---

## 1. Brand

| zh-TW | English | Notes |
|---|---|---|
| `頁問 AskPage` | `AskPage` | manifest.json:4, popup.html, settings.html |
| `頁問` | `AskPage` | content.js:2920, 533, 5248-5249（533 須與 5248-5249 同步） |
| `問` | `Ask` | content.js:3190 (單字按鈕 glyph) |
| `Will 保哥的技術交流中心` | `Will 保哥的技術交流中心` | settings.html footer（不特別翻譯，維持中文） |

## 2. Modes

| zh-TW | English |
|---|---|
| `代理模式` | `Agent Mode` |
| `代理` | `Agent` |
| `詢問模式` | `Ask Mode` |
| `詢問` | `Ask` |
| `截圖模式` | `Screenshot Mode` |
| `截圖功能` | `Screenshot Feature` |
| `截圖` | `Screenshot` |
| `含截圖` | `With Screenshot` |
| `無截圖` | `No Screenshot` |
| `模式切換` | `Mode Switch` |
| `模式` | `Mode` |
| `標注模式` | `Annotation Mode` |

## 3. Commands (slash tokens preserved, translate only desc)

| Token | zh-TW desc | English desc |
|---|---|---|
| `/clear` | `清除提問歷史紀錄` | `Clear conversation history` |
| `/summary` | `總結本頁內容` | `Summarize this page` |
| `/screenshot` | `切換截圖功能狀態` | `Toggle screenshot feature` |
| `/screenshot` | `停用截圖功能` / `啟用截圖功能` | `Disable screenshot` / `Enable screenshot` |
| `/agent` | `切換詢問 / 代理模式（代理模式會使用頁面 HTML 與工具調用）` | `Toggle ask/agent mode (agent mode uses page HTML and tool calling)` |
| `/agent` | `切換為詢問模式（只做內容問答）` / `切換為代理模式（允許工具調用）` | `Switch to ask mode (content Q&A only)` / `Switch to agent mode (tool calling allowed)` |
| `自訂命令` | — | `Custom command` |
| `內建命令` | — | `Built-in command` |
| `內建` | — | `Built-in` |
| `編輯內建命令` | — | `Edit built-in command` |
| `編輯自訂命令` | — | `Edit custom command` |
| `新增自訂命令` | — | `Add custom command` |

## 4. UI Chrome / Buttons

| zh-TW | English | Notes |
|---|---|---|
| `AI 提供者` | `AI Provider` | |
| `新增 AI 提供者` | `Add AI Provider` | preserve `➕` |
| `編輯 AI 提供者` | `Edit AI Provider` | |
| `開啟選項` | `Open Settings` | |
| `偏好設定` | `Settings` | |
| `重置設定` | `Reset` | preserve `🔄` |
| `匯出` | `Export` | preserve `📤` |
| `匯入` | `Import` | preserve `📥` |
| `上傳圖片` | `Upload Image` | |
| `標注畫面` | `Annotate Screen` | |
| `取消` | `Cancel` | |
| `儲存` | `Save` | |
| `編輯` | `Edit` | preserve `✏️` |
| `刪除` | `Delete` | preserve `🗑️` |
| `複製到剪貼簿` | `Copy to clipboard` | |
| `展開` / `收合` | `Expand` / `Collapse` | |
| `展開全部` | `Expand all` | |
| `展開完整程式碼` | `Expand full code` | |
| `在 CodePen 開啟` | `Open in CodePen` | |
| `已開啟` / `失敗` | `Opened` / `Failed` | |
| `送出提問` | `Submit question` | |
| `關閉` | `Close` | |
| `確定` | `Confirm` | |

## 5. Settings / Form Labels

| zh-TW | English |
|---|---|
| `提供者類型` | `Provider Type` |
| `提供者自訂名稱` | `Provider Name` |
| `OpenAI 相容端點` | `OpenAI-Compatible Endpoint` |
| `API Key (選填)` | `API Key (optional)` |
| `模型名稱` | `Model Name` |
| `啟用模型 (可複選，最少選一個)` | `Enabled models (multi-select, at least one)` |
| `載入所有可用模型` | `Load all available models` |
| `手動輸入模型名稱` | `Enter model manually` |
| `載入本機模型` | `Load local models` |
| `載入最新雲端模型` | `Load latest cloud models` |
| `載入端點模型` | `Load endpoint models` |
| `測試連線` | `Test Connection` |
| `追加提示詞` | `Additional Prompt` |
| `系統提示` | `System Prompt` |
| `調整系統提示` | `Adjust System Prompt` |
| `斜線命令` | `Slash Commands` |
| `自訂斜線命令` | `Custom Slash Commands` |
| `斜線命令管理` | `Slash Command Management` |
| `命令名稱` | `Command Name` |
| `提示內容` | `Prompt Content` |
| `啟用截圖模式` | `Enable screenshot mode` |
| `AI 提供者設定` | `AI Provider Settings` |
| `若不需要可留空` | `Leave blank if not required` |

## 6. Status / Error Messages

| zh-TW | English | Notes |
|---|---|---|
| `系統提示已自動儲存！` | `System prompt auto-saved!` | preserve `✅` |
| `設定已重置！` | `Settings reset!` | |
| `設定已匯出！` | `Settings exported!` | |
| `設定匯入成功！正在重新載入...` | `Settings imported! Reloading...` | |
| `匯入失敗：檔案格式錯誤` | `Import failed: invalid file format` | |
| `提供者已儲存！` | `Provider saved!` | |
| `提供者已刪除` | `Provider deleted` | |
| `已切換使用模型為 ${model}` | `Switched active model to ${model}` | template literal |
| `已成功載入 ${models.length} 個模型！` | `Successfully loaded ${models.length} models!` | template literal |
| `⏳ 測試中...` | `⏳ Testing...` | preserve `⏳` |
| `⏳ 處理中...` | `⏳ Processing...` | |
| `🟢 連線測試成功` | `🟢 Connection successful` | preserve `🟢` |
| `🔴 連線失敗: ${errorMsg}` | `🔴 Connection failed: ${errorMsg}` | preserve `🔴` |
| `請輸入 Gemini API Key` | `Please enter Gemini API Key` | |
| `請至少勾選一個 Gemini 模型` | `Please select at least one Gemini model` | |
| `請至少勾選一個` | `Please select at least one` | |
| `請求逾時` | `Request timed out` | |
| `網路連線異常` | `Network connection error` | |
| `回應格式異常` | `Unexpected response format` | |
| `驗證失敗` | `Authentication failed` | |
| `權限不足` | `Insufficient permissions` | |
| `找不到資源` | `Resource not found` | |
| `請求格式錯誤` | `Bad request` | |
| `配額已用盡` | `Quota exhausted` | |
| `服務忙碌或請求過多` | `Service busy / too many requests` | |
| `服務暫時異常` | `Service temporarily unavailable` | |
| `請求失敗` | `Request failed` | |
| `未知錯誤` | `Unknown error` | |
| `找不到指定的模型` | `Specified model not found` | |
| `無效的 Gemini API Key` | `Invalid Gemini API Key` | |
| `操作失敗: ${err.message}` | `Operation failed: ${err.message}` | |
| `API 回傳錯誤: ${response.status} ${errText}` | `API error: ${response.status} ${errText}` | |

## 7. Tool Calling / Agent Status

| zh-TW | English | Notes |
|---|---|---|
| `已選擇工具` | `Tool selected` | |
| `正在執行工具` | `Executing tool` | preserve `🛠️` |
| `已執行工具` | `Tool executed` | |
| `正在擷取畫面與整理頁面上下文` | `Capturing screen and organizing page context` | |
| `正在整理頁面上下文` | `Organizing page context` | |
| `規劃任務` | `Planning task` | |
| `端點不支援 tool calling` | `Endpoint does not support tool calling` | |
| `正在請 ${providerLabel} 規劃任務...` | `Asking ${providerLabel} to plan the task...` | template literal |
| `正在請 ${providerLabel} 分析頁面並回答問題...` | `Asking ${providerLabel} to analyze the page and answer...` | |
| `已取得最終回覆，正在整理答案...` | `Got final reply, organizing answer...` | |
| `工具呼叫輪數已達上限，已中止以避免無限循環。` | `Tool call round limit reached, aborted to avoid infinite loop.` | |
| `費時：${...}` | `Elapsed: ${...}` | |
| `頁問已經打完收工，共執行 ${stats.stepCount} 個步驟` | `AskPage finished, executed ${stats.stepCount} steps` | **須同步 content.js:533** |
| `頁問提早收工，共執行 ${stats.stepCount} 個步驟` | `AskPage stopped early, executed ${stats.stepCount} steps` | **須同步 content.js:533** |
| `（失敗）` | `(failed)` | |
| `結果摘要：` | `Result summary: ` | |

## 8. Placeholders

| zh-TW | English |
|---|---|
| `輸入問題後按 Enter；也可貼上或拖曳最多 4 張圖片作為上下文` | `Type a question and press Enter; you can also paste or drag up to 4 images as context` |
| `圖片上下文（可透過 Ctrl+V 或拖曳貼上參考圖片）` | `Image context (paste via Ctrl+V or drag reference images)` |
| `圖片上下文（可上傳、貼上、拖曳，或標注目前畫面）` | `Image context (upload, paste, drag, or annotate current screen)` |
| `支援 PNG / JPG / WebP 等圖片，單檔大小上限 10MB` | `Supports PNG / JPG / WebP images, max 10MB per file` |
| `請輸入要附加到系統提示最後面的內容...` | `Enter content to append to the end of the system prompt...` |
| `例如：/help` | `e.g. /help` |
| `例如：我的 Gemini 帳號` | `e.g. My Gemini account` |
| `請輸入您的 Gemini API Key` | `Enter your Gemini API Key` |
| `請輸入要手動新增的模型名稱：` | `Enter the model name to add manually:` |

## 9. Technical Terms — KEEP AS-IS (do NOT translate)

| Term | Category |
|---|---|
| `Gemini`, `OpenAI`, `Azure OpenAI`, `Anthropic`, `DeepSeek`, `OpenRouter`, `Groq`, `Mistral`, `Ollama`, `Ollama Cloud` | AI-Provider |
| `API Key`, `Endpoint`, `Deployment Name`, `API Version` | Technical-Term |
| `Base64`, `AES-256-GCM`, `AES-GCM` | Technical-Term |
| `chrome://extensions/`, `host_permissions` | Technical-Term |
| `Context Window`, `TPM`, `Token per minute` | Technical-Term |
| `PNG`, `JPG`, `WebP` | Technical-Term |
| `CodePen`, `Responses API`, `Chat Completions`, `tool calling` | Technical-Term |
| `User Scripts API`, `Allow User Scripts` | Technical-Term |
| `DOM`, `HTML`, `CSS`, `JSON-LD`, `OpenGraph`, `Twitter Card`, `SEO metadata` | Technical-Term |
| Model IDs: `gemini-2.0-flash`, `gpt-4o-mini`, `gpt-5`, `gpt-5.6`, `gpt-4.1`, `o3`, `claude-opus-4-7`, `deepseek-chat`, `llama3.3`, `mistral`, `gemma-4-26b-a4b-it` | Model-ID |
| Provider type values: `gemini`, `openai`, `azure-openai`, `openai-compatible`, `anthropic`, `deepseek`, `openrouter`, `groq`, `mistral`, `ollama`, `ollama-cloud` | Provider-Type |

## 10. background.js specific

| zh-TW | English |
|---|---|
| `JavaScript 執行失敗：${message}` | `JavaScript execution failed: ${message}` |
| `目前執行環境沒有提供 User Scripts API...` | `The current environment doesn't provide User Scripts API...`（撇號：用雙引號） |
| `目前瀏覽器不支援 User Scripts API，請升級到 Chrome 135 以上版本。` | `Current browser does not support User Scripts API, please upgrade to Chrome 135+.` |
| `run_js 需要在擴充功能詳細資料頁啟用「Allow User Scripts」...` | `run_js requires enabling "Allow User Scripts" on the extension details page...` |
| `已在頁面主世界執行 JavaScript。` | `JavaScript executed in page main world.` |
| `沒有取得 JavaScript 執行結果。` | `No JavaScript execution result obtained.` |
| `無效的 Ollama Cloud Service Worker 請求。` | `Invalid Ollama Cloud Service Worker request.` |
| `不允許的 Ollama Cloud API 端點。` | `Disallowed Ollama Cloud API endpoint.` |
| `Ollama Cloud API Key 不可為空。` | `Ollama Cloud API Key cannot be empty.` |
| `Ollama Cloud 請求內容格式不正確。` | `Ollama Cloud request body format is incorrect.` |
| `每個 Ollama Cloud 連線只能處理一個請求。` | `Each Ollama Cloud connection can only handle one request.` |
| `找不到目前頁籤，無法執行 JavaScript。` | `Cannot find current tab, cannot execute JavaScript.` |
| `code 參數不可為空。` | `code parameter cannot be empty.` |
| `主世界 JavaScript 執行失敗。` | `Main world JavaScript execution failed.` |

## 11. popup.html specific

| zh-TW | English |
|---|---|
| `頁問: 設定已移轉` | `AskPage: Settings migrated` |
| `設定已升級至支援多模型設定，即將為您跳轉至完整設定頁面...` | `Settings upgraded to support multi-model configuration, redirecting to full settings page...` |
| `開啟設定頁面` | `Open Settings Page` |
