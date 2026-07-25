#!/usr/bin/env node
// Translate AskPage UI strings (zh-TW -> en) via Ollama API.
// Usage:
//   node scripts/i18n/translate.mjs --dry-run                 # preview prompts + chunk map
//   node scripts/i18n/translate.mjs --model qwen3.5:397b       # run translation
//   node scripts/i18n/translate.mjs --model deepseek-v4-flash --no-chunk  # whole-file mode
//   node scripts/i18n/translate.mjs --output-mode=i18n         # emit Chrome i18n messages.json (TASK-040)
// Reads:  scripts/i18n/glossary.zh-TW-en.md
//         scripts/i18n/chunks/chunk-map.json (+ chunk-*.mjs)  [chunked mode]
//         manifest.json, popup.html, settings.html, settings.js, content.js, background.js  [whole-file mode]
// Writes (inplace mode): scripts/i18n/out/<file>.en.<ext>      (whole-file mode)
//                        scripts/i18n/chunks/content.js.chunk-N.en.mjs  (chunked mode)
// Writes (i18n mode):    scripts/i18n/out/i18n/<file>.chunk-N.json     (chunked mode)
//                        scripts/i18n/out/i18n/<file>.json            (whole-file mode)
// Per-chunk JSON files are NOT merged automatically; merging into
// _locales/en/messages.json is a manual Phase-6 step (see --merge-i18n note below).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GLOSSARY = join(__dirname, 'glossary.zh-TW-en.md');
const CHUNKS_DIR = join(__dirname, 'chunks');
const OUT_DIR = join(__dirname, 'out');

const args = parseArgs(process.argv.slice(2));
const MODEL = args.model || 'qwen3.5:397b';
// Default base URL changed to the OpenAI-compatible endpoint (per user config, 2026-07-19).
// The translator auto-detects format: URLs ending in /v1 (or containing /v1) use OpenAI-style
// /chat/completions; otherwise Ollama-native /api/chat. Override via --ollama or OLLAMA_URL env.
const OLLAMA_URL = args.ollama || process.env.OLLAMA_URL || 'http://localhost:8317/v1';
const DRY_RUN = !!args['dry-run'];
const NO_CHUNK = !!args['no-chunk'];
const STRICT = args.strict === 'false' ? false : true; // fail-fast on placeholder mismatch (TASK-048); default on
const NUM_CTX = parseInt(args.ctx || '65536', 10);
const OUTPUT_MODE = (args['output-mode'] === 'i18n') ? 'i18n' : 'inplace'; // default inplace (TASK-040)
const I18N_OUT_DIR = join(OUT_DIR, 'i18n');

const SMALL_FILES = ['manifest.json', 'popup.html', 'settings.html', 'settings.js', 'background.js'];

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (key.includes('=')) { const [k, v] = key.split('='); out[k] = v; }
            else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[key] = argv[++i]; }
            else out[key] = 'true';
        }
    }
    return out;
}

const SYSTEM_PROMPT = `You are a professional localization engineer translating a Chrome Extension's UI from Traditional Chinese (zh-TW) to English.

You will receive a source code file (or a chunk of one). You MUST:

1. Translate ONLY zh-TW UI strings to English. Leave all other code (logic, comments, CSS, HTML structure, identifiers) byte-for-byte unchanged.
2. PRESERVE EXACTLY (do not translate, delete, move, or modify):
   - Template-literal placeholders: \${providerLabel}, \${model}, \${stats.stepCount}, \${MAX_INPUT_CONTEXT_IMAGES}, \${error.message}, and every other \${...} occurrence.
   - Slash command tokens: /clear, /summary, /screenshot, /agent. Translate only their description text.
   - Emoji prefixes (📸 ⭕ ✅ ❌ 🤖 💬 💡 🎯 🔄 ➕ 🔍 ✏️ 🗑️ 📤 📥 ⚡ 🟢 🔴 ⏳ 📝 ✨ ⚠️ 🛠️ 📋 📏 🔗 📊).
   - Markdown formatting: **bold**, \`code\`, and \\n newlines inside status messages.
   - AI provider names (Gemini, OpenAI, Azure OpenAI, Anthropic, DeepSeek, OpenRouter, Groq, Mistral, Ollama), model IDs (e.g. gemini-2.0-flash, gpt-5.6, claude-opus-4-7), and technical terms (API Key, Endpoint, Deployment Name, Base64, AES-256-GCM, chrome://extensions/, host_permissions, Context Window, TPM, DOM, HTML, JSON-LD, OpenGraph).
   - HTML tags and attribute names (aria-label, title, data-*); translate only the Chinese value inside attribute strings.
3. APOSTROPHE SAFETY: When an English translation contains an apostrophe (don't, can't, isn't, doesn't, it's) and the original string was wrapped in single quotes '...', you MUST swap the outer quotes to double quotes "...", use a backtick template literal, or escape the apostrophe as \\'. Never break JS syntax.
4. Use the glossary below for terminology consistency.
5. Output the COMPLETE translated file/chunk. Do not truncate. Do not add explanations or markdown fences. Output only the raw translated source code, preserving line structure.

GLOSSARY:
`;

// i18n mode system prompt (TASK-040): instead of producing translated source, the LLM emits
// a Chrome i18n messages.json-shaped object mapping snake_case_key -> {message, description, placeholders?}.
const SYSTEM_PROMPT_I18N = `You are a professional localization engineer extracting Chrome Extension i18n messages from source code whose UI strings are written in Traditional Chinese (zh-TW).

You will receive a source code file or a chunk of one. You MUST:

1. Read the source and extract EVERY zh-TW UI string that needs translation (strings rendered to the user: textContent, innerHTML, alert, prompt, console user messages, title/aria-label attribute values, dialog labels, error messages shown in the UI). Do NOT extract developer-only comments, log prefixes like "[AskPage]", CSS, or non-UI identifiers.
2. Output a single JSON object mapping a snake_case_key to a message descriptor. Each descriptor MUST have a "message" field (the English translation). Include a "description" field with short context (e.g. "settings popup, provider type select label", "content dialog, /clear command description"). For strings containing \${var} template placeholders, declare a "placeholders" block mapping each placeholder name to {"content": "$N"} where N is the 1-based positional index of the placeholder's first appearance in the message. Convert \${stats.stepCount} style to a named placeholder token like \$count\$ in the message text, with {"count": {"content": "$1"}} in placeholders.
3. Key naming: use snake_case, prefixed by file/section. Examples: settings_provider_type, cmd_clear_desc, agent_finished, content_input_placeholder. Keep slash command tokens (/clear, /summary, /screenshot, /agent) as part of the key or description; do NOT translate the token itself.
4. For count/quantity strings, prefer ICU MessageFormat plural syntax: {"message": "{count, plural, one {AskPage finished, executed # step} other {AskPage finished, executed # steps}}", "placeholders": {"count": {"content": "$1"}}}. For non-count template strings use plain \$name\$ placeholders.
5. Use the glossary below for terminology consistency. Preserve emoji prefixes in the "message" value when they appear in the source UI string.
6. Output ONLY the JSON object. No markdown fences, no prose, no trailing comments. The output must parse with JSON.parse.

GLOSSARY:
`;

function buildSystemPrompt() {
    const glossary = readFileSync(GLOSSARY, 'utf8');
    return (OUTPUT_MODE === 'i18n' ? SYSTEM_PROMPT_I18N : SYSTEM_PROMPT) + glossary;
}

function isOpenAICompat(url) {
    // OpenAI-compatible endpoints expose /v1/chat/completions; Ollama-native exposes /api/chat.
    // Treat URLs containing '/v1' (typically a trailing /v1 base) as OpenAI-compatible.
    return /\/v1(\/|$|\?)/.test(url);
}

function chatEndpoint(url) {
    return isOpenAICompat(url)
        ? `${url.replace(/\/$/, '')}/chat/completions`
        : `${url.replace(/\/$/, '')}/api/chat`;
}

async function callOllama(systemPrompt, userContent) {
    const userMsg = OUTPUT_MODE === 'i18n'
        ? `Extract every zh-TW UI string from the following source code and emit the i18n messages.json object per the rules. Output ONLY the JSON object, no markdown fences, no prose.\n\n--- SOURCE ---\n${userContent}`
        : `Translate the following source code per the rules. Output ONLY the translated code, nothing else.\n\n--- SOURCE ---\n${userContent}`;
    const endpoint = chatEndpoint(OLLAMA_URL);
    let body;
    let extractContent;
    if (isOpenAICompat(OLLAMA_URL)) {
        // OpenAI-compatible request/response shape (Ollama also supports this at /v1).
        body = {
            model: MODEL,
            stream: false,
            temperature: 0.3,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg }
            ]
        };
        extractContent = (data) => data.choices?.[0]?.message?.content || '';
    } else {
        // Ollama-native /api/chat shape (supports num_ctx via options).
        body = {
            model: MODEL,
            stream: false,
            options: { temperature: 0.3, num_ctx: NUM_CTX },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg }
            ]
        };
        extractContent = (data) => data.message?.content || '';
    }
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`API ${res.status} at ${endpoint}: ${await res.text()}`);
    }
    const data = await res.json();
    return extractContent(data);
}

function validatePlaceholders(original, translated, label) {
    const extract = (s) => (s.match(/\$\{[^}]+\}/g) || []);
    const o = extract(original);
    const t = extract(translated);
    const oCount = {}; o.forEach((p) => { oCount[p] = (oCount[p] || 0) + 1; });
    const tCount = {}; t.forEach((p) => { tCount[p] = (tCount[p] || 0) + 1; });
    const issues = [];
    for (const [p, c] of Object.entries(oCount)) {
        if ((tCount[p] || 0) !== c) issues.push(`${p}: original ${c} -> translated ${tCount[p] || 0}`);
    }
    if (issues.length) {
        const msg = `Placeholder mismatch in ${label}:\n    ${issues.join('\n    ')}`;
        if (STRICT) {
            throw new Error(`${msg}\n  Refusing to write translation (--strict, TASK-048). Re-run this chunk or disable --strict to override.`);
        }
        console.warn(`  ⚠️  ${msg}`);
    }
    return issues.length === 0;
}

// Parse the LLM's i18n output into a JS object. Strips accidental markdown fences,
// then JSON.parse; throws a clear error if the content is not valid JSON (TASK-040).
function parseI18nJson(raw, label) {
    let text = String(raw).trim();
    // Strip ```json ... ``` or ``` ... ``` fences if the model added them despite the prompt.
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    if (fence) text = fence[1].trim();
    // If there's trailing prose after the JSON object, cut at the last balanced }.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.slice(firstBrace, lastBrace + 1);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`i18n output is not valid JSON for ${label}: ${e.message}\n  Raw output (first 500 chars):\n${String(raw).slice(0, 500)}`);
    }
}

// Best-effort, warn-only: every ${...} placeholder in the source should map to a $name$
// token (or ICU {name,...}) in at least one descriptor's message/placeholders. We do not
// fail on mismatch; this only warns. (validatePlaceholders does NOT apply in i18n mode.)
function checkI18nPlaceholders(original, messages, label) {
    const srcPlaceholders = new Set((original.match(/\$\{([a-zA-Z_][\w.]*)\}/g) || [])
        .map((p) => p.slice(2, -1)));
    if (srcPlaceholders.size === 0) return;
    const declared = new Set();
    for (const desc of Object.values(messages)) {
        const msg = String(desc.message || '');
        for (const m of msg.match(/\$([a-zA-Z_]\w*)\$/g) || []) declared.add(m.slice(1, -1));
        if (desc.placeholders) for (const name of Object.keys(desc.placeholders)) declared.add(name);
    }
    const missing = [...srcPlaceholders].filter((p) => !declared.has(p) && !declared.has(p.split('.').pop()));
    if (missing.length) {
        console.warn(`  ⚠️  i18n placeholder coverage gap in ${label}: source \${${missing.join('}, ${')}} not found as $name$ in output (warn-only)`);
    }
}

async function translateChunked() {
    const map = JSON.parse(readFileSync(join(CHUNKS_DIR, 'chunk-map.json'), 'utf8'));
    const sys = buildSystemPrompt();
    console.log(`Chunked mode: ${map.chunks.length} chunks, model=${MODEL}, ctx=${NUM_CTX}`);
    for (const c of map.chunks) {
        const srcFile = join(CHUNKS_DIR, c.file);
        const original = readFileSync(srcFile, 'utf8');
        const i18nOutFile = join(I18N_OUT_DIR, c.file.replace('.mjs', `.json`));
        const inplaceOutFile = join(CHUNKS_DIR, c.file.replace('.mjs', '.en.mjs'));
        if (DRY_RUN) {
            const target = OUTPUT_MODE === 'i18n' ? i18nOutFile : inplaceOutFile;
            console.log(`  [dry-run] chunk ${c.chunkIndex}: ${c.file} (~${c.tokenEstimate} tokens, lines ${c.startLine}-${c.endLine}) -> ${target}`);
            continue;
        }
        console.log(`  Translating chunk ${c.chunkIndex} (${c.file}, ~${c.tokenEstimate} tokens)...`);
        const result = await callOllama(sys, original);
        if (OUTPUT_MODE === 'i18n') {
            const messages = parseI18nJson(result, c.file);
            checkI18nPlaceholders(original, messages, c.file);
            mkdirSync(I18N_OUT_DIR, { recursive: true });
            writeFileSync(i18nOutFile, JSON.stringify(messages, null, 2) + '\n');
            console.log(`    -> ${i18nOutFile} (${Object.keys(messages).length} keys)`);
        } else {
            validatePlaceholders(original, result, c.file);
            writeFileSync(inplaceOutFile, result);
            console.log(`    -> ${inplaceOutFile}`);
        }
    }
}

async function translateWholeFile(relPath) {
    const src = join(REPO_ROOT, relPath);
    if (!existsSync(src)) { console.warn(`  skip (missing): ${relPath}`); return; }
    const original = readFileSync(src, 'utf8');
    const ext = extname(relPath).slice(1) || 'txt';
    const inplaceOutFile = join(OUT_DIR, `${relPath}.en.${ext}`);
    const baseName = relPath.replace(/[\\/]/g, '.');
    const i18nOutFile = join(I18N_OUT_DIR, `${baseName}.json`);
    if (DRY_RUN) {
        const target = OUTPUT_MODE === 'i18n' ? i18nOutFile : inplaceOutFile;
        console.log(`  [dry-run] ${relPath}: ~${Math.ceil(original.length / 3)} tokens -> ${target}`);
        return;
    }
    console.log(`  Translating ${relPath} (~${Math.ceil(original.length / 3)} tokens)...`);
    const result = await callOllama(buildSystemPrompt(), original);
    if (OUTPUT_MODE === 'i18n') {
        const messages = parseI18nJson(result, relPath);
        checkI18nPlaceholders(original, messages, relPath);
        mkdirSync(I18N_OUT_DIR, { recursive: true });
        writeFileSync(i18nOutFile, JSON.stringify(messages, null, 2) + '\n');
        console.log(`    -> ${i18nOutFile} (${Object.keys(messages).length} keys)`);
    } else {
        validatePlaceholders(original, result, relPath);
        writeFileSync(inplaceOutFile, result);
        console.log(`    -> ${inplaceOutFile}`);
    }
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    if (OUTPUT_MODE === 'i18n') mkdirSync(I18N_OUT_DIR, { recursive: true });
    if (!existsSync(GLOSSARY)) { throw new Error(`Missing glossary: ${GLOSSARY}`); }
    console.log(`AskPage i18n translator | model=${MODEL} | base=${OLLAMA_URL} (${isOpenAICompat(OLLAMA_URL) ? 'OpenAI-compat /v1' : 'Ollama-native /api/chat'}) | dry-run=${DRY_RUN} | no-chunk=${NO_CHUNK} | strict=${STRICT} | output-mode=${OUTPUT_MODE}`);

    if (DRY_RUN) {
        console.log(`\n--- ${OUTPUT_MODE === 'i18n' ? 'I18N' : 'INPLACE'} SYSTEM PROMPT PREVIEW (first 800 chars) ---`);
        console.log(buildSystemPrompt().slice(0, 800) + '\n...');
    }

    if (NO_CHUNK) {
        console.log('Whole-file mode: translating all 6 source files.');
        for (const f of [...SMALL_FILES, 'content.js']) {
            await translateWholeFile(f);
        }
    } else {
        await translateChunked();
        console.log('\nSmall files (whole-file translation):');
        for (const f of SMALL_FILES) {
            await translateWholeFile(f);
        }
    }
    if (DRY_RUN) console.log('\nDry run complete. Re-run without --dry-run to execute translation.');
    else if (OUTPUT_MODE === 'i18n') console.log('\nTranslation complete. Per-chunk JSON written to scripts/i18n/out/i18n/. Merging into _locales/en/messages.json is a manual Phase-6 step.');
    else console.log('\nTranslation complete. Run merge-contentjs.mjs to reassemble content.js.');
}

main().catch((e) => { console.error(e); process.exit(1); });