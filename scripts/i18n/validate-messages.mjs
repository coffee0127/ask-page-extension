#!/usr/bin/env node
// Build-time validator for Chrome i18n message bundles (TASK-047).
//
// Ensures the default_locale bundle (_locales/<locale>/messages.json) covers every
// chrome.i18n.getMessage('KEY') / __MSG_KEY__ / data-i18n="KEY" reference in source.
// A missing key makes getMessage return "" and silently blanks the UI.
//
// Usage:
//   node scripts/i18n/validate-messages.mjs            # uses manifest default_locale
//   node scripts/i18n/validate-messages.mjs --locale=en
//
// Exit code: 0 if no missing-key errors (warnings OK), 1 if any missing key.
//
// No dependencies. Node >= 18 (uses node:fs/promises, String.prototype.matchAll).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const args = parseArgs(process.argv.slice(2));

// ---------- args ----------
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--locale') {
            out.locale = argv[++i];
        } else if (a.startsWith('--locale=')) {
            out.locale = a.slice('--locale='.length);
        } else if (a === '--help' || a === '-h') {
            out.help = true;
        }
    }
    return out;
}

if (args.help) {
    console.log('Usage: node scripts/i18n/validate-messages.mjs [--locale=<locale>]');
    process.exit(0);
}

// ---------- helpers ----------

function readText(filePath) {
    try {
        return readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

// Get the manifest default_locale (Chrome default is "en" when omitted).
function getDefaultLocale() {
    const manifestPath = join(REPO_ROOT, 'manifest.json');
    const raw = readText(manifestPath);
    if (raw === null) {
        throw new Error(`manifest.json not found at ${manifestPath}`);
    }
    const manifest = JSON.parse(raw);
    return manifest.default_locale || 'en';
}

// Load the message bundle for a locale. Returns Map<key, rawEntry> or throws a
// friendly error when the bundle is absent.
function loadMessages(locale) {
    const bundlePath = join(REPO_ROOT, '_locales', locale, 'messages.json');
    const raw = readText(bundlePath);
    if (raw === null) {
        console.error(
            `[validate-messages] _locales/${locale}/messages.json not found — ` +
            'run Phase 6 TASK-039 first.'
        );
        process.exit(1);
    }
    let json;
    try {
        json = JSON.parse(raw);
    } catch (e) {
        console.error(`[validate-messages] _locales/${locale}/messages.json is not valid JSON: ${e.message}`);
        process.exit(1);
    }
    const map = new Map();
    for (const [key, value] of Object.entries(json)) {
        map.set(key, value);
    }
    return map;
}

// Collect (key, file:line) references across source files.
//
// Reference forms in scope:
//   chrome.i18n.getMessage('KEY') / ("KEY") / (`KEY`)            — JS files
//   __MSG_KEY__                                                  — manifest.json, .css, .html
//   data-i18n="KEY" / data-i18n-placeholder="KEY"                — .html files
//
// NOT in scope: bare getMessage(...) and i18n.getMessage(...) without the chrome. prefix.
// Predefined `@@`-prefixed messages (e.g. __MSG_@@extension_id__) are built-in and excluded.
function collectReferences() {
    const refs = new Map(); // key -> [{file, line}]

    const addRef = (key, file, line) => {
        if (!key) return;
        if (key.startsWith('@@')) return; // built-in predefined messages
        if (!refs.has(key)) refs.set(key, []);
        refs.get(key).push({ file, line });
    };

    const perLineScan = (text, relPath, pattern) => {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const m of lines[i].matchAll(pattern)) {
                addRef(m[1], relPath, i + 1);
            }
        }
    };

    // chrome.i18n.getMessage with quoted or backtick key; optional substitutions arg.
    // Captures the first string key only.
    const getMessageRe =
        /chrome\.i18n\.getMessage\(\s*(?:'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`)/g;
    // askpageI18n.t(...) / bare t(...) alias used in settings.js after the
    // runtime locale-switcher migration. Same key forms as getMessageRe.
    // Bare `t(` is only scanned in settings.js (where `t` is the local alias);
    // askpageI18n.t is scanned everywhere so i18n-bootstrap.js references count.
    const askpageTRe = /askpageI18n\.t\(\s*(?:'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`)/g;
    const bareTRe = /\bt\(\s*(?:'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`)/g;
    // __MSG_KEY__ (also matches __MSG_@@...__, filtered by addRef).
    const msgTokenRe = /__MSG_([^_\s][A-Za-z0-9_@]*?)__/g;
    // data-i18n="KEY" / data-i18n-placeholder="KEY" / data-i18n-html="KEY" /
    // data-i18n-title="KEY" / data-i18n-aria-label="KEY" (single or double quotes).
    // data-i18n-substitutions holds a JSON array of substitution strings, NOT a key.
    const dataI18nRe = /data-i18n(?:-(?:placeholder|html|title|aria-label))?\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)')/g;

    const jsFiles = ['content.js', 'settings.js', 'background.js'];
    const htmlFiles = ['settings.html', 'popup.html'];
    const manifestPath = 'manifest.json';
    const cssPath = 'style.css';

    for (const rel of jsFiles) {
        const text = readText(join(REPO_ROOT, rel));
        if (text === null) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const m of lines[i].matchAll(getMessageRe)) {
                const key = m[1] ?? m[2] ?? m[3];
                addRef(key, rel, i + 1);
            }
            // askpageI18n.t('KEY') - applies to all JS files.
            for (const m of lines[i].matchAll(askpageTRe)) {
                const key = m[1] ?? m[2] ?? m[3];
                addRef(key, rel, i + 1);
            }
            // Bare t('KEY') alias - only settings.js and content.js define `t`
            // as the i18n alias, so only scan it there to avoid false positives
            // from other uses of a single-letter `t` variable in other files.
            if (rel === 'settings.js' || rel === 'content.js') {
                for (const m of lines[i].matchAll(bareTRe)) {
                    const key = m[1] ?? m[2] ?? m[3];
                    addRef(key, rel, i + 1);
                }
            }
        }
    }

    for (const rel of htmlFiles) {
        const text = readText(join(REPO_ROOT, rel));
        if (text === null) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const m of lines[i].matchAll(dataI18nRe)) {
                const key = m[1] ?? m[2];
                addRef(key, rel, i + 1);
            }
            // HTML may also carry __MSG_KEY__ (Chrome auto-substitutes in extension pages).
            for (const m of lines[i].matchAll(msgTokenRe)) {
                addRef(m[1], rel, i + 1);
            }
        }
    }

    // manifest.json: __MSG_KEY__ references only (getMessage does not apply).
    {
        const text = readText(join(REPO_ROOT, manifestPath));
        if (text !== null) perLineScan(text, manifestPath, msgTokenRe);
    }

    // style.css (optional): __MSG_KEY__ references.
    {
        const text = readText(join(REPO_ROOT, cssPath));
        if (text !== null) perLineScan(text, cssPath, msgTokenRe);
    }

    return refs;
}

// ---------- main ----------

function main() {
    const locale = args.locale || getDefaultLocale();
    console.log(`[validate-messages] Validating _locales/${locale}/messages.json`);

    const messages = loadMessages(locale);
    const refs = collectReferences();

    const referencedKeys = new Set(refs.keys());
    const definedKeys = new Set(messages.keys());

    // Exclude @@-prefixed predefined messages from the "defined" side too so they
    // never surface as unused-key warnings.
    for (const k of [...definedKeys]) {
        if (k.startsWith('@@')) definedKeys.delete(k);
    }

    const missing = [...referencedKeys]
        .filter((k) => !definedKeys.has(k))
        .sort();
    const unused = [...definedKeys]
        .filter((k) => !referencedKeys.has(k))
        .sort();

    let exitCode = 0;

    if (missing.length > 0) {
        console.error(`\n[validate-messages] ERROR: ${missing.length} referenced key(s) missing from _locales/${locale}/messages.json:`);
        for (const k of missing) {
            const locs = refs.get(k) || [];
            const locStr = locs.map((l) => `${l.file}:${l.line}`).join(', ');
            console.error(`  ✗ ${k}  ←  ${locStr}`);
        }
        exitCode = 1;
    } else {
        console.log(`\n[validate-messages] OK: all ${referencedKeys.size} referenced key(s) present in bundle.`);
    }

    if (unused.length > 0) {
        console.warn(`\n[validate-messages] WARNING: ${unused.length} defined key(s) never referenced (dead keys):`);
        for (const k of unused) {
            console.warn(`  · ${k}`);
        }
    } else {
        console.log(`[validate-messages] OK: no unused keys (${definedKeys.size} defined).`);
    }

    console.log(`\n[validate-messages] Summary: referenced=${referencedKeys.size} defined=${definedKeys.size} missing=${missing.length} unused=${unused.length}`);
    process.exit(exitCode);
}

main();