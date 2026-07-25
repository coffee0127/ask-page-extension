// AskPage runtime locale loader.
//
// chrome.i18n.getMessage() is bound to the browser UI locale and cannot be
// switched at runtime by an extension (switching it requires restarting Chrome
// with a different UI language). To let the settings page switch UI language
// without a restart, this module loads _locales/<locale>/messages.json via
// fetch(chrome.runtime.getURL(...)) and exposes askpageI18n.t() with the same
// $name$ placeholder / $1 substitution semantics as chrome.i18n.getMessage.
//
// Scope: settings page only. content.js (content-script context) and
// background.js (service-worker context) keep using chrome.i18n.getMessage,
// which stays bound to the browser locale - acceptable for the in-page dialog
// since askpageI18n is not loaded there.
//
// On init:
//   1. Read ASKPAGE_LOCALE_PREF from chrome.storage.local. If set, use it.
//   2. Otherwise walk chrome.i18n.getAcceptLanguages() in order and pick the
//      first one that has a _locales/<lang>/messages.json folder. Normalizes
//      zh-TW / zh-Hant / zh-Hant-TW to zh_TW.
//   3. If nothing matches, default to 'en'.
//
// On setLocale(locale):
//   - Persist ASKPAGE_LOCALE_PREF, reload messages, fire onChange callbacks.
//   - The page (i18n-bootstrap + settings.js callers) re-renders via callbacks.

(function () {
    'use strict';

    const STORAGE_KEY = 'ASKPAGE_LOCALE_PREF';
    const AVAILABLE_LOCALES = ['en', 'zh_TW'];

    let currentLocale = null;
    let messages = {};
    const listeners = new Set();

    function normalizeAcceptLanguage(lang) {
        if (!lang) return null;
        const lower = String(lang).toLowerCase();
        // Treat any zh-Hant / zh-TW variant as Traditional Chinese (zh_TW).
        if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hant-tw' ||
            lower.startsWith('zh-tw') || lower.startsWith('zh-hant')) {
            return 'zh_TW';
        }
        // zh-* other variants (zh-CN, zh-Hans, zh) fall back to en here, since
        // we only ship en and zh_TW bundles; en is the safer neutral default.
        if (lower === 'en' || lower.startsWith('en')) {
            return 'en';
        }
        const base = lower.split('-')[0];
        if (base === 'en') return 'en';
        return null;
    }

    function hasBundle(locale) {
        return AVAILABLE_LOCALES.includes(locale);
    }

    // Mirror chrome.i18n.getMessage semantics:
    //   $name$ placeholders map to substitutions by their $N content (ordered).
    //   $$ is an escaped literal $. Returns '' for a missing key.
    function buildMessage(key, substitutions) {
        const entry = messages[key];
        if (!entry) return '';
        let text = entry.message || '';
        if (text.indexOf('$') === -1) return text;

        const placeholders = entry.placeholders || {};
        const ordered = Object.entries(placeholders)
            .map(([name, meta]) => {
                const m = /^\$(\d+)$/.exec(meta.content || '');
                return { name, index: m ? Number(m[1]) - 1 : -1 };
            })
            .filter((p) => p.index >= 0)
            .sort((a, b) => a.index - b.index);

        const subs = Array.isArray(substitutions)
            ? substitutions
            : (substitutions != null ? [substitutions] : []);

        if (ordered.length && subs.length) {
            ordered.forEach((p) => {
                const value = subs[p.index] != null ? String(subs[p.index]) : '';
                // Use a replacement function so $&, $$, $`, $' in the value are
                // treated as plain text, not String.replace special patterns.
                text = text.replace(
                    new RegExp(`\\$${p.name}\\$`, 'gi'),
                    () => value
                );
            });
        }
        // $$ is an escaped literal $ in Chrome i18n; apply after placeholders.
        text = text.replace(/\$\$/g, '$');
        return text;
    }

    function t(key, substitutions) {
        if (!key) return '';
        try {
            const msg = buildMessage(key, substitutions);
            if (msg) return msg;
        } catch (e) {
            console.warn('[AskPage] askpageI18n.t error for key', key, e);
        }
        // Fallback to chrome.i18n.getMessage so the page still renders in the
        // browser locale when the in-memory bundle is missing the key.
        if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
            try {
                return chrome.i18n.getMessage(key, substitutions) || '';
            } catch (e) {
                return '';
            }
        }
        return '';
    }

    function getLocale() {
        return currentLocale || (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage
            ? chrome.i18n.getUILanguage()
            : 'en');
    }

    function onChange(cb) {
        if (typeof cb === 'function') listeners.add(cb);
        return () => listeners.delete(cb);
    }

    function fireChange() {
        listeners.forEach((cb) => {
            try { cb(currentLocale); } catch (e) { console.warn('[AskPage] i18n onChange cb error', e); }
        });
    }

    async function loadMessagesFor(locale) {
        if (!hasBundle(locale)) {
            console.warn('[AskPage] askpageI18n: no bundle for locale', locale, '- using', AVAILABLE_LOCALES[0]);
            locale = AVAILABLE_LOCALES[0];
        }
        const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`fetch ${url} -> ${res.status}`);
        }
        return await res.json();
    }

    async function applyLocale(locale, { persist = false } = {}) {
        const next = hasBundle(locale) ? locale : AVAILABLE_LOCALES[0];
        try {
            const loaded = await loadMessagesFor(next);
            messages = loaded || {};
            currentLocale = next;
            if (persist) {
                await new Promise((resolve) => {
                    const obj = {};
                    obj[STORAGE_KEY] = next;
                    chrome.storage.local.set(obj, resolve);
                });
            }
            fireChange();
        } catch (e) {
            console.warn('[AskPage] askpageI18n: failed to load messages for', next, e, '- falling back to chrome.i18n');
            currentLocale = next;
            messages = {};
        }
    }

    async function pickDefaultLocale() {
        const pref = await new Promise((resolve) => {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
                resolve(result && result[STORAGE_KEY]);
            });
        });
        if (pref && hasBundle(pref)) return pref;

        let accept = [];
        try {
            accept = await new Promise((resolve) => {
                chrome.i18n.getAcceptLanguages((langs) => resolve(Array.isArray(langs) ? langs : []));
            });
        } catch (e) {
            accept = [];
        }
        for (const lang of accept) {
            const norm = normalizeAcceptLanguage(lang);
            if (norm && hasBundle(norm)) return norm;
        }
        return AVAILABLE_LOCALES[0];
    }

    async function init() {
        try {
            const locale = await pickDefaultLocale();
            await applyLocale(locale, { persist: false });
        } finally {
            // Resolve the ready promise regardless of success/failure so
            // awaiters do not hang; t() falls back to chrome.i18n.getMessage
            // if the bundle failed to load.
            resolveReady();
        }
    }

    async function setLocale(locale) {
        await applyLocale(locale, { persist: true });
    }

    // A promise that resolves once the initial locale + messages have
    // loaded (or the load failed). Lets content.js wait for the bundle
    // before rendering UI strings so the first paint uses the preferred
    // locale instead of the browser-locale fallback.
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    // Propagate settings-page locale changes to already-open tabs.
    // setLocale() only persists in the settings-page context; other contexts
    // (content scripts) must observe storage.onChanged to re-apply the new
    // locale and fire onChange so open dialogs / bootstrap re-render.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            const change = changes[STORAGE_KEY];
            if (!change) return;
            const next = change.newValue;
            if (typeof next !== 'string' || !hasBundle(next)) return;
            void applyLocale(next, { persist: false });
        });
    }

    const api = {
        t,
        getLocale,
        setLocale,
        onChange,
        ready,
        getAvailableLocales() { return AVAILABLE_LOCALES.slice(); },
        // Exposed for tests / inspection; not part of the public contract.
        _getMessages() { return messages; },
        _init: init
    };

    // Kick off init when chrome APIs are available. In the Node test sandbox
    // (no chrome.runtime.getURL / fetch), init fails gracefully and t() falls
    // back to chrome.i18n.getMessage provided by the test stub.
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function' && typeof fetch === 'function') {
        init();
    } else {
        currentLocale = 'en';
        resolveReady();
    }

    window.askpageI18n = api;
})();