// Applies data-i18n* attributes on the page. Uses askpageI18n.t() when available
// so the settings page respects the runtime locale switcher; otherwise falls
// back to chrome.i18n.getMessage (bound to the browser UI locale).
//
// Re-runnable: askpageI18n.setLocale() triggers applyI18nAttributes() again so
// every data-i18n* element re-renders with the newly loaded locale without a
// page reload.

(function () {
    'use strict';

    function resolveT() {
        if (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.t === 'function') {
            return askpageI18n.t;
        }
        if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
            return chrome.i18n.getMessage;
        }
        return function () { return ''; };
    }

    function applyI18nAttributes() {
        const t = resolveT();

        if (typeof document === 'undefined' || !document.documentElement) return;

        const uiLang = (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.getLocale === 'function')
            ? askpageI18n.getLocale()
            : (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage
                ? chrome.i18n.getUILanguage()
                : 'en');
        document.documentElement.lang = uiLang;

        document.querySelectorAll('[data-i18n]').forEach((el) => {
            const msg = t(el.dataset.i18n);
            if (msg) el.textContent = msg;
        });

        document.querySelectorAll('[data-i18n-html]').forEach((el) => {
            const key = el.dataset.i18nHtml;
            let substitutions = [];
            const raw = el.dataset.i18nSubstitutions;
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) substitutions = parsed.map(String);
                } catch (e) {
                    console.warn('[AskPage] Invalid data-i18n-substitutions JSON for key', key, e);
                }
            }
            const msg = t(key, substitutions);
            if (msg) el.innerHTML = msg;
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            const msg = t(el.dataset.i18nPlaceholder);
            if (msg) el.placeholder = msg;
        });

        document.querySelectorAll('[data-i18n-title]').forEach((el) => {
            const msg = t(el.dataset.i18nTitle);
            if (msg) el.title = msg;
        });

        document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
            const msg = t(el.dataset.i18nAriaLabel);
            if (msg) el.setAttribute('aria-label', msg);
        });
    }

    // Re-apply whenever the runtime locale changes.
    if (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.onChange === 'function') {
        askpageI18n.onChange(applyI18nAttributes);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyI18nAttributes, { once: true });
    } else {
        applyI18nAttributes();
    }

    // Expose so settings.js can force a re-apply after programmatic locale work.
    window.applyI18nAttributes = applyI18nAttributes;
})();