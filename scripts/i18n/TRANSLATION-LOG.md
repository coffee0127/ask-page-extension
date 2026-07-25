# AskPage i18n Translation Log

> Generated: 2026-07-19
> Plan: `plan/refactor-i18n-zh-TW-to-en-1.md` (v1.1, Phase 6 & 8)
> Approach: Chrome native `chrome.i18n + _locales` framework (Path B per research report `plan/i18n/research/chrome-extension-i18n-best-practice.md`)

## 1. Approach

The extension adopted Chrome's native i18n framework rather than in-place string replacement. Translation output is carried by `_locales/en/messages.json` (default_locale) and `_locales/zh_TW/messages.json` (preserves existing Traditional Chinese users via browser-locale fallback `zh_TW → en`). JS source uses `chrome.i18n.getMessage('key')`; HTML uses `data-i18n`/`data-i18n-placeholder`/`data-i18n-title`/`data-i18n-aria-label`/`data-i18n-html` attributes applied by `lib/i18n-bootstrap.js`; `manifest.json` and `style.css` use `__MSG_*__` (Chrome auto-substitutes these two file types only).

## 2. Per-file stats

| File | Mechanism | Count | Notes |
|---|---|---|---|
| `_locales/en/messages.json` | 529 keys | — | default_locale bundle |
| `_locales/zh_TW/messages.json` | 529 keys | — | mirrors en key set |
| `content.js` | `askpageI18n.t` (runtime) / `chrome.i18n.getMessage` (fallback) | 371 calls | largest source; 402 zh-TW lines refactored |
| `settings.js` | `askpageI18n.t` (runtime) / `chrome.i18n.getMessage` (fallback) | 100 calls | includes footer_text dynamic render; built-in commands generated per render |
| `background.js` | `chrome.i18n.getMessage` | 18 calls | MAIN-world embedded strings kept hardcoded (chrome.i18n unavailable in page main world) |
| `popup.html` | `data-i18n` | 4 attrs | title, h1, p, button |
| `settings.html` | `data-i18n*` | 91 attrs | labels, buttons, placeholders, hints; footer + 2 modal hints use `data-i18n-html` with substitutions |
| `manifest.json` | `__MSG_*__` | 5 refs | ext_name, ext_description, ext_short_name, cmd_toggle_dialog, cmd_switch_provider; `default_locale: "en"` |
| `style.css` | `__MSG_*__` | 3 refs | code_expand, code_collapse, code_streaming_status (`content:` pseudo-elements) |
| `lib/i18n.js` | runtime loader | — | loads `_locales/<locale>/messages.json` via fetch; honors `ASKPAGE_LOCALE_PREF`; subscribes to `chrome.storage.onChanged` so already-open tabs follow settings changes |
| `lib/i18n-bootstrap.js` | bootstrap | — | DOMContentLoaded; applies data-i18n*; sets `document.documentElement.lang` from `getUILanguage()`; supports `data-i18n-html` + `data-i18n-substitutions` for messages with embedded HTML (links) |

## 3. Model used

No LLM translation API was called. The bilingual glossary `scripts/i18n/glossary.zh-TW-en.md` (140+ entries, user-edited) provided the authoritative zh-TW → English term mapping. One-off strings were translated by the implementing agents. The `scripts/i18n/translate.mjs` toolkit (Ollama/OpenAI-compatible API, `--output-mode=i18n`) remains available for future locale additions but was not required for this en + zh_TW pass.

## 4. Known untranslated / intentionally hardcoded items

| Item | Location | Reason |
|---|---|---|
| Boolean array values `是`/`需要`/`勾選`/`否`/`不要`/`取消` | content.js `coerceBooleanValue` (~lines 6064/6068) | Backward compat: parsed as boolean true/false from LLM tool-call args; English `true`/`false` already in the array (GUD-003) |
| Completion-trace detection markers `頁問已經打完收工`/`頁問提早收工` | content.js `isCompletionTraceMessage` (~533-534) | REQ-007: detection uses literal `includes()`. English equivalents (`AskPage finished`/`AskPage stopped early`) added alongside so detection works in both locales. Output strings use `getMessage('agent_finished'/'agent_stopped_early')`. |
| Other detection markers (`回傳內容為空`, `將在...後重試`, `已取得最終回覆，正在整理答案`) | content.js ~5064-5076 | Same REQ-007 pattern: bilingual literal detection |
| MAIN-world embedded strings | background.js ~364-382 | `chrome.i18n` unavailable in page main world; strings execute in page context |
| `console.error` dev logs (`截圖失敗`, `複製失敗`) | content.js ~1247/2374 | Developer-facing, not user-visible UI |
| `summaryHtml` trace verbs (`正在執行`, `已回傳`) | content.js ~5086/5101 | HTML render path with embedded `<span class="askpage-tool-name">`; the text-only variants are localized. (Could be wired via data-i18n-html if desired.) |
| `編輯`/`刪除` button labels | settings.js ~683/687 | Combined emoji+text structure (`<span class="icon">✏️</span>` + text); restructuring would change CSS. Acceptable. |
| Footer credit `Will 保哥的技術交流中心` | settings.js footer render | Per user edit (2026-07-19): kept in Chinese in BOTH en and zh_TW locales under key `footer_credit`. |
| Source code comments (zh-TW) | all files | Comments are not UI strings; left as-is |

## 5. ICU plural caveat (REQ-012)

The plan's REQ-012 called for ICU MessageFormat plurals (`{count, plural, one {# step} other {# steps}}`) to fix "executed 1 steps" grammar. Research claimed Chrome 84+ supports ICU in `getMessage`, but verification showed `chrome.i18n.getMessage` only performs `$name$` substitution — it does NOT parse ICU MessageFormat. The `agent_finished`/`agent_stopped_early` keys were therefore written as plain `$count$ steps, $duration$` (no plural agreement). Consequence: English shows "executed 1 steps" (grammatically off for count=1) but functional. To properly support plurals, either (a) add FormatJS `intl-messageformat` (~13KB) and compile ICU templates in JS, or (b) branch in JS with separate `agent_finished_one`/`agent_finished_other` keys. Neither is in this pass. Tracked as a known limitation.

## 6. Validation results

| Check | Result |
|---|---|
| `node --check` on content.js/settings.js/background.js/popup.js | PASS |
| `npm run lint` (ESLint webextensions) | PASS (exit 0) |
| `npm test` (render-markdown-code-fence, ollama-cloud-provider) | PASS (both ok, with chrome.i18n.getMessage stub added to test sandboxes) |
| `node scripts/i18n/validate-messages.mjs` | missing=0, referenced=519, defined=529, unused=10 (all intentional) |
| `node scripts/i18n/validate-messages.mjs --locale=zh_TW` | missing=0, referenced=519, defined=529, unused=10 |
| `node tests/i18n-loader.test.js` | PASS (locale selection, pref override, storage.onChanged propagation, $& substitution, missing-key fallback) |
| `validate-syntax.mjs` | No translated chunks (i18n mode used glossary directly, not translate.mjs chunks) — N/A |
| Residual Chinese scan | Only intentional items (detection markers, boolean arrays, comments, main-world strings, dev logs, footer credit, HTML fallback text inside data-i18n elements) |

## 7. Chrome Web Store listing localization (TASK-046)

The Chrome Web Store listing (title, short description, detailed description, screenshots, promotional tiles shown on the store page) is localized **independently** of `_locales`. The `_locales` files only affect in-browser manifest display (toolbar tooltip, `chrome://extensions` name, command descriptions). To localize the Store listing:

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard).
2. Select the AskPage item → **Store Listing** tab.
3. Click **Add a new language** and choose the target language (e.g. English (United States), Chinese (Traditional)).
4. For each language, provide:
   - **Listing name** (the store title — e.g. "AskPage" / "頁問 AskPage")
   - **Summary** (short description, ≤132 chars)
   - **Detailed description** (the long description)
   - **Screenshots** (localized screenshots optional)
   - **Promotional images** (small/large/marquee tiles, optional)
5. Save and submit for review. The store page will then show the matching language based on the viewer's browser locale.

Note: The manifest `name`/`description` (`__MSG_ext_name__`/`__MSG_ext_description__`) do NOT populate the store listing — they only set the in-browser display. The store listing fields are entered manually per language in the Dashboard.

## 8. Future locale additions

Adding a new locale (e.g. `ja`, `es`) is a pure data-file drop: create `_locales/<code>/messages.json` with the same 526 keys. Chrome's fallback chain (`<user_locale> → <lang-only> → default_locale`) handles partial translations automatically (missing keys fall back to `en`). No code changes required. Use `scripts/i18n/translate.mjs --output-mode=i18n` with an Ollama/OpenAI-compatible model to bootstrap a new locale from the zh-TW source strings, then review.

## 9. Files touched in this pass

- `_locales/en/messages.json` (created)
- `_locales/zh_TW/messages.json` (created)
- `manifest.json` (`default_locale: "en"`, `__MSG_*__`, `short_name`; locale bundles added to `web_accessible_resources` so content scripts can fetch them)
- `style.css` (3 `__MSG_*__` in `content:` pseudo-elements)
- `content.js` (371 `t()` calls via askpageI18n with chrome.i18n.getMessage fallback; completion-trace bilingual detection; system prompt dynamically set to the user's preferred response language resolved from ASKPAGE_LOCALE_PREF / browser accept-languages, kept in sync with askpageI18n.getLocale() via chrome.storage.onChanged; onChange re-renders the open dialog after a settings-page locale switch; boolean arrays preserved)
- `settings.js` (100 `t()` calls via askpageI18n with fallback; footer_text dynamic render; built-in commands generated per render via getBuiltInCommands() so descriptions follow locale switches; custom summary prompt merged per render)
- `background.js` (18 getMessage calls; MAIN-world strings kept hardcoded)
- `popup.html` (4 data-i18n attrs + bootstrap script tag)
- `settings.html` (91 data-i18n* attrs + bootstrap script tag; footer + 2 modal hints use data-i18n-html)
- `lib/i18n.js` (runtime locale loader; chrome.storage.onChanged listener; replacement-function placeholders so $&/$$ in values are plain text; `ready` promise)
- `lib/i18n-bootstrap.js` (created; DOMContentLoaded; data-i18n* incl. data-i18n-html with substitutions)
- `scripts/i18n/validate-messages.mjs` (regex extended for data-i18n-html/title/aria-label; `--locale` flag)
- `scripts/i18n/chunk-contentjs.mjs` (rewritten: AST top-level boundaries via acorn, node --check per chunk; replaces the backtick-parity heuristic)
- `scripts/i18n/validate-syntax.mjs` (validates `out/` whole-file output even when no translated chunks exist)
- `tests/i18n-loader.test.js` (created; exercises the runtime locale loader)
- `package.json` (`validate:i18n` script; `build` chains lint + test + validate:i18n; `package` includes `_locales`)
- `.github/workflows/{release,manual-build,quality-check}.yml` (zip includes `_locales`; file-integrity checks verify both messages.json; release zip verifies locale bundles present)