'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const settingsScript = fs.readFileSync(path.join(rootDir, 'settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(rootDir, 'settings.html'), 'utf8');
const contentScript = fs.readFileSync(path.join(rootDir, 'content.js'), 'utf8');
const backgroundScript = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

// Stub for chrome.i18n.getMessage so settings.js module-load code that calls it
// (e.g. BUILT_IN_COMMANDS) does not throw in the Node test sandbox.
const zhMessages = JSON.parse(fs.readFileSync(path.join(rootDir, '_locales', 'zh_TW', 'messages.json'), 'utf8'));
function stubGetMessage(key, substitutions) {
    const entry = zhMessages[key];
    if (!entry) {
        return '';
    }
    let message = entry.message || '';
    const placeholders = entry.placeholders || {};
    const ordered = Object.entries(placeholders)
        .map(([name, meta]) => {
            const m = /^\$(\d+)$/.exec(meta.content || '');
            return { name, index: m ? Number(m[1]) - 1 : -1 };
        })
        .filter((p) => p.index >= 0)
        .sort((a, b) => a.index - b.index);
    if (substitutions && substitutions.length) {
        ordered.forEach((p) => {
            const value = substitutions[p.index] != null ? String(substitutions[p.index]) : '';
            message = message.replace(new RegExp(`\\$${p.name}\\$`, 'gi'), value);
        });
    }
    return message;
}

const sandbox = {
    console,
    chrome: {
        i18n: {
            getMessage: stubGetMessage,
            getUILanguage() {
                return 'zh-TW';
            }
        }
    },
    document: {
        addEventListener() {}
    }
};

sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${settingsScript}\nglobalThis.__ollamaCloudModels = PREDEFINED_MODELS['ollama-cloud'];`, sandbox, {
    filename: 'settings.js'
});

const expectedModels = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'glm-5.2',
    'gpt-oss:120b',
    'kimi-k2.7-code',
    'minimax-m3'
];

const actualModels = Array.from(sandbox.__ollamaCloudModels);
assert.deepStrictEqual(actualModels, expectedModels);
assert.strictEqual(new Set(actualModels).size, actualModels.length);

assert.match(settingsHtml, /<option value="ollama-cloud">Ollama Cloud<\/option>/);
assert.match(settingsHtml, /id="modalOllamaCloudApiKey"/);
assert.match(settingsHtml, /id="modalOllamaCloudModelsList"/);
assert.match(settingsHtml, /data-provider-type="ollama-cloud" data-action="fetch-models"/);

assert.match(settingsScript, /url = 'https:\/\/ollama\.com\/v1\/models';/);
assert.match(settingsScript, /headers\['Authorization'\] = `Bearer \$\{apiKey\}`;/);
assert.match(contentScript, /providerType === 'ollama-cloud'/);
assert.match(contentScript, /endpoint = 'https:\/\/ollama\.com\/v1';/);
assert.match(contentScript, /'ollama-cloud'\]\.includes\(activeConfig\.type\)/);
assert.match(contentScript, /chrome\.runtime\.connect\(\{ name: OLLAMA_CLOUD_FETCH_PORT \}\)/);
assert.match(contentScript, /createOllamaCloudServiceWorkerFetch\(apiKey\)/);
assert.match(contentScript, /fetchImpl: providerFetch/);

assert.match(backgroundScript, /chrome\.runtime\.onConnect\.addListener/);
assert.match(backgroundScript, /const OLLAMA_CLOUD_API_BASE_URL = 'https:\/\/ollama\.com\/v1';/);
assert.match(backgroundScript, /new Set\(\['chat\/completions', 'responses'\]\)/);
assert.match(backgroundScript, /'Authorization': `Bearer \$\{apiKey\}`/);

console.log('ollama-cloud-provider: ok');
