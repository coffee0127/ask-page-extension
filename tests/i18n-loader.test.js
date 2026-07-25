'use strict';

// Tests for the runtime locale loader (lib/i18n.js).
//
// The loader attaches window.askpageI18n to the sandbox global and reads
// _locales/<locale>/messages.json via fetch(chrome.runtime.getURL(...)).
// These tests stub the chrome.* and fetch APIs so the loader runs in a Node
// VM without a browser.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const i18nSrc = fs.readFileSync(path.join(rootDir, 'lib', 'i18n.js'), 'utf8');
const enMessages = JSON.parse(fs.readFileSync(path.join(rootDir, '_locales', 'en', 'messages.json'), 'utf8'));
const zhMessages = JSON.parse(fs.readFileSync(path.join(rootDir, '_locales', 'zh_TW', 'messages.json'), 'utf8'));

function createSandbox({ storedLocale, acceptLanguages }) {
    const bundles = { en: enMessages, zh_TW: zhMessages };
    const storage = {};
    let listeners = [];
    let nextListenerId = 1;

    if (storedLocale) storage.ASKPAGE_LOCALE_PREF = storedLocale;

    const sandbox = {
        console,
        fetch(url) {
            // url is chrome.runtime.getURL('_locales/<locale>/messages.json')
            // which returns the path prefixed with 'ext://'.
            const match = /_locales\/([^/]+)\/messages\.json/.exec(url);
            if (!match) {
                return Promise.resolve({ ok: false, status: 404 });
            }
            const locale = match[1];
            if (!bundles[locale]) {
                return Promise.resolve({ ok: false, status: 404 });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(bundles[locale])
            });
        },
        chrome: {
            runtime: {
                getURL(resourcePath) {
                    return 'ext://' + resourcePath;
                }
            },
            i18n: {
                getAcceptLanguages(cb) {
                    cb(acceptLanguages || []);
                },
                getUILanguage() {
                    return 'en-US';
                },
                getMessage(key) {
                    // Used only as a fallback; return a sentinel so we can
                    // detect when the loader fell back instead of using the bundle.
                    return 'FALLBACK:' + key;
                }
            },
            storage: {
                local: {
                    get(keys, cb) {
                        const list = Array.isArray(keys) ? keys : [keys];
                        const result = {};
                        for (const k of list) {
                            if (k in storage) result[k] = storage[k];
                        }
                        cb(result);
                    },
                    set(obj, cb) {
                        Object.assign(storage, obj);
                        // Fire storage.onChanged listeners for the changed keys.
                        for (const [k, v] of Object.entries(obj)) {
                            for (const l of listeners) {
                                const changes = {};
                                changes[k] = { oldValue: null, newValue: v };
                                l.fn(changes, 'local');
                            }
                        }
                        if (cb) cb();
                    }
                },
                onChanged: {
                    addListener(l) {
                        listeners.push({ id: nextListenerId++, fn: l });
                    }
                }
            }
        },
        window: {}
    };
    sandbox.globalThis = sandbox;

    return { sandbox, getStorage: () => storage, getListeners: () => listeners };
}

async function runLoader(sandbox) {
    vm.createContext(sandbox);
    vm.runInContext(i18nSrc, sandbox, { filename: 'lib/i18n.js' });
    // Wait for the async init() to complete.
    await sandbox.window.askpageI18n.ready;
    return sandbox.window.askpageI18n;
}

(async function main() {
    // 1. Initial selection with a stored preference overrides browser languages.
    {
        const { sandbox } = createSandbox({ storedLocale: 'zh_TW', acceptLanguages: ['en-US'] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.getLocale(), 'zh_TW', 'stored pref zh_TW wins over en browser');
        assert.strictEqual(api.t('content_brand_name'), '頁問', 'zh_TW bundle message loaded');
    }

    // 2. No stored pref: accept-language selects the first matching bundle.
    {
        const { sandbox } = createSandbox({ storedLocale: null, acceptLanguages: ['zh-Hant-TW', 'en-US'] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.getLocale(), 'zh_TW', 'zh-Hant-TW normalizes to zh_TW');
    }
    {
        const { sandbox } = createSandbox({ storedLocale: null, acceptLanguages: ['en-US'] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.getLocale(), 'en', 'en-US selects en');
        assert.strictEqual(api.t('content_brand_name'), 'AskPage', 'en bundle message loaded');
    }

    // 3. Missing key falls back to chrome.i18n.getMessage (returns sentinel).
    {
        const { sandbox } = createSandbox({ storedLocale: 'en', acceptLanguages: [] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.t('does_not_exist_key'), 'FALLBACK:does_not_exist_key', 'missing key falls back to chrome.i18n.getMessage');
    }

    // 4. $& and $$ in a substitution value are treated as plain text, not
    //    String.replace special patterns.
    {
        const { sandbox } = createSandbox({ storedLocale: 'en', acceptLanguages: [] });
        const api = await runLoader(sandbox);
        // Find a key with a placeholder; use agent_finished ($count$ steps, ...).
        // We assert the substitution value containing $& survives verbatim.
        const out = api.t('agent_finished', ['$&']);
        assert.ok(out.includes('$&'), 'literal $& in substitution survives');
    }

    // 5. storage.onChanged propagation: setLocale in one context fires the
    //    onChanged listeners so another context re-applies the locale.
    {
        const { sandbox } = createSandbox({ storedLocale: 'en', acceptLanguages: ['en-US'] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.getLocale(), 'en');

        let observedLocale = null;
        api.onChange((loc) => { observedLocale = loc; });

        // Simulate another context setting the pref -> storage.set fires onChanged.
        sandbox.chrome.storage.local.set({ ASKPAGE_LOCALE_PREF: 'zh_TW' });
        // The onChanged listener in lib/i18n.js triggers applyLocale (async).
        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(api.getLocale(), 'zh_TW', 'storage.onChanged re-applied zh_TW');
        assert.strictEqual(observedLocale, 'zh_TW', 'onChange fired with the new locale');
    }

    // 6. setLocale persists the preference and fires onChange.
    {
        const { sandbox, getStorage } = createSandbox({ storedLocale: 'en', acceptLanguages: ['en-US'] });
        const api = await runLoader(sandbox);
        assert.strictEqual(api.getLocale(), 'en');

        let observedLocale = null;
        api.onChange((loc) => { observedLocale = loc; });

        await api.setLocale('zh_TW');
        assert.strictEqual(api.getLocale(), 'zh_TW', 'setLocale updated currentLocale');
        assert.strictEqual(getStorage().ASKPAGE_LOCALE_PREF, 'zh_TW', 'setLocale persisted the pref');
        assert.strictEqual(observedLocale, 'zh_TW', 'onChange fired after setLocale');
    }

    console.log('i18n-loader: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});