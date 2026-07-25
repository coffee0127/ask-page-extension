// AES-256-GCM encryption functions (reused from popup.js)
//
// i18n: settings.js uses askpageI18n.t() so the settings page respects the
// runtime locale switcher (askpageI18n loads _locales/<locale>/messages.json
// via fetch and bypasses chrome.i18n.getMessage, which is bound to the browser
// UI locale and cannot be switched at runtime). When askpageI18n is not
// available (e.g. the Node test sandbox), fall back to chrome.i18n.getMessage
// so the page still renders. content.js / background.js are intentionally NOT
// migrated - they run in contexts where askpageI18n is not loaded and continue
// to use chrome.i18n.getMessage (browser-locale-bound).
const t = (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.t === 'function')
    ? askpageI18n.t
    : (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function')
        ? chrome.i18n.getMessage.bind(chrome.i18n)
        : function () { return ''; };

async function generateEncryptionKey() {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
    return key;
}

async function encryptApiKey(apiKey, key) {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data
    );

    return {
        encrypted: Array.from(new Uint8Array(encrypted)),
        iv: Array.from(iv)
    };
}

async function decryptApiKey(encryptedData, key) {
    const encrypted = new Uint8Array(encryptedData.encrypted);
    const iv = new Uint8Array(encryptedData.iv);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encrypted
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

function normalizeModelIdentifier(model = '') {
    return String(model || '')
        .trim()
        .toLowerCase()
        .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function isGpt5FamilyModel(model = '') {
    const normalized = normalizeModelIdentifier(model);
    return normalized.startsWith('gpt-5') || normalized.includes('gpt-5');
}

function isGpt41FamilyModel(model = '') {
    const normalized = normalizeModelIdentifier(model);
    return normalized.startsWith('gpt-4.1') || normalized.includes('gpt-4.1');
}

function shouldUseResponsesApi(model = '') {
    return isGpt5FamilyModel(model) || isGpt41FamilyModel(model);
}

function getAzureResponsesApiVersion(apiVersion = '') {
    const normalizedVersion = String(apiVersion || '').trim().toLowerCase();
    if (normalizedVersion === 'preview' || normalizedVersion === 'v1') {
        return normalizedVersion;
    }
    return 'preview';
}


async function getOrCreateEncryptionKey() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['ENCRYPTION_KEY'], async (result) => {
            if (result.ENCRYPTION_KEY) {
                const key = await crypto.subtle.importKey(
                    'jwk',
                    result.ENCRYPTION_KEY,
                    { name: 'AES-GCM', length: 256 },
                    true,
                    ['encrypt', 'decrypt']
                );
                resolve(key);
            } else {
                const key = await generateEncryptionKey();
                const exportedKey = await crypto.subtle.exportKey('jwk', key);
                chrome.storage.local.set({ 'ENCRYPTION_KEY': exportedKey }, () => {
                    resolve(key);
                });
            }
        });
    });
}

// DOM elements - 將在 DOMContentLoaded 中初始化
let resetButton, exportButton, importButton, importFileInput, statusDiv, footerTextEl;
let langSelect;
let commandsList, addCommandBtn, commandModal, modalTitle, modalCommandName, modalCommandPrompt;
let modalCommandModeAgent, modalCommandModeInquiry, modalCommandModeUnspecified, modalCommandScreenshotEnabled, modalCommandShowVariableLabels;
let modalSave, modalCancel, modalCommandNameError, modalCommandPromptError;
let customSystemPromptTextarea, customSystemPromptCount;

// Multi-provider UI elements
let providersList, addProviderBtn, providerModal, providerModalTitle, modalProviderName, modalProviderType;
let modalProviderCancel, modalProviderSave, modalProviderTest, modalProviderTestResult;
let modalGeminiFields, modalOpenaiFields, modalAzureFields, modalOpenaiCompatibleFields;
let modalAnthropicFields, modalDeepseekFields, modalOpenrouterFields, modalGroqFields, modalMistralFields, modalOllamaFields, modalOllamaCloudFields;
let modalGeminiApiKey, modalOpenaiApiKey, modalAzureApiKey, modalAzureEndpoint, modalAzureDeployment, modalAzureApiVersion;
let modalOpenaiCompatibleEndpoint, modalOpenaiCompatibleApiKey, modalOpenaiCompatibleModel;
let modalOpenaiCompatibleModelInputGroup, modalOpenaiCompatibleModelsListGroup, modalOpenaiCompatibleModelsList;
let modalAnthropicApiKey, modalDeepseekApiKey, modalOpenrouterApiKey, modalGroqApiKey, modalMistralApiKey, modalOllamaCloudApiKey;
let modalOllamaEndpoint, modalOllamaModel;
let modalGeminiModelsList, modalOpenaiModelsList;
let modalAnthropicModelsList, modalDeepseekModelsList, modalOpenrouterModelsList, modalGroqModelsList, modalMistralModelsList, modalOllamaCloudModelsList;
let currentEditingProvider = null;
let providers = [];

// Storage keys
const CUSTOM_COMMANDS_STORAGE = 'CUSTOM_COMMANDS';
const CUSTOM_SUMMARY_PROMPT_STORAGE = 'CUSTOM_SUMMARY_PROMPT';
const CUSTOM_SUMMARY_SHOW_VARIABLE_LABELS_STORAGE = 'CUSTOM_SUMMARY_SHOW_VARIABLE_LABELS';
const CUSTOM_SYSTEM_PROMPT_STORAGE = 'CUSTOM_SYSTEM_PROMPT';
const LAST_ACTIVE_TAB_STORAGE = 'LAST_ACTIVE_TAB';

const CUSTOM_COMMAND_MODE_AGENT = 'agent';
const CUSTOM_COMMAND_MODE_INQUIRY = 'inquiry';
const CUSTOM_COMMAND_MODE_UNSPECIFIED = 'unspecified';
const DEFAULT_CUSTOM_COMMAND_MODE = CUSTOM_COMMAND_MODE_UNSPECIFIED;
const CUSTOM_COMMAND_PREVIEW_LENGTH = 50;

// Custom summary prompt for the built-in /summary command; persisted separately
// from customCommands and merged into getBuiltInCommands() at render time so
// the built-in list stays a fresh per-render array.
let customSummaryPrompt = '';

// Built-in commands that cannot be deleted or modified. Generated per render
// so descriptions follow the runtime locale switcher rather than the language
// active at module load.
function getBuiltInCommands() {
    return [
        { cmd: '/clear', desc: t('cmd_clear_desc'), builtin: true },
        { cmd: '/summary', desc: t('cmd_summary_desc'), builtin: true, editable: true, prompt: customSummaryPrompt },
        { cmd: '/screenshot', desc: t('cmd_screenshot_desc'), builtin: true },
        { cmd: '/agent', desc: t('cmd_agent_desc'), builtin: true }
    ];
}

const PREDEFINED_MODELS = {
    gemini: [
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-flash-lite-latest',
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it'
    ],
    openai: [
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.3',
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4.1',
        'gpt-4.1-mini'
    ],
    anthropic: [
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5'
    ],
    deepseek: [
        'deepseek-chat',
        'deepseek-reasoner'
    ],
    openrouter: [
        'openai/gpt-5.6-sol-pro',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra-pro',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-luna-pro',
        'openai/gpt-5.6-luna',
        'qwen/qwen3.7-max',
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'tencent/hy3-preview',
        'xiaomi/mimo-v2.5-pro',
        'xiaomi/mimo-v2.5',
        'z-ai/glm-5',
        'x-ai/grok-4.3',
        'moonshotai/kimi-k2.6',
        'minimax/minimax-m2.7'
    ],
    groq: [
        'openai/gpt-oss-120b',
        'qwen/qwen3-32b',
        'llama-3.3-70b-versatile'
    ],
    mistral: [
        'mistral-large-latest',
        'mistral-medium-latest',
        'mistral-small-latest',
        'codestral-latest',
        'devstral-latest'
    ],
    'ollama-cloud': [
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'glm-5.2',
        'gpt-oss:120b',
        'kimi-k2.7-code',
        'minimax-m3'
    ]
};

// Current edit state
let currentEditingCommand = null;
let customCommands = [];

// Load the saved settings when the page loads
document.addEventListener('DOMContentLoaded', async () => {
    // 標記設定頁已被開啟過，供 background.js 判斷圖示點擊行為
    chrome.storage.local.set({ 'SETTINGS_OPENED': true });

    // 初始化 DOM 元素
    providersList = document.getElementById('providersList');
    addProviderBtn = document.getElementById('addProvider');
    providerModal = document.getElementById('providerModal');
    providerModalTitle = document.getElementById('providerModalTitle');
    modalProviderName = document.getElementById('modalProviderName');
    modalProviderType = document.getElementById('modalProviderType');
    modalProviderCancel = document.getElementById('modalProviderCancel');
    modalProviderSave = document.getElementById('modalProviderSave');
    modalProviderTest = document.getElementById('modalProviderTest');
    modalProviderTestResult = document.getElementById('modalProviderTestResult');

    modalGeminiFields = document.getElementById('modal-gemini-fields');
    modalOpenaiFields = document.getElementById('modal-openai-fields');
    modalAzureFields = document.getElementById('modal-azure-fields');
    modalOpenaiCompatibleFields = document.getElementById('modal-openai-compatible-fields');
    modalAnthropicFields = document.getElementById('modal-anthropic-fields');
    modalDeepseekFields = document.getElementById('modal-deepseek-fields');
    modalOpenrouterFields = document.getElementById('modal-openrouter-fields');
    modalGroqFields = document.getElementById('modal-groq-fields');
    modalMistralFields = document.getElementById('modal-mistral-fields');
    modalOllamaFields = document.getElementById('modal-ollama-fields');
    modalOllamaCloudFields = document.getElementById('modal-ollama-cloud-fields');

    modalGeminiApiKey = document.getElementById('modalGeminiApiKey');
    modalOpenaiApiKey = document.getElementById('modalOpenaiApiKey');
    modalAzureApiKey = document.getElementById('modalAzureApiKey');
    modalAzureEndpoint = document.getElementById('modalAzureEndpoint');
    modalAzureDeployment = document.getElementById('modalAzureDeployment');
    modalAzureApiVersion = document.getElementById('modalAzureApiVersion');

    modalOpenaiCompatibleEndpoint = document.getElementById('modalOpenaiCompatibleEndpoint');
    modalOpenaiCompatibleApiKey = document.getElementById('modalOpenaiCompatibleApiKey');
    modalOpenaiCompatibleModel = document.getElementById('modalOpenaiCompatibleModel');
    modalOpenaiCompatibleModelInputGroup = document.getElementById('modalOpenaiCompatibleModelInputGroup');
    modalOpenaiCompatibleModelsListGroup = document.getElementById('modalOpenaiCompatibleModelsListGroup');
    modalOpenaiCompatibleModelsList = document.getElementById('modalOpenaiCompatibleModelsList');

    modalAnthropicApiKey = document.getElementById('modalAnthropicApiKey');
    modalDeepseekApiKey = document.getElementById('modalDeepseekApiKey');
    modalOpenrouterApiKey = document.getElementById('modalOpenrouterApiKey');
    modalGroqApiKey = document.getElementById('modalGroqApiKey');
    modalMistralApiKey = document.getElementById('modalMistralApiKey');
    modalOllamaCloudApiKey = document.getElementById('modalOllamaCloudApiKey');

    modalOllamaEndpoint = document.getElementById('modalOllamaEndpoint');
    modalOllamaModel = document.getElementById('modalOllamaModel');

    modalGeminiModelsList = document.getElementById('modalGeminiModelsList');
    modalOpenaiModelsList = document.getElementById('modalOpenaiModelsList');
    modalAnthropicModelsList = document.getElementById('modalAnthropicModelsList');
    modalDeepseekModelsList = document.getElementById('modalDeepseekModelsList');
    modalOpenrouterModelsList = document.getElementById('modalOpenrouterModelsList');
    modalGroqModelsList = document.getElementById('modalGroqModelsList');
    modalMistralModelsList = document.getElementById('modalMistralModelsList');
    modalOllamaCloudModelsList = document.getElementById('modalOllamaCloudModelsList');

    resetButton = document.getElementById('reset');
    exportButton = document.getElementById('export');
    importButton = document.getElementById('import');
    importFileInput = document.getElementById('importFile');
    langSelect = document.getElementById('langSelect');
    statusDiv = document.getElementById('status');
    footerTextEl = document.getElementById('footerText');

    // Display version + footer credit via i18n (credit link HTML is the $credit$ substitution)
    const manifest = chrome.runtime.getManifest();
    if (footerTextEl) {
        const creditText = t('footer_credit');
        const creditHtml = `<a href="https://www.facebook.com/will.fans/" target="_blank" rel="noopener noreferrer">${creditText}</a>`;
        footerTextEl.innerHTML = t('footer_text', [creditHtml, String(manifest.version)]);
    }

    commandsList = document.getElementById('commandsList');
    addCommandBtn = document.getElementById('addCommand');
    commandModal = document.getElementById('commandModal');
    modalTitle = document.getElementById('modalTitle');
    modalCommandName = document.getElementById('modalCommandName');
    modalCommandNameError = document.getElementById('modalCommandNameError');
    modalCommandPrompt = document.getElementById('modalCommandPrompt');
    modalCommandPromptError = document.getElementById('modalCommandPromptError');
    modalCommandModeAgent = document.getElementById('modalCommandModeAgent');
    modalCommandModeInquiry = document.getElementById('modalCommandModeInquiry');
    modalCommandModeUnspecified = document.getElementById('modalCommandModeUnspecified');
    modalCommandScreenshotEnabled = document.getElementById('modalCommandScreenshotEnabled');
    modalCommandShowVariableLabels = document.getElementById('modalCommandShowVariableLabels');
    modalSave = document.getElementById('modalSave');
    modalCancel = document.getElementById('modalCancel');
    customSystemPromptTextarea = document.getElementById('customSystemPrompt');
    customSystemPromptCount = document.getElementById('customSystemPromptCount');

    // Tab navigation
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    // Handle tab switching
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.dataset.tab;

            // Update tab buttons
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Update tab panes
            tabPanes.forEach(pane => pane.classList.remove('active'));
            document.getElementById(`${targetTab}-tab`).classList.add('active');

            // Save active tab
            chrome.storage.local.set({ [LAST_ACTIVE_TAB_STORAGE]: targetTab });
        });
    });

    // Handle modal provider type switching
    modalProviderType.addEventListener('change', handleProviderTypeChange);

    // Modal event listeners
    addCommandBtn.addEventListener('click', () => openModal());
    modalCancel.addEventListener('click', closeModal);
    modalSave.addEventListener('click', saveCommand);
    modalCommandName.addEventListener('input', () => {
        validateCommandNameInput({ showEmptyError: true });
    });
    modalCommandPrompt.addEventListener('input', () => {
        validateCommandPromptInput({ showEmptyError: false });
    });
    let promptSaveTimeout;
    customSystemPromptTextarea.addEventListener('input', () => {
        updateCustomSystemPromptCount();
        clearTimeout(promptSaveTimeout);
        promptSaveTimeout = setTimeout(async () => {
            await saveCustomSystemPrompt();
            showStatus(t('status_system_prompt_saved'), 'success');
        }, 500);
    });

    // Provider modal listeners
    addProviderBtn.addEventListener('click', () => openProviderModal());
    modalProviderCancel.addEventListener('click', () => {
        providerModal.style.display = 'none';
        currentEditingProvider = null;
    });
    modalProviderSave.addEventListener('click', saveProvider);
    modalProviderTest.addEventListener('click', testProviderConnection);

    // Model actions event listeners (fetch models, manually input models, etc.)
    document.querySelectorAll('.btn-action-models').forEach(btn => {
        btn.addEventListener('click', handleModelAction);
    });

    // Keyboard shortcuts for modals
    document.addEventListener('keydown', (e) => {
        if (commandModal.style.display === 'block') {
            if (e.key === 'Escape') {
                closeModal();
            } else if (e.key === 'Enter' && e.ctrlKey) {
                saveCommand();
            }
        } else if (providerModal.style.display === 'block') {
            if (e.key === 'Escape') {
                providerModal.style.display = 'none';
                currentEditingProvider = null;
            } else if (e.key === 'Enter' && e.ctrlKey) {
                saveProvider();
            }
        }
    });

    // Reset settings functionality
    resetButton.addEventListener('click', () => {
        if (confirm(t('alert_reset_confirm'))) {
            chrome.storage.local.clear(() => {
                showStatus(t('status_settings_reset'), 'success');
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            });
        }
    });

    // Export Settings
    exportButton.addEventListener('click', () => {
        chrome.storage.local.get(null, (items) => {
            const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `ask-page-settings-${timestamp}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showStatus(t('status_settings_exported'), 'success');
        });
    });

    // Import Settings Trigger
    importButton.addEventListener('click', () => {
        importFileInput.click();
    });

    // Language switcher: initialize to the current effective locale and update
    // the pref on change. askpageI18n.setLocale persists ASKPAGE_LOCALE_PREF,
    // reloads the messages bundle, and fires onChange; i18n-bootstrap listens
    // to onChange and re-applies all data-i18n* elements. Some settings.js
    // callers use t() at render time (renderCommands, renderProviders), so we
    // also re-render the dynamic sections after a locale switch.
    if (langSelect) {
        const syncLangSelect = () => {
            const current = (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.getLocale === 'function')
                ? askpageI18n.getLocale()
                : 'en';
            if (langSelect.value !== current) {
                langSelect.value = current;
            }
        };
        syncLangSelect();
        // Keep the select in sync if the locale changes elsewhere.
        if (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.onChange === 'function') {
            askpageI18n.onChange(syncLangSelect);
        }
        langSelect.addEventListener('change', async () => {
            const value = langSelect.value;
            if (typeof askpageI18n !== 'undefined' && askpageI18n && typeof askpageI18n.setLocale === 'function') {
                await askpageI18n.setLocale(value);
                // Re-render dynamic sections whose text comes from t() at render
                // time. Provider active-highlight state lives only in block-local
                // vars on initial load, so re-read it from storage to preserve it.
                renderCommands();
                chrome.storage.local.get(['ACTIVE_PROVIDER_ID', 'ACTIVE_MODEL'], (activeResult) => {
                    renderProviders(activeResult.ACTIVE_PROVIDER_ID || '', activeResult.ACTIVE_MODEL || '');
                });
            }
        });
    }

    // Handle File Import
    importFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const settings = JSON.parse(event.target.result);
                // Basic validation
                if (typeof settings !== 'object') {
                    throw new Error('Invalid settings format');
                }

                if (confirm(t('alert_import_confirm'))) {
                    chrome.storage.local.set(settings, () => {
                        showStatus(t('status_settings_imported_reloading'), 'success');
                        setTimeout(() => {
                            window.location.reload();
                        }, 1500);
                    });
                }
            } catch (error) {
                console.error('Import error:', error);
                showStatus(t('err_import_invalid_format'), 'error');
            }
            // Reset input value to allow importing same file again
            importFileInput.value = '';
        };
        reader.readAsText(file);
    });

    // 載入設定的其餘代碼
    await getOrCreateEncryptionKey();

    function validateTemplateVariables(prompt) {
        const template = String(prompt || '');
        const pattern = /\$\{([^}]*)\}/g;
        const defaultsByName = new Map();
        let match;
        while ((match = pattern.exec(template)) !== null) {
            const inner = match[1];
            const colonIndex = inner.indexOf(':');
            const rawName = colonIndex === -1 ? inner : inner.slice(0, colonIndex);
            const name = rawName.normalize('NFC');
            if (!name) {
                continue;
            }
            if (!/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name)) {
                return `變數名稱「${name}」無效，只能包含字母、數字與底線，且開頭不能是數字`;
            }
            const hasDefault = colonIndex !== -1;
            const defaultValue = hasDefault ? inner.slice(colonIndex + 1) : '';
            if (defaultsByName.has(name)) {
                const existing = defaultsByName.get(name);
                if (hasDefault && existing.hasDefault && existing.defaultValue !== defaultValue) {
                    return `變數「${name}」的重複預設值不一致：${existing.defaultValue} 與 ${defaultValue}`;
                }
                if (hasDefault && !existing.hasDefault) {
                    defaultsByName.set(name, { hasDefault, defaultValue });
                }
            } else {
                defaultsByName.set(name, { hasDefault, defaultValue });
            }
        }
        return '';
    }

    function openModal(command = null) {
        currentEditingCommand = command;
        const isBuiltIn = Boolean(command && command.builtin);

        if (command) {
            modalTitle.textContent = command.builtin ? t('modal_edit_builtin_command') : t('modal_edit_custom_command');
            modalCommandName.value = command.cmd;
            modalCommandName.disabled = command.builtin;
            modalCommandPrompt.value = command.prompt || '';
            modalCommandShowVariableLabels.checked = Boolean(command.showVariableLabels);

            if (!isBuiltIn) {
                const mode = normalizeCustomCommandMode(command.mode);
                setCustomCommandMode(mode);
                modalCommandScreenshotEnabled.checked = Boolean(command.screenshotEnabled);
            } else {
                setCustomCommandMode(DEFAULT_CUSTOM_COMMAND_MODE);
                modalCommandScreenshotEnabled.checked = false;
            }
        } else {
            modalTitle.textContent = t('modal_new_custom_command');
            modalCommandName.value = '';
            modalCommandName.disabled = false;
            modalCommandPrompt.value = '';
            modalCommandShowVariableLabels.checked = false;
            setCustomCommandMode(DEFAULT_CUSTOM_COMMAND_MODE);
            modalCommandScreenshotEnabled.checked = false;
        }

        toggleModalCommandModeInputs(!isBuiltIn);

        clearCommandNameValidation();
        clearCommandPromptValidation();
        commandModal.style.display = 'block';
        if (!modalCommandName.disabled) {
            modalCommandName.focus();
        } else {
            modalCommandPrompt.focus();
        }
    }

    function closeModal() {
        commandModal.style.display = 'none';
        currentEditingCommand = null;
        clearCommandNameValidation();
        clearCommandPromptValidation();
    }

    // Validate command name
    function isValidCommandName(name) {
        return /^\/[a-zA-Z0-9_-]+$/.test(name);
    }

    // Check if command already exists
    function findExistingCommand(name, excludeCurrent = false) {
        const allCommands = [...getBuiltInCommands(), ...customCommands];
        return allCommands.find(cmd =>
            cmd.cmd === name &&
            (!excludeCurrent || !currentEditingCommand || cmd.cmd !== currentEditingCommand.cmd)
        );
    }

    function clearCommandNameValidation() {
        modalCommandName.classList.remove('input-error');
        modalCommandName.removeAttribute('aria-invalid');
        modalCommandNameError.textContent = '';
    }

    function setCommandNameValidationError(message) {
        if (message) {
            modalCommandName.classList.add('input-error');
            modalCommandName.setAttribute('aria-invalid', 'true');
            modalCommandNameError.textContent = message;
            return false;
        }

        clearCommandNameValidation();
        return true;
    }

    function getCommandNameValidationMessage(name, { showEmptyError = true, excludeCurrent = false } = {}) {
        if (modalCommandName.disabled) {
            return '';
        }

        if (!name) {
            return showEmptyError ? t('err_enter_command_name') : '';
        }

        if (!isValidCommandName(name)) {
            return t('err_command_name_format');
        }

        const existingCommand = findExistingCommand(name, excludeCurrent);
        if (existingCommand) {
            return existingCommand.builtin ?
                t('err_command_name_dup_builtin') :
                t('err_command_name_dup_custom');
        }

        return '';
    }

    function validateCommandNameInput(options = {}) {
        const name = modalCommandName.value.trim();
        const excludeCurrent = Boolean(currentEditingCommand && !currentEditingCommand.builtin);
        const message = getCommandNameValidationMessage(name, {
            showEmptyError: options.showEmptyError !== false,
            excludeCurrent
        });

        return setCommandNameValidationError(message);
    }

    function clearCommandPromptValidation() {
        modalCommandPrompt.classList.remove('input-error');
        modalCommandPrompt.removeAttribute('aria-invalid');
        modalCommandPromptError.textContent = '';
    }

    function setCommandPromptValidationError(message) {
        if (message) {
            modalCommandPrompt.classList.add('input-error');
            modalCommandPrompt.setAttribute('aria-invalid', 'true');
            modalCommandPromptError.textContent = message;
            return false;
        }

        clearCommandPromptValidation();
        return true;
    }

    function getCommandPromptValidationMessage(prompt, { showEmptyError = true } = {}) {
        if (!prompt) {
            const isSummaryBuiltin = currentEditingCommand
                && currentEditingCommand.builtin
                && currentEditingCommand.cmd === '/summary';
            if (isSummaryBuiltin || !showEmptyError) {
                return '';
            }
            return '請輸入提示內容';
        }

        return validateTemplateVariables(prompt);
    }

    function validateCommandPromptInput(options = {}) {
        const prompt = modalCommandPrompt.value.trim();
        const message = getCommandPromptValidationMessage(prompt, {
            showEmptyError: options.showEmptyError !== false
        });
        return setCommandPromptValidationError(message);
    }

    // Save command from modal
    function saveCommand() {
        const name = modalCommandName.value.trim();
        const prompt = modalCommandPrompt.value.trim();
        const mode = getCustomCommandMode();
        const screenshotEnabled = Boolean(modalCommandScreenshotEnabled && modalCommandScreenshotEnabled.checked);
        const showVariableLabels = Boolean(modalCommandShowVariableLabels && modalCommandShowVariableLabels.checked);

        if (!validateCommandNameInput({ showEmptyError: true })) {
            return;
        }

        if (!validateCommandPromptInput({ showEmptyError: true })) {
            return;
        }

        if (currentEditingCommand) {
            // Editing existing command
            if (currentEditingCommand.builtin) {
                // Special handling for built-in commands
                if (currentEditingCommand.cmd === '/summary') {
                    // Save custom summary prompt
                    chrome.storage.local.set({
                        [CUSTOM_SUMMARY_PROMPT_STORAGE]: prompt,
                        [CUSTOM_SUMMARY_SHOW_VARIABLE_LABELS_STORAGE]: showVariableLabels
                    });
                    currentEditingCommand.prompt = prompt;
                    currentEditingCommand.showVariableLabels = showVariableLabels;
                }
            } else {
                // Editing custom command
                const index = customCommands.findIndex(cmd => cmd.cmd === currentEditingCommand.cmd);
                if (index !== -1) {
                    customCommands[index] = {
                        cmd: name,
                        prompt,
                        mode,
                        screenshotEnabled,
                        showVariableLabels
                    };
                }
            }
        } else {
            // Adding new command
            customCommands.push({
                cmd: name,
                prompt,
                mode,
                screenshotEnabled,
                showVariableLabels
            });
        }

        saveCustomCommands();
        renderCommands();
        closeModal();
        showStatus(t('status_command_saved'), 'success');
    }

    // Delete custom command
    function deleteCommand(command) {
        if (command.builtin) {
            showStatus(t('err_cannot_delete_builtin'), 'error');
            return;
        }

        if (confirm(t('alert_delete_command_confirm', [String(command.cmd)]))) {
            const index = customCommands.findIndex(cmd => cmd.cmd === command.cmd);
            if (index !== -1) {
                customCommands.splice(index, 1);
                saveCustomCommands();
                renderCommands();
                showStatus(t('status_command_deleted'), 'success');
            }
        }
    }

    // Save custom commands to storage
    function saveCustomCommands() {
        chrome.storage.local.set({ [CUSTOM_COMMANDS_STORAGE]: customCommands });
    }

    function updateCustomSystemPromptCount() {
        const textLength = customSystemPromptTextarea.value.length;
        customSystemPromptCount.textContent = t('char_count_suffix', [String(textLength)]);
    }

    async function saveCustomSystemPrompt() {
        const customSystemPrompt = customSystemPromptTextarea.value.trim();
        await chrome.storage.local.set({ [CUSTOM_SYSTEM_PROMPT_STORAGE]: customSystemPrompt });
    }

    // Render commands list
    function renderCommands() {
        commandsList.innerHTML = '';

        // Render built-in commands
        getBuiltInCommands().forEach(command => {
            const commandElement = createCommandElement(command);
            commandsList.appendChild(commandElement);
        });

        // Render custom commands
        customCommands.forEach(command => {
            const commandElement = createCommandElement(command);
            commandsList.appendChild(commandElement);
        });
    }

    // Create command element
    function createCommandElement(command) {
        const div = document.createElement('div');
        div.className = 'command-item';

        const isBuiltIn = command.builtin;
        const isEditable = command.editable || !isBuiltIn;
        const desc = getCommandListDescription(command);

        div.innerHTML = `
            <div class="command-header">
                <div>
                    <div class="command-name">${command.cmd}</div>
                    <div style="color: var(--text-secondary); font-size: 14px; margin-top: 4px;">
                        ${desc}
                    </div>
                </div>
                <div class="command-actions">
                    ${isBuiltIn ? `<span class="built-in-badge">${t('builtin_badge')}</span>` : ''}
                    ${isEditable ? `<button class="btn-secondary btn-small" data-action="edit" data-command="${command.cmd}">${t('btn_edit')}</button>` : ''}
                    ${!isBuiltIn ? `<button class="btn-danger btn-small" data-action="delete" data-command="${command.cmd}">${t('btn_delete')}</button>` : ''}
                </div>
            </div>
        `;

        return div;
    }

    function normalizeCustomCommandMode(mode) {
        if (mode === CUSTOM_COMMAND_MODE_INQUIRY || mode === CUSTOM_COMMAND_MODE_AGENT || mode === CUSTOM_COMMAND_MODE_UNSPECIFIED) {
            return mode;
        }

        return DEFAULT_CUSTOM_COMMAND_MODE;
    }

    function normalizeCustomCommand(command) {
        if (!command || typeof command !== 'object') {
            return null;
        }

        const cmd = String(command.cmd || '').trim();
        if (!cmd) {
            return null;
        }

        return {
            cmd: cmd,
            prompt: String(command.prompt || ''),
            mode: normalizeCustomCommandMode(command.mode),
            screenshotEnabled: command.screenshotEnabled === true,
            showVariableLabels: command.showVariableLabels === true
        };
    }

    function normalizeCustomCommands(commands) {
        if (!Array.isArray(commands)) {
            return [];
        }

        return commands
            .map(normalizeCustomCommand)
            .filter(Boolean);
    }

    function getCustomCommandMode() {
        if (modalCommandModeInquiry && modalCommandModeInquiry.checked) {
            return CUSTOM_COMMAND_MODE_INQUIRY;
        }
        if (modalCommandModeUnspecified && modalCommandModeUnspecified.checked) {
            return CUSTOM_COMMAND_MODE_UNSPECIFIED;
        }

        return DEFAULT_CUSTOM_COMMAND_MODE;
    }

    function setCustomCommandMode(mode) {
        const normalizedMode = normalizeCustomCommandMode(mode);

        if (modalCommandModeAgent) {
            modalCommandModeAgent.checked = normalizedMode === CUSTOM_COMMAND_MODE_AGENT;
        }
        if (modalCommandModeInquiry) {
            modalCommandModeInquiry.checked = normalizedMode === CUSTOM_COMMAND_MODE_INQUIRY;
        }
        if (modalCommandModeUnspecified) {
            modalCommandModeUnspecified.checked = normalizedMode === CUSTOM_COMMAND_MODE_UNSPECIFIED;
        }
    }

    function toggleModalCommandModeInputs(enabled) {
        if (modalCommandModeAgent && modalCommandModeAgent.closest) {
            const modeSection = modalCommandModeAgent.closest('.form-group');
            if (modeSection) {
                modeSection.style.display = enabled ? 'block' : 'none';
            }
        }
        if (modalCommandScreenshotEnabled && modalCommandScreenshotEnabled.closest) {
            const screenshotSection = modalCommandScreenshotEnabled.closest('.form-group');
            if (screenshotSection) {
                screenshotSection.style.display = enabled ? 'block' : 'none';
            }
        }
    }

    function getPromptPreview(text, maxLength = CUSTOM_COMMAND_PREVIEW_LENGTH) {
        const safeText = String(text || '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!safeText) {
            return '';
        }

        return safeText.length > maxLength
            ? `${safeText.slice(0, maxLength)}...`
            : safeText;
    }

    function getCommandListDescription(command) {
        if (command.desc) {
            return command.desc;
        }

        const promptText = command.prompt;
        if (!promptText) {
            return '';
        }

        return getPromptPreview(promptText);
    }

    // Add event delegation for command buttons
    commandsList.addEventListener('click', (e) => {
        const button = e.target.closest('[data-action]');
        if (!button) {
            return;
        }

        const action = button.dataset.action;
        const cmdName = button.dataset.command;

        if (action === 'edit') {
            let command = getBuiltInCommands().find(cmd => cmd.cmd === cmdName);
            if (!command) {
                command = customCommands.find(cmd => cmd.cmd === cmdName);
            }
            if (command) {
                openModal(command);
            }
        } else if (action === 'delete') {
            const command = customCommands.find(cmd => cmd.cmd === cmdName);
            if (command) {
                deleteCommand(command);
            }
        }
    });

    // Show status message
    function showStatus(message, type = 'success') {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;

        setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.className = 'status';
        }, 3000);
    }

    chrome.storage.local.get([
        'PROVIDERS', 'ACTIVE_PROVIDER_ID', 'ACTIVE_MODEL',
        CUSTOM_SUMMARY_PROMPT_STORAGE, CUSTOM_SUMMARY_SHOW_VARIABLE_LABELS_STORAGE,
        CUSTOM_COMMANDS_STORAGE, CUSTOM_SYSTEM_PROMPT_STORAGE,
        LAST_ACTIVE_TAB_STORAGE
    ], async (result) => {
        let activeProviderId = result.ACTIVE_PROVIDER_ID || '';
        let activeModel = result.ACTIVE_MODEL || '';
        providers = result.PROVIDERS;

        if (!providers || !Array.isArray(providers)) {
            providers = await migrateOldSettings();
            // Refetch active values
            const activeResult = await chrome.storage.local.get(['ACTIVE_PROVIDER_ID', 'ACTIVE_MODEL']);
            activeProviderId = activeResult.ACTIVE_PROVIDER_ID || '';
            activeModel = activeResult.ACTIVE_MODEL || '';
        }

        // Render providers list
        renderProviders(activeProviderId, activeModel);

        // Load custom commands
        customCommands = normalizeCustomCommands(result[CUSTOM_COMMANDS_STORAGE]);

        // Load custom summary prompt for built-in /summary command
        const summaryCommand = getBuiltInCommands().find(cmd => cmd.cmd === '/summary');
        if (summaryCommand) {
            const storedSummaryPrompt = result[CUSTOM_SUMMARY_PROMPT_STORAGE];
            if (storedSummaryPrompt) {
                customSummaryPrompt = String(storedSummaryPrompt);
                summaryCommand.prompt = customSummaryPrompt;
            }
            summaryCommand.showVariableLabels = result[CUSTOM_SUMMARY_SHOW_VARIABLE_LABELS_STORAGE] === true;
        }

        renderCommands();

        customSystemPromptTextarea.value = result[CUSTOM_SYSTEM_PROMPT_STORAGE] || '';
        updateCustomSystemPromptCount();

        // Restore active tab
        const lastActiveTab = result[LAST_ACTIVE_TAB_STORAGE];
        if (lastActiveTab) {
            const tabButton = document.querySelector(`.tab-btn[data-tab="${lastActiveTab}"]`);
            if (tabButton) {
                tabButton.click();
            }
        }
    });

    // Render providers list
    function renderProviders(activeProviderId, activeModel) {
        providersList.innerHTML = '';

        if (providers.length === 0) {
            providersList.innerHTML = `
                <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
                    ${t('provider_list_empty')}
                </div>
            `;
            return;
        }

        providers.forEach(p => {
            const div = document.createElement('div');
            div.className = 'command-item';

            let borderColor = 'rgba(117, 216, 255, 0.48)';
            let typeLabel = '';
            if (p.type === 'gemini') {
                borderColor = '#4285F4';
                typeLabel = 'Google Gemini';
            } else if (p.type === 'openai') {
                borderColor = '#10a37f';
                typeLabel = 'OpenAI';
            } else if (p.type === 'azure') {
                borderColor = '#0078d4';
                typeLabel = 'Azure OpenAI';
            } else if (p.type === 'anthropic') {
                borderColor = '#d97706';
                typeLabel = 'Anthropic Claude';
            } else if (p.type === 'deepseek') {
                borderColor = '#3b82f6';
                typeLabel = 'DeepSeek';
            } else if (p.type === 'openrouter') {
                borderColor = '#fc521f';
                typeLabel = 'OpenRouter';
            } else if (p.type === 'groq') {
                borderColor = '#f59e0b';
                typeLabel = 'Groq';
            } else if (p.type === 'mistral') {
                borderColor = '#f35f22';
                typeLabel = 'Mistral AI';
            } else if (p.type === 'ollama') {
                borderColor = '#374151';
                typeLabel = 'Ollama (Local)';
            } else if (p.type === 'ollama-cloud') {
                borderColor = '#111827';
                typeLabel = 'Ollama Cloud';
            } else if (p.type === 'openai-compatible') {
                borderColor = '#a855f7';
                typeLabel = 'OpenAI Compatible';
            }
            div.style.borderLeft = `4px solid ${borderColor}`;

            let modelsHtml = '';
            if (['gemini', 'openai', 'anthropic', 'deepseek', 'openrouter', 'groq', 'mistral', 'ollama-cloud', 'openai-compatible'].includes(p.type)) {
                const models = p.models || [];
                modelsHtml = models.map(m => {
                    const isActive = (p.id === activeProviderId && m === activeModel);
                    return `<span class="model-badge ${isActive ? 'active' : ''}" data-action="set-active" data-provider-id="${p.id}" data-model="${m}">${isActive ? '✓ ' : ''}${m}</span>`;
                }).join(' ');
            } else if (p.type === 'azure') {
                const isActive = (p.id === activeProviderId && p.azureDeployment === activeModel);
                modelsHtml = `<span class="model-badge ${isActive ? 'active' : ''}" data-action="set-active" data-provider-id="${p.id}" data-model="${p.azureDeployment}">${isActive ? '✓ ' : ''}${p.azureDeployment}</span>`;
            } else if (p.type === 'ollama') {
                const isActive = (p.id === activeProviderId && p.ollamaModel === activeModel);
                modelsHtml = `<span class="model-badge ${isActive ? 'active' : ''}" data-action="set-active" data-provider-id="${p.id}" data-model="${p.ollamaModel}">${isActive ? '✓ ' : ''}${p.ollamaModel || t('provider_model_unspecified')}</span>`;
            }

            let details = '';
            if (p.type === 'azure') {
                details = `<div style="font-size: 12px; opacity: 0.7; margin-top: 4px;">${t('provider_endpoint_label', [String(p.azureEndpoint || '')])}</div>`;
            } else if (p.type === 'ollama') {
                details = `<div style="font-size: 12px; opacity: 0.7; margin-top: 4px;">${t('provider_endpoint_label', [String(p.ollamaEndpoint || 'http://localhost:11434/v1')])}</div>`;
            } else if (p.type === 'ollama-cloud') {
                details = `<div style="font-size: 12px; opacity: 0.7; margin-top: 4px;">${t('provider_endpoint_ollama_cloud')}</div>`;
            } else if (p.type === 'openai-compatible') {
                details = `<div style="font-size: 12px; opacity: 0.7; margin-top: 4px;">${t('provider_endpoint_label', [String(p.openaiCompatibleEndpoint || '')])}</div>`;
            }

            div.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <span class="command-name" style="font-size: 16px; font-weight: 700; color: var(--text-primary);">${p.name || typeLabel}</span>
                            <span style="font-size: 12px; opacity: 0.8; padding: 2px 6px; background: rgba(255,255,255,0.08); border-radius: 4px; font-weight: 600;">${typeLabel}</span>
                        </div>
                        ${details}
                        <div style="margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px;">
                            ${modelsHtml}
                        </div>
                    </div>
                    <div class="command-actions" style="flex-shrink: 0; margin-left: 16px; display: flex; gap: 8px;">
                        <button class="btn-secondary btn-small" data-action="edit-provider" data-id="${p.id}">
                            ${t('btn_edit')}
                        </button>
                        <button class="btn-danger btn-small" data-action="delete-provider" data-id="${p.id}">
                            ${t('btn_delete')}
                        </button>
                    </div>
                </div>
            `;

            providersList.appendChild(div);
        });
    }

    // Provider modal handling
    async function openProviderModal(provider = null) {
        currentEditingProvider = provider;
        const encryptionKey = await getOrCreateEncryptionKey();

        // Reset fields
        if (modalProviderTestResult) {
            modalProviderTestResult.textContent = '';
            modalProviderTestResult.style.display = 'none';
        }
        modalProviderName.value = '';
        modalProviderType.value = 'gemini';
        modalGeminiApiKey.value = '';
        modalOpenaiApiKey.value = '';
        modalAzureApiKey.value = '';
        modalAzureEndpoint.value = '';
        modalAzureDeployment.value = '';
        modalAzureApiVersion.value = '2024-10-21';
        modalOpenaiCompatibleEndpoint.value = 'http://localhost:11434/v1';
        modalOpenaiCompatibleApiKey.value = '';
        modalOpenaiCompatibleModel.value = '';

        modalAnthropicApiKey.value = '';
        modalDeepseekApiKey.value = '';
        modalOpenrouterApiKey.value = '';
        modalGroqApiKey.value = '';
        modalMistralApiKey.value = '';
        modalOllamaCloudApiKey.value = '';
        modalOllamaEndpoint.value = 'http://localhost:11434/v1';
        modalOllamaModel.value = '';

        // Uncheck checkboxes
        modalGeminiModelsList.innerHTML = '';
        modalOpenaiModelsList.innerHTML = '';
        modalAnthropicModelsList.innerHTML = '';
        modalDeepseekModelsList.innerHTML = '';
        modalOpenrouterModelsList.innerHTML = '';
        modalGroqModelsList.innerHTML = '';
        modalMistralModelsList.innerHTML = '';
        modalOllamaCloudModelsList.innerHTML = '';
        modalOpenaiCompatibleModelsList.innerHTML = '';

        modalOpenaiCompatibleModelInputGroup.style.display = 'block';
        modalOpenaiCompatibleModelsListGroup.style.display = 'none';

        if (provider) {
            providerModalTitle.textContent = t('modal_edit_provider_title');
            modalProviderName.value = provider.name || '';
            modalProviderType.value = provider.type;

            let decryptedKey = '';
            if (provider.apiKey) {
                try {
                    decryptedKey = await decryptApiKey(provider.apiKey, encryptionKey);
                } catch (e) {
                    console.error('Decryption failed', e);
                    decryptedKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
                }
            }

            const configuredModels = provider.models || [];
            const predefinedModels = PREDEFINED_MODELS[provider.type] || [];
            const combinedModels = Array.from(new Set([...predefinedModels, ...configuredModels]));

            if (provider.type === 'gemini') {
                modalGeminiApiKey.value = decryptedKey;
                renderModalModelsList(modalGeminiModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'openai') {
                modalOpenaiApiKey.value = decryptedKey;
                renderModalModelsList(modalOpenaiModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'azure') {
                modalAzureApiKey.value = decryptedKey;
                modalAzureEndpoint.value = provider.azureEndpoint || '';
                modalAzureDeployment.value = provider.azureDeployment || '';
                modalAzureApiVersion.value = provider.azureApiVersion || '2024-10-21';
            } else if (provider.type === 'openai-compatible') {
                modalOpenaiCompatibleEndpoint.value = provider.openaiCompatibleEndpoint || 'http://localhost:11434/v1';
                modalOpenaiCompatibleApiKey.value = decryptedKey;
                const configuredModels = provider.models || [];
                if (configuredModels.length > 1) {
                    modalOpenaiCompatibleModelInputGroup.style.display = 'none';
                    modalOpenaiCompatibleModelsListGroup.style.display = 'block';
                    renderModalModelsList(modalOpenaiCompatibleModelsList, configuredModels, configuredModels);
                    modalOpenaiCompatibleModel.value = '';
                } else {
                    modalOpenaiCompatibleModelInputGroup.style.display = 'block';
                    modalOpenaiCompatibleModelsListGroup.style.display = 'none';
                    modalOpenaiCompatibleModel.value = provider.openaiCompatibleModel || (configuredModels[0] || '');
                }
            } else if (provider.type === 'anthropic') {
                modalAnthropicApiKey.value = decryptedKey;
                renderModalModelsList(modalAnthropicModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'deepseek') {
                modalDeepseekApiKey.value = decryptedKey;
                renderModalModelsList(modalDeepseekModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'openrouter') {
                modalOpenrouterApiKey.value = decryptedKey;
                renderModalModelsList(modalOpenrouterModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'groq') {
                modalGroqApiKey.value = decryptedKey;
                renderModalModelsList(modalGroqModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'mistral') {
                modalMistralApiKey.value = decryptedKey;
                renderModalModelsList(modalMistralModelsList, combinedModels, configuredModels);
            } else if (provider.type === 'ollama') {
                modalOllamaEndpoint.value = provider.ollamaEndpoint || 'http://localhost:11434/v1';
                modalOllamaModel.value = provider.ollamaModel || '';
            } else if (provider.type === 'ollama-cloud') {
                modalOllamaCloudApiKey.value = decryptedKey;
                renderModalModelsList(modalOllamaCloudModelsList, combinedModels, configuredModels);
            }
        } else {
            providerModalTitle.textContent = t('modal_add_provider_title');
            modalProviderName.value = modalProviderType.options[modalProviderType.selectedIndex].text;

            // Set Gemini defaults
            const geminiModels = [...(PREDEFINED_MODELS['gemini'] || [])];
            renderModalModelsList(modalGeminiModelsList, geminiModels, [geminiModels[0]]);

            // Set OpenAI defaults
            const openaiModels = [...(PREDEFINED_MODELS['openai'] || [])];
            renderModalModelsList(modalOpenaiModelsList, openaiModels, [openaiModels[0]]);

            // Set Anthropic defaults
            const anthropicModels = [...(PREDEFINED_MODELS['anthropic'] || [])];
            renderModalModelsList(modalAnthropicModelsList, anthropicModels, [anthropicModels[0]]);

            // Set DeepSeek defaults
            const deepseekModels = [...(PREDEFINED_MODELS['deepseek'] || [])];
            renderModalModelsList(modalDeepseekModelsList, deepseekModels, [deepseekModels[0]]);

            // Set OpenRouter defaults
            const openrouterModels = [...(PREDEFINED_MODELS['openrouter'] || [])];
            renderModalModelsList(modalOpenrouterModelsList, openrouterModels, [openrouterModels[0]]);

            // Set Groq defaults
            const groqModels = [...(PREDEFINED_MODELS['groq'] || [])];
            renderModalModelsList(modalGroqModelsList, groqModels, [groqModels[0]]);

            // Set Mistral defaults
            const mistralModels = [...(PREDEFINED_MODELS['mistral'] || [])];
            renderModalModelsList(modalMistralModelsList, mistralModels, [mistralModels[0]]);

            // Set Ollama Cloud defaults
            const ollamaCloudModels = [...(PREDEFINED_MODELS['ollama-cloud'] || [])];
            renderModalModelsList(modalOllamaCloudModelsList, ollamaCloudModels, [ollamaCloudModels[0]]);
        }

        updateModalFieldsVisibility();
        providerModal.style.display = 'block';
    }

    function updateModalFieldsVisibility() {
        const type = modalProviderType.value;
        modalGeminiFields.style.display = type === 'gemini' ? 'block' : 'none';
        modalOpenaiFields.style.display = type === 'openai' ? 'block' : 'none';
        modalAzureFields.style.display = type === 'azure' ? 'block' : 'none';
        modalAnthropicFields.style.display = type === 'anthropic' ? 'block' : 'none';
        modalDeepseekFields.style.display = type === 'deepseek' ? 'block' : 'none';
        modalOpenrouterFields.style.display = type === 'openrouter' ? 'block' : 'none';
        modalGroqFields.style.display = type === 'groq' ? 'block' : 'none';
        modalMistralFields.style.display = type === 'mistral' ? 'block' : 'none';
        modalOllamaFields.style.display = type === 'ollama' ? 'block' : 'none';
        modalOllamaCloudFields.style.display = type === 'ollama-cloud' ? 'block' : 'none';
        modalOpenaiCompatibleFields.style.display = type === 'openai-compatible' ? 'block' : 'none';
    }

    function handleProviderTypeChange() {
        const optionTexts = Array.from(modalProviderType.options).map(opt => opt.text);
        const currentName = modalProviderName.value.trim();

        if (currentName === '' || optionTexts.includes(currentName)) {
            modalProviderName.value = modalProviderType.options[modalProviderType.selectedIndex].text;
        }

        updateModalFieldsVisibility();

        if (modalProviderTestResult) {
            modalProviderTestResult.textContent = '';
            modalProviderTestResult.style.display = 'none';
        }
    }

    async function saveProvider() {
        const name = modalProviderName.value.trim();
        const type = modalProviderType.value;
        const encryptionKey = await getOrCreateEncryptionKey();

        const providerData = {
            id: currentEditingProvider ? currentEditingProvider.id : 'provider_' + Date.now(),
            name: name || (
                type === 'gemini' ? 'Google Gemini' :
                    type === 'openai' ? 'OpenAI' :
                        type === 'azure' ? 'Azure OpenAI' :
                            type === 'anthropic' ? 'Anthropic Claude' :
                                type === 'deepseek' ? 'DeepSeek' :
                                    type === 'openrouter' ? 'OpenRouter' :
                                        type === 'groq' ? 'Groq' :
                                            type === 'mistral' ? 'Mistral AI' :
                                                type === 'ollama' ? 'Ollama (Local)' :
                                                    type === 'ollama-cloud' ? 'Ollama Cloud' : 'OpenAI Compatible'
            ),
            type: type
        };

        let apiKeyRaw = '';
        if (type === 'gemini') {
            apiKeyRaw = modalGeminiApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_gemini_apikey'));
                return;
            }
            const selectedModels = [];
            modalGeminiModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_gemini_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'openai') {
            apiKeyRaw = modalOpenaiApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_openai_apikey'));
                return;
            }
            const selectedModels = [];
            modalOpenaiModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_openai_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'azure') {
            apiKeyRaw = modalAzureApiKey.value.trim();
            const endpoint = modalAzureEndpoint.value.trim();
            const deployment = modalAzureDeployment.value.trim();
            const apiVersion = modalAzureApiVersion.value;

            if (!apiKeyRaw || !endpoint || !deployment) {
                alert(t('alert_fill_azure_fields'));
                return;
            }
            providerData.azureEndpoint = endpoint;
            providerData.azureDeployment = deployment;
            providerData.azureApiVersion = apiVersion;
            providerData.models = [deployment];
        } else if (type === 'openai-compatible') {
            const endpoint = modalOpenaiCompatibleEndpoint.value.trim();
            apiKeyRaw = modalOpenaiCompatibleApiKey.value.trim();

            if (!endpoint) {
                alert(t('alert_fill_api_endpoint'));
                return;
            }

            if (modalOpenaiCompatibleModelsListGroup.style.display !== 'none') {
                const selectedModels = [];
                modalOpenaiCompatibleModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                    selectedModels.push(cb.value);
                });
                if (selectedModels.length === 0) {
                    alert(t('alert_select_at_least_one_model'));
                    return;
                }
                providerData.openaiCompatibleEndpoint = endpoint;
                providerData.openaiCompatibleModel = selectedModels[0];
                providerData.models = selectedModels;
            } else {
                const modelStr = modalOpenaiCompatibleModel.value.trim();
                if (!modelStr) {
                    alert(t('alert_fill_model_name'));
                    return;
                }
                const models = modelStr.split(/[,，]/).map(m => m.trim()).filter(Boolean);
                if (models.length === 0) {
                    alert(t('alert_fill_model_name'));
                    return;
                }
                providerData.openaiCompatibleEndpoint = endpoint;
                providerData.openaiCompatibleModel = models[0];
                providerData.models = models;
            }
        } else if (type === 'anthropic') {
            apiKeyRaw = modalAnthropicApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_anthropic_apikey'));
                return;
            }
            const selectedModels = [];
            modalAnthropicModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_anthropic_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'deepseek') {
            apiKeyRaw = modalDeepseekApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_deepseek_apikey'));
                return;
            }
            const selectedModels = [];
            modalDeepseekModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_deepseek_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'openrouter') {
            apiKeyRaw = modalOpenrouterApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_openrouter_apikey'));
                return;
            }
            const selectedModels = [];
            modalOpenrouterModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_openrouter_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'groq') {
            apiKeyRaw = modalGroqApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_groq_apikey'));
                return;
            }
            const selectedModels = [];
            modalGroqModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_groq_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'mistral') {
            apiKeyRaw = modalMistralApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_mistral_apikey'));
                return;
            }
            const selectedModels = [];
            modalMistralModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_mistral_model'));
                return;
            }
            providerData.models = selectedModels;
        } else if (type === 'ollama') {
            const endpoint = modalOllamaEndpoint.value.trim();
            const model = modalOllamaModel.value.trim();

            if (!endpoint || !model) {
                alert(t('alert_fill_ollama_endpoint_model'));
                return;
            }
            providerData.ollamaEndpoint = endpoint;
            providerData.ollamaModel = model;
            providerData.models = [model];
            apiKeyRaw = '';
        } else if (type === 'ollama-cloud') {
            apiKeyRaw = modalOllamaCloudApiKey.value.trim();
            if (!apiKeyRaw) {
                alert(t('alert_enter_ollama_cloud_apikey'));
                return;
            }
            const selectedModels = [];
            modalOllamaCloudModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                selectedModels.push(cb.value);
            });
            if (selectedModels.length === 0) {
                alert(t('alert_select_at_least_one_ollama_cloud_model'));
                return;
            }
            providerData.models = selectedModels;
        }

        if (apiKeyRaw) {
            try {
                providerData.apiKey = await encryptApiKey(apiKeyRaw, encryptionKey);
            } catch (err) {
                console.error('Encryption failed', err);
                providerData.apiKey = apiKeyRaw;
            }
        } else {
            providerData.apiKey = '';
        }

        if (currentEditingProvider) {
            const index = providers.findIndex(p => p.id === currentEditingProvider.id);
            if (index !== -1) {
                providers[index] = providerData;
            }
        } else {
            providers.push(providerData);
        }

        await chrome.storage.local.set({ PROVIDERS: providers });

        const activeResult = await chrome.storage.local.get(['ACTIVE_PROVIDER_ID', 'ACTIVE_MODEL']);
        let activeProviderId = activeResult.ACTIVE_PROVIDER_ID || '';
        let activeModel = activeResult.ACTIVE_MODEL || '';

        let activeValid = false;
        const currentActiveProvider = providers.find(p => p.id === activeProviderId);
        if (currentActiveProvider) {
            if (currentActiveProvider.models && currentActiveProvider.models.includes(activeModel)) {
                activeValid = true;
            }
        }

        if (!activeValid && providers.length > 0) {
            activeProviderId = providers[0].id;
            activeModel = providers[0].models ? providers[0].models[0] : '';
            await chrome.storage.local.set({
                ACTIVE_PROVIDER_ID: activeProviderId,
                ACTIVE_MODEL: activeModel
            });
        }

        providerModal.style.display = 'none';
        currentEditingProvider = null;
        renderProviders(activeProviderId, activeModel);
        showStatus(t('status_provider_saved'), 'success');
    }

    async function testProviderConnection() {
        const type = modalProviderType.value;

        // Clear previous results
        modalProviderTestResult.textContent = '';
        modalProviderTestResult.style.display = 'none';

        // Disable button and show status
        modalProviderTest.disabled = true;
        const originalText = modalProviderTest.textContent;
        modalProviderTest.textContent = t('status_testing');

        try {
            let response;
            let url = '';
            const headers = {};
            let method = 'GET';
            let body = null;

            if (type === 'gemini') {
                const apiKey = modalGeminiApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_gemini_apikey_first'));
                }
                url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            } else if (type === 'openai') {
                const apiKey = modalOpenaiApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_openai_apikey_first'));
                }
                url = 'https://api.openai.com/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'anthropic') {
                const apiKey = modalAnthropicApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_anthropic_apikey_first'));
                }
                url = 'https://api.anthropic.com/v1/models';
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
            } else if (type === 'deepseek') {
                const apiKey = modalDeepseekApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_deepseek_apikey_first'));
                }
                url = 'https://api.deepseek.com/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'openrouter') {
                const apiKey = modalOpenrouterApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_openrouter_apikey_first'));
                }
                url = 'https://openrouter.ai/api/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'groq') {
                const apiKey = modalGroqApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_groq_apikey_first'));
                }
                url = 'https://api.groq.com/openai/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'mistral') {
                const apiKey = modalMistralApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_mistral_apikey_first'));
                }
                url = 'https://api.mistral.ai/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'ollama-cloud') {
                const apiKey = modalOllamaCloudApiKey.value.trim();
                if (!apiKey) {
                    throw new Error(t('err_enter_ollama_cloud_apikey_first'));
                }
                url = 'https://ollama.com/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else if (type === 'azure') {
                const apiKey = modalAzureApiKey.value.trim();
                const endpoint = modalAzureEndpoint.value.trim();
                const deployment = modalAzureDeployment.value.trim();
                const apiVersion = modalAzureApiVersion.value;

                if (!apiKey || !endpoint || !deployment) {
                    throw new Error(t('err_fill_azure_fields'));
                }

                const useResponsesApi = shouldUseResponsesApi(deployment);
                const azureApiVersionForRequest = useResponsesApi ? getAzureResponsesApiVersion(apiVersion) : apiVersion;
                const azureEndpoint = endpoint.trim().replace(/\/$/, '');

                if (useResponsesApi) {
                    url = `${azureEndpoint}/openai/v1/responses?api-version=${azureApiVersionForRequest}`;
                    method = 'POST';
                    headers['Content-Type'] = 'application/json';
                    headers['api-key'] = apiKey;
                    body = JSON.stringify({
                        model: deployment,
                        input: [{
                            type: 'message',
                            role: 'user',
                            content: [{ type: 'input_text', text: 'Ping' }]
                        }],
                        max_output_tokens: 16
                    });
                } else {
                    url = `${azureEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
                    method = 'POST';
                    headers['Content-Type'] = 'application/json';
                    headers['api-key'] = apiKey;
                    body = JSON.stringify({
                        messages: [{ role: 'user', content: 'Ping' }],
                        max_tokens: 1
                    });
                }
            } else if (type === 'ollama') {
                const endpoint = modalOllamaEndpoint.value.trim() || 'http://localhost:11434/v1';
                const model = modalOllamaModel.value.trim();
                if (!model) {
                    throw new Error(t('err_fill_ollama_model_name'));
                }
                url = `${endpoint}/models`;
            } else if (type === 'openai-compatible') {
                const endpoint = modalOpenaiCompatibleEndpoint.value.trim();
                const apiKey = modalOpenaiCompatibleApiKey.value.trim();

                if (!endpoint) {
                    throw new Error(t('err_fill_api_endpoint'));
                }

                url = endpoint.endsWith('/models') ? endpoint : `${endpoint.replace(/\/$/, '')}/models`;
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }
            } else {
                throw new Error(t('err_unknown_provider_type'));
            }

            // Perform request
            const fetchOptions = { method, headers };
            if (body) {
                fetchOptions.body = body;
            }

            if (type === 'ollama') {
                try {
                    response = await fetch(url, fetchOptions);
                    if (!response.ok) {
                        throw new Error();
                    }
                } catch (e) {
                    const baseUrl = url.replace(/\/v1\/?$/, '').replace(/\/models$/, '');
                    response = await fetch(`${baseUrl}/api/tags`);
                }
            } else {
                response = await fetch(url, fetchOptions);
            }

            if (!response.ok) {
                let errText = '';
                try {
                    errText = await response.text();
                    try {
                        const parsed = JSON.parse(errText);
                        if (parsed.error && parsed.error.message) {
                            errText = parsed.error.message;
                        } else if (parsed.error && typeof parsed.error === 'string') {
                            errText = parsed.error;
                        } else if (parsed.message) {
                            errText = parsed.message;
                        }
                    } catch (_) {
                        // ignore JSON parsing errors
                    }
                } catch (_) {
                    // ignore response reading errors
                }

                throw new Error(errText || `HTTP ${response.status} ${response.statusText}`);
            }

            // Connection test succeeded!
            modalProviderTestResult.textContent = t('status_connection_success');
            modalProviderTestResult.style.color = 'var(--success-color)';
            modalProviderTestResult.style.display = 'inline-block';
        } catch (err) {
            console.error('Connection test failed details:', err);

            const errorMsg = err.message || err;
            modalProviderTestResult.textContent = t('status_connection_failed', [String(errorMsg)]);
            modalProviderTestResult.style.color = 'var(--danger-color)';
            modalProviderTestResult.style.display = 'inline-block';
        } finally {
            modalProviderTest.disabled = false;
            modalProviderTest.textContent = originalText;
        }
    }

    async function deleteProvider(id) {
        const providerName = providers.find(p => p.id === id)?.name || '';
        if (confirm(t('alert_delete_provider_confirm', [String(providerName)]))) {
            const index = providers.findIndex(p => p.id === id);
            if (index !== -1) {
                providers.splice(index, 1);
                await chrome.storage.local.set({ PROVIDERS: providers });

                const activeResult = await chrome.storage.local.get(['ACTIVE_PROVIDER_ID', 'ACTIVE_MODEL']);
                let activeProviderId = activeResult.ACTIVE_PROVIDER_ID || '';
                let activeModel = activeResult.ACTIVE_MODEL || '';

                if (activeProviderId === id || providers.length === 0) {
                    if (providers.length > 0) {
                        activeProviderId = providers[0].id;
                        activeModel = providers[0].models ? providers[0].models[0] : '';
                    } else {
                        activeProviderId = '';
                        activeModel = '';
                    }
                    await chrome.storage.local.set({
                        ACTIVE_PROVIDER_ID: activeProviderId,
                        ACTIVE_MODEL: activeModel
                    });
                }

                renderProviders(activeProviderId, activeModel);
                showStatus(t('status_provider_deleted'), 'success');
            }
        }
    }

    providersList.addEventListener('click', async (e) => {
        const target = e.target;

        if (target.classList.contains('model-badge')) {
            const providerId = target.dataset.providerId;
            const model = target.dataset.model;

            await chrome.storage.local.set({
                ACTIVE_PROVIDER_ID: providerId,
                ACTIVE_MODEL: model
            });

            renderProviders(providerId, model);
            showStatus(t('status_switched_model', [String(model)]), 'success');
            return;
        }

        const button = target.closest('button');
        if (!button) {return;}

        const action = button.dataset.action;
        const id = button.dataset.id;

        if (action === 'edit-provider') {
            const provider = providers.find(p => p.id === id);
            if (provider) {
                openProviderModal(provider);
            }
        } else if (action === 'delete-provider') {
            deleteProvider(id);
        }
    });

    function renderModalModelsList(container, models, checkedModels = []) {
        container.innerHTML = '';

        // Deduplicate while preserving model list order
        const uniqueSortedModels = Array.from(new Set(models));

        uniqueSortedModels.forEach(modelName => {
            const isChecked = checkedModels.includes(modelName);
            const label = document.createElement('label');
            label.style.fontWeight = 'normal';
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '8px';
            label.style.fontSize = '13px';
            label.style.color = 'var(--text-primary)';
            label.style.cursor = 'pointer';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = modelName;
            checkbox.checked = isChecked;

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(' ' + modelName));
            container.appendChild(label);
        });
    }

    async function handleModelAction(e) {
        const btn = e.currentTarget;
        const providerType = btn.dataset.providerType;
        const action = btn.dataset.action;

        if (action === 'switch-to-manual-input') {
            switchToManualInput(providerType);
            return;
        }

        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('status_processing');

        try {
            if (action === 'fetch-models') {
                await fetchAndRenderModels(providerType);
            } else if (action === 'add-custom-model') {
                addCustomModelName(providerType);
            } else if (action === 'fetch-custom-models') {
                await fetchCustomEndpointModels(providerType);
            }
        } catch (err) {
            console.error('Model action failed', err);
            alert(t('alert_operation_failed', [String(err.message || err)]));
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    function switchToManualInput(providerType) {
        if (providerType === 'openai-compatible') {
            const checkedModels = [];
            modalOpenaiCompatibleModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                checkedModels.push(cb.value);
            });

            modalOpenaiCompatibleModelInputGroup.style.display = 'block';
            modalOpenaiCompatibleModelsListGroup.style.display = 'none';

            if (checkedModels.length > 0) {
                modalOpenaiCompatibleModel.value = checkedModels.join(', ');
            }
        }
    }

    async function fetchAndRenderModels(providerType) {
        let apiKey = '';
        let url = '';
        const headers = {};

        // 1. Get API Key based on providerType
        if (providerType === 'gemini') {
            apiKey = modalGeminiApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_gemini_apikey_first'));}
            url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        } else if (providerType === 'openai') {
            apiKey = modalOpenaiApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_openai_apikey_first'));}
            url = 'https://api.openai.com/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (providerType === 'anthropic') {
            apiKey = modalAnthropicApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_anthropic_apikey_first'));}
            url = 'https://api.anthropic.com/v1/models';
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
        } else if (providerType === 'deepseek') {
            apiKey = modalDeepseekApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_deepseek_apikey_first'));}
            url = 'https://api.deepseek.com/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (providerType === 'openrouter') {
            apiKey = modalOpenrouterApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_openrouter_apikey_first'));}
            url = 'https://openrouter.ai/api/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (providerType === 'groq') {
            apiKey = modalGroqApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_groq_apikey_first'));}
            url = 'https://api.groq.com/openai/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (providerType === 'mistral') {
            apiKey = modalMistralApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_mistral_apikey_first'));}
            url = 'https://api.mistral.ai/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (providerType === 'ollama-cloud') {
            apiKey = modalOllamaCloudApiKey.value.trim();
            if (!apiKey) {throw new Error(t('err_enter_ollama_cloud_apikey_first'));}
            url = 'https://ollama.com/v1/models';
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        // 2. Fetch from API
        const response = await fetch(url, { headers });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(t('err_api_error_status', [String(response.status), String(errText || '')]));
        }

        const data = await response.json();
        let models = [];

        if (providerType === 'gemini') {
            if (data.models && Array.isArray(data.models)) {
                models = data.models
                    .filter(m => m.name)
                    .map(m => m.name.replace(/^models\//, ''));
            }
        } else if (['openai', 'deepseek', 'openrouter', 'groq', 'anthropic', 'mistral', 'ollama-cloud'].includes(providerType)) {
            const list = data.data || data.models || [];
            if (Array.isArray(list)) {
                models = list.map(m => m.id || m.name).filter(Boolean);
            }
        }

        if (models.length === 0) {
            throw new Error(t('err_no_models_found'));
        }

        // Get container
        const container = getModelListContainer(providerType);
        if (!container) {return;}

        // Get current checked states
        const checkedModels = [];
        container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            checkedModels.push(cb.value);
        });

        // Get all models current in container
        const currentModels = [];
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            currentModels.push(cb.value);
        });

        // Merge, deduplicate, sort
        const combinedModels = Array.from(new Set([
            ...(PREDEFINED_MODELS[providerType] || []),
            ...currentModels,
            ...models
        ]));

        renderModalModelsList(container, combinedModels, checkedModels);
        showStatus(t('status_models_loaded', [String(models.length)]), 'success');
    }

    function addCustomModelName(providerType) {
        const modelName = prompt(t('prompt_enter_manual_model_name'));
        if (modelName === null) {return;} // User cancelled
        const trimmed = modelName.trim();
        if (!trimmed) {
            alert(t('alert_model_name_empty'));
            return;
        }

        const container = getModelListContainer(providerType);
        if (!container) {return;}

        // Get current checked states
        const checkedModels = [];
        container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            checkedModels.push(cb.value);
        });

        // Get all models current in container
        const currentModels = [];
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            currentModels.push(cb.value);
        });

        // Add the new custom model if it's not already in the list
        if (!currentModels.includes(trimmed)) {
            currentModels.push(trimmed);
        }

        // Also check it automatically as standard UX
        if (!checkedModels.includes(trimmed)) {
            checkedModels.push(trimmed);
        }

        // Re-render
        renderModalModelsList(container, currentModels, checkedModels);
        showStatus(t('status_manual_model_added', [String(trimmed)]), 'success');
    }

    async function fetchCustomEndpointModels(providerType) {
        let endpoint = '';
        let apiKey = '';
        const headers = {};

        if (providerType === 'ollama') {
            endpoint = modalOllamaEndpoint.value.trim() || 'http://localhost:11434/v1';
        } else if (providerType === 'openai-compatible') {
            endpoint = modalOpenaiCompatibleEndpoint.value.trim();
            if (!endpoint) {throw new Error(t('err_fill_api_endpoint_first'));}
            apiKey = modalOpenaiCompatibleApiKey.value.trim();
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
        }

        let models = [];
        if (providerType === 'ollama') {
            try {
                const response = await fetch(`${endpoint}/models`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.data && Array.isArray(data.data)) {
                        models = data.data.map(m => m.id || m.name).filter(Boolean);
                    }
                } else {
                    throw new Error();
                }
            } catch (e) {
                const baseUrl = endpoint.replace(/\/v1\/?$/, '');
                const response = await fetch(`${baseUrl}/api/tags`);
                if (!response.ok) {throw new Error(t('err_cannot_connect_ollama'));}
                const data = await response.json();
                if (data.models && Array.isArray(data.models)) {
                    models = data.models.map(m => m.name || m.model).filter(Boolean);
                }
            }
        } else {
            const url = endpoint.endsWith('/models') ? endpoint : `${endpoint.replace(/\/$/, '')}/models`;
            const response = await fetch(url, { headers });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(t('err_api_error_status', [String(response.status), String(errText || '')]));
            }
            const data = await response.json();
            const list = data.data || data.models || [];
            if (Array.isArray(list)) {
                models = list.map(m => m.id || m.name).filter(Boolean);
            }
        }

        if (models.length === 0) {
            throw new Error(t('err_no_models_found'));
        }

        // Sort alphabetically
        models.sort((a, b) => a.localeCompare(b));

        if (providerType === 'ollama') {
            const promptMsg = t('prompt_loaded_models_hint', [models.join('\n')]);
            const currentVal = modalOllamaModel.value;
            const choice = prompt(promptMsg, currentVal || models[0]);
            if (choice !== null) {
                const trimmedChoice = choice.trim();
                if (trimmedChoice) {
                    modalOllamaModel.value = trimmedChoice;
                    showStatus(t('status_model_selected', [String(trimmedChoice)]), 'success');
                }
            }
        } else {
            modalOpenaiCompatibleModelInputGroup.style.display = 'none';
            modalOpenaiCompatibleModelsListGroup.style.display = 'block';

            const checkedModels = [];
            const textVal = modalOpenaiCompatibleModel.value.trim();
            if (textVal) {
                const parsedTextModels = textVal.split(/[,，]/).map(m => m.trim()).filter(Boolean);
                parsedTextModels.forEach(m => {
                    if (!checkedModels.includes(m)) {
                        checkedModels.push(m);
                    }
                });
            }
            modalOpenaiCompatibleModelsList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                const val = cb.value.trim();
                if (val && !checkedModels.includes(val)) {
                    checkedModels.push(val);
                }
            });

            // Merge fetched models list with checked/manual models and deduplicate
            const combinedModels = Array.from(new Set([...models, ...checkedModels]));

            renderModalModelsList(modalOpenaiCompatibleModelsList, combinedModels, checkedModels);
            showStatus(t('status_models_loaded', [String(models.length)]), 'success');
        }
    }

    function getModelListContainer(providerType) {
        if (providerType === 'gemini') {return modalGeminiModelsList;}
        if (providerType === 'openai') {return modalOpenaiModelsList;}
        if (providerType === 'anthropic') {return modalAnthropicModelsList;}
        if (providerType === 'deepseek') {return modalDeepseekModelsList;}
        if (providerType === 'openrouter') {return modalOpenrouterModelsList;}
        if (providerType === 'groq') {return modalGroqModelsList;}
        if (providerType === 'mistral') {return modalMistralModelsList;}
        if (providerType === 'ollama-cloud') {return modalOllamaCloudModelsList;}
        if (providerType === 'openai-compatible') {return modalOpenaiCompatibleModelsList;}
        return null;
    }

    async function migrateOldSettings() {
        const result = await chrome.storage.local.get([
            'PROVIDERS',
            'PROVIDER',
            'GEMINI_API_KEY', 'GEMINI_MODEL',
            'OPENAI_API_KEY', 'OPENAI_MODEL',
            'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION',
            'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_ENDPOINT', 'OPENAI_COMPATIBLE_MODEL'
        ]);

        if (result.PROVIDERS && Array.isArray(result.PROVIDERS)) {
            return result.PROVIDERS;
        }

        const migratedProviders = [];
        let activeProviderId = '';
        let activeModel = '';

        if (result.GEMINI_API_KEY || result.GEMINI_MODEL) {
            const id = 'provider_gemini_default';
            const model = result.GEMINI_MODEL || 'gemini-flash-lite-latest';
            migratedProviders.push({
                id,
                name: 'Google Gemini',
                type: 'gemini',
                apiKey: result.GEMINI_API_KEY || '',
                models: [model]
            });
            if (result.PROVIDER === 'gemini' || !result.PROVIDER) {
                activeProviderId = id;
                activeModel = model;
            }
        }

        if (result.OPENAI_API_KEY || result.OPENAI_MODEL) {
            const id = 'provider_openai_default';
            const model = result.OPENAI_MODEL || 'gpt-4o-mini';
            migratedProviders.push({
                id,
                name: 'OpenAI',
                type: 'openai',
                apiKey: result.OPENAI_API_KEY || '',
                models: [model]
            });
            if (result.PROVIDER === 'openai') {
                activeProviderId = id;
                activeModel = model;
            }
        }

        if (result.AZURE_OPENAI_API_KEY || result.AZURE_OPENAI_ENDPOINT) {
            const id = 'provider_azure_default';
            const deployment = result.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
            migratedProviders.push({
                id,
                name: 'Azure OpenAI',
                type: 'azure',
                apiKey: result.AZURE_OPENAI_API_KEY || '',
                azureEndpoint: result.AZURE_OPENAI_ENDPOINT || '',
                azureDeployment: deployment,
                azureApiVersion: result.AZURE_OPENAI_API_VERSION || '2024-10-21',
                models: [deployment]
            });
            if (result.PROVIDER === 'azure') {
                activeProviderId = id;
                activeModel = deployment;
            }
        }

        if (result.OPENAI_COMPATIBLE_ENDPOINT || result.OPENAI_COMPATIBLE_MODEL) {
            const id = 'provider_openai_compatible_default';
            const model = result.OPENAI_COMPATIBLE_MODEL || '';
            migratedProviders.push({
                id,
                name: 'OpenAI Compatible',
                type: 'openai-compatible',
                apiKey: result.OPENAI_COMPATIBLE_API_KEY || '',
                openaiCompatibleEndpoint: result.OPENAI_COMPATIBLE_ENDPOINT || 'http://localhost:11434/v1',
                openaiCompatibleModel: model,
                models: [model]
            });
            if (result.PROVIDER === 'openai-compatible') {
                activeProviderId = id;
                activeModel = model;
            }
        }

        if (migratedProviders.length === 0) {
            const id = 'provider_gemini_default';
            const model = 'gemini-flash-lite-latest';
            migratedProviders.push({
                id,
                name: 'Google Gemini',
                type: 'gemini',
                apiKey: '',
                models: [model]
            });
            activeProviderId = id;
            activeModel = model;
        }

        if (!activeProviderId) {
            activeProviderId = migratedProviders[0].id;
            activeModel = migratedProviders[0].models ? migratedProviders[0].models[0] : '';
        }

        await chrome.storage.local.set({
            PROVIDERS: migratedProviders,
            ACTIVE_PROVIDER_ID: activeProviderId,
            ACTIVE_MODEL: activeModel
        });

        return migratedProviders;
    }
});
