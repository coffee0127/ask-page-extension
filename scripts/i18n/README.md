# AskPage i18n Toolkit — zh-TW → English Translation

Translate the hardcoded Traditional Chinese UI strings in this Chrome Extension to English using an Ollama LLM, then load them into Chrome's native `chrome.i18n + _locales` framework (v1.1, per `plan/refactor-i18n-zh-TW-to-en-1.md` Phase 6 & 8).

> **v1.1 change**: The toolkit now targets Chrome's native i18n framework as the final carrier (`_locales/en/messages.json` + `_locales/zh_TW/messages.json` + `chrome.i18n.getMessage()`), instead of in-place string replacement. The glossary/chunker/translate/merge scripts remain as the translation-production engine; Phase 6 (TASK-038..047) wraps the output into `_locales`. This supports future locale additions as pure data-file drops and preserves zh-TW for existing users via browser-locale fallback. Phase 8 (TASK-052..060) fixed the `default_locale` to `en`, rewrote the chunker to use AST top-level boundaries, and wired `validate:i18n` into the build.

## Files

```
scripts/i18n/
├── glossary.zh-TW-en.md        # Bilingual glossary + 15 preservation rules (fed to the model)
├── chunk-contentjs.mjs         # Splits content.js (362KB) into ~50K-token chunks at function boundaries
├── translate.mjs               # Calls Ollama API to translate each chunk / small file (supports --output-mode=i18n)
├── merge-contentjs.mjs         # Reassembles translated chunks back into content.js (backs up original)
├── validate-messages.mjs       # (Phase 6) Verifies _locales messages.json covers all getMessage keys
├── validate-syntax.mjs         # (Phase 7) node --check AST syntax validation on translated chunks
├── chunks/                     # chunk-contentjs.mjs output: chunk-*.mjs + chunk-map.json
└── out/                        # translate.mjs output for small files (whole-file mode)
_locales/                       # (Phase 6) Chrome i18n message bundles
├── en/messages.json            # English (default_locale)
└── zh_TW/messages.json         # Traditional Chinese (extracted from original source)
```

## Prerequisites

- Node.js ≥18
- Ollama (or any OpenAI-compatible server) reachable at `http://localhost:8317/v1` (default; override via `--ollama` or `OLLAMA_URL` env) with one of:
  - `qwen3.5:397b` (recommended, 256K context, strong zh↔en + code)
  - `deepseek-v4-flash` (1M context, can do whole-file mode)
  - `gemma4:31b` (local workstation, 256K context)
  - The translator auto-detects endpoint format: URLs containing `/v1` use OpenAI-compatible `/chat/completions`; otherwise Ollama-native `/api/chat`.

## Workflow

```bash
# 1. Chunk content.js into AST-boundary blocks (reconstruction + node --check verified)
node scripts/i18n/chunk-contentjs.mjs

# 2. Preview the translation plan without calling the API
node scripts/i18n/translate.mjs --dry-run

# 3. Translate (chunked mode, default model qwen3.5:397b)
#    Phase 6 i18n mode: produces _locales/*/messages.json instead of in-place replacement
node scripts/i18n/translate.mjs --output-mode=i18n
#   or in-place mode (legacy, ALT-005):
node scripts/i18n/translate.mjs
#   or pick a model:
node scripts/i18n/translate.mjs --output-mode=i18n --model deepseek-v4-flash

#   whole-file mode (for 1M-context models; skips chunking):
node scripts/i18n/translate.mjs --model deepseek-v4-flash --no-chunk

# 4. (Phase 6 i18n mode) Wire up chrome.i18n:
#    - add "default_locale": "en" to manifest.json
#    - replace name/description with __MSG_extName__ / __MSG_extDescription__
#    - replace hardcoded strings in content.js/settings.js/background.js with chrome.i18n.getMessage('key')
#    - add data-i18n attributes in settings.html/popup.html + bootstrap script
#    - extract original zh-TW into _locales/zh_TW/messages.json (preserves existing users)
#    (legacy in-place mode): merge translated chunks back into content.js
node scripts/i18n/merge-contentjs.mjs

# 5. Flip the LLM system prompt language:
#    Run: rg -n "provide responses in zh-tw" content.js   # confirm actual line (v1.0 said 2689, actual ~2728)
#    Change '...provide responses in zh-tw...' -> '...provide responses in en...'

# 6. Validate (Phase 6/7/8)
node scripts/i18n/validate-messages.mjs   # _locales covers all getMessage keys (default_locale=en)
node scripts/i18n/validate-messages.mjs --locale=zh_TW   # also validate the zh_TW bundle
node scripts/i18n/validate-syntax.mjs     # node --check AST on translated chunks

# 7. Lint + load in Chrome + scan for residual Chinese
npm run lint
rg -n '[\x{4e00}-\x{9fff}]' manifest.json popup.html settings.html settings.js content.js background.js
# Expected residual: only boolean arrays (是/需要/勾選/否/不要/取消 — kept intentionally)
#    Re-locate with: rg -n "'是'|'需要'|'勾選'" content.js   # v1.0 said 6068/6072, now stale

# 8. (Phase 6) Test locale switching: macOS system language → Traditional Chinese → restart Chrome
#    → UI shows Chinese; switch → English → UI shows English (verifies _locales fallback zh_TW→en)

# 9. (Phase 6) Chrome Web Store listing localization: via Developer Dashboard
#    "Add a new language" UI (independent of _locales — store page is dashboard-driven)
```

## Safety guarantees

- **chunk-contentjs.mjs** splits at top-level AST node boundaries (parsed with acorn); no chunk splits a function body or a template literal. Every chunk is validated with `node --check`, and chunks reassemble byte-for-byte to the original `content.js` before finishing. A single top-level node larger than `HARD_MAX_TOKENS` (e.g. the large `createDialog` function) is kept intact rather than split into un-parseable fragments; the script warns when this happens.
- **merge-contentjs.mjs** backs up the original to `content.js.zh-TW.bak` before overwriting.
- **translate.mjs** compares `${...}` placeholder counts between original and translated; Phase 7 makes this fail-fast (refuses to write on mismatch).
- **validate-syntax.mjs** (Phase 7) runs `node --check` AST validation to catch apostrophe/quote/template-literal damage.
- **validate-messages.mjs** (Phase 6) ensures `_locales/en/messages.json` covers every `getMessage` key (missing keys return empty string → silent blank UI).

## Critical manual steps after translation

1. **System prompt flip**: run `rg -n "provide responses in zh-tw" content.js` to confirm the line (v1.0 said `2689`, actual is ~`2728`), then change `zh-tw` → `en`.
2. **Completion-trace sync**: `isCompletionTraceMessage()` at `content.js:532-535` must match the translated strings at `content.js:5288-5289` (v1.0 said `5248-5249`, now stale). Confirm with `rg -n "頁問已經打完收工" content.js`.
3. **Apostrophe safety**: run `rg -n "don't|can't|won't|isn't|doesn't|it's" content.js settings.js background.js` and ensure every hit lives inside double-quoted or backtick strings (not single-quoted). Phase 7 automates this via `validate-syntax.mjs`.
4. **Line numbers are stale**: v1.0 plan/glossary cited several line numbers that have drifted (2689→2728, 5248-5249→5288-5289, 6068/6072→unrelated). Always re-locate with `rg` before editing (REQ-013).
5. **(Phase 6) Store listing**: localize via Developer Dashboard, not `_locales` — `_locales` only affects in-browser manifest display.

See `plan/refactor-i18n-zh-TW-to-en-1.md` for the full implementation plan (v1.1, Phases 1-8).