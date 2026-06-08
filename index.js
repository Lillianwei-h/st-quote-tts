import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXT_NAME = 'quote-tts';

const DEFAULT_PATTERNS = [
    { open: '“', close: '”', label: '“…”', enabled: true },
    { open: '「', close: '」', label: '「…」', enabled: true },
    { open: '『', close: '』', label: '『…』', enabled: true },
    { open: '‘', close: '’', label: '‘…’', enabled: true },
    { open: '"', close: '"', label: '"…"', enabled: true },
];

let currentAudio = null;
let quoteRegex = null;
const audioCache = new Map();

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = {
            enabled: true,
            includeQuotes: false,
            patterns: JSON.parse(JSON.stringify(DEFAULT_PATTERNS)),
        };
    }
    return extension_settings[EXT_NAME];
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rebuildRegex() {
    const settings = getSettings();
    const active = settings.patterns.filter(p => p.enabled);
    if (active.length === 0) {
        quoteRegex = null;
        return;
    }
    const alts = active.map(p =>
        `${escapeRegExp(p.open)}([^${escapeRegExp(p.close)}]+)${escapeRegExp(p.close)}`,
    );
    quoteRegex = new RegExp(`(${alts.join('|')})`, 'g');
}

function processMessageElement(mesEl) {
    const settings = getSettings();
    if (!settings.enabled || !quoteRegex) return;

    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl || textEl.dataset.quoteTtsProcessed) return;
    textEl.dataset.quoteTtsProcessed = '1';

    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const tNode of textNodes) {
        const text = tNode.textContent;
        quoteRegex.lastIndex = 0;
        if (!quoteRegex.test(text)) continue;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        quoteRegex.lastIndex = 0;
        let match;

        while ((match = quoteRegex.exec(text)) !== null) {
            if (match.index > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
            }

            const fullQuote = match[0];
            const innerText = match.slice(2).find(g => g !== undefined) || fullQuote.slice(1, -1);

            const wrap = document.createElement('span');
            wrap.className = 'quote-tts-wrap';
            wrap.appendChild(document.createTextNode(fullQuote));

            const btn = document.createElement('span');
            btn.className = 'quote-tts-btn fa-solid fa-volume-high';
            btn.title = 'Play';
            btn.dataset.ttsText = innerText;
            btn.dataset.ttsTextFull = fullQuote;
            wrap.appendChild(btn);

            const dlBtn = document.createElement('span');
            dlBtn.className = 'quote-tts-download fa-solid fa-download';
            dlBtn.title = 'Download audio';
            wrap.appendChild(dlBtn);

            const regenBtn = document.createElement('span');
            regenBtn.className = 'quote-tts-regen fa-solid fa-rotate';
            regenBtn.title = 'Regenerate';
            wrap.appendChild(regenBtn);

            frag.appendChild(wrap);
            lastIdx = match.index + fullQuote.length;
        }

        if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }

        tNode.parentNode.replaceChild(frag, tNode);
    }
}

function clearAllProcessed() {
    document.querySelectorAll('#chat .mes .mes_text[data-quote-tts-processed]').forEach(el => {
        delete el.dataset.quoteTtsProcessed;
    });
}

function reprocessAllMessages() {
    clearAllProcessed();
    restoreOriginalText();
    document.querySelectorAll('#chat .mes').forEach(mesEl => processMessageElement(mesEl));
}

function restoreOriginalText() {
    document.querySelectorAll('#chat .mes .quote-tts-wrap').forEach(wrap => {
        const textParts = [];
        wrap.childNodes.forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) textParts.push(child.textContent);
        });
        const textNode = document.createTextNode(textParts.join(''));
        wrap.parentNode.replaceChild(textNode, wrap);
    });
}

function getCharNameFromMessage(mesEl) {
    return mesEl.getAttribute('ch_name') || SillyTavern.getContext().name2 || '';
}

function stopCurrentAudio() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
        document.querySelectorAll('.quote-tts-btn.playing').forEach(el => el.classList.remove('playing'));
    }
}

async function generateAudio(text, charName) {
    const ttsSettings = extension_settings.tts;
    console.log('[QuoteTTS] TTS settings:', ttsSettings?.currentProvider, ttsSettings);
    if (!ttsSettings || !ttsSettings.currentProvider) {
        toastr.warning('TTS provider not configured. Please set up TTS in extensions first.');
        return null;
    }

    const providerName = ttsSettings.currentProvider;
    const providerSettings = ttsSettings[providerName];
    console.log('[QuoteTTS] Provider:', providerName, 'Settings:', providerSettings);

    if (providerName.toLowerCase().includes('sovits')) {
        return await callGptSovits(text, providerSettings);
    } else if (providerName === 'XTTSv2') {
        return await callXtts(text, charName, providerSettings);
    } else {
        console.warn('[QuoteTTS] Unknown provider:', JSON.stringify(providerName), '- using fallback narrate');
        await fallbackNarrate(text, charName);
        return null;
    }
}

function cacheAudio(wrap, url) {
    const btn = wrap.querySelector('.quote-tts-btn');
    const dlBtn = wrap.querySelector('.quote-tts-download');
    const regenBtn = wrap.querySelector('.quote-tts-regen');

    const oldUrl = audioCache.get(wrap);
    if (oldUrl) URL.revokeObjectURL(oldUrl);

    audioCache.set(wrap, url);
    btn.classList.add('has-cache');
    dlBtn.classList.add('visible');
    regenBtn.classList.add('visible');

    dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `tts_${Date.now()}.wav`;
        a.click();
    };
}

async function playUrl(url, btn) {
    stopCurrentAudio();
    btn.classList.add('playing');
    const audio = new Audio(url);
    currentAudio = audio;
    audio.addEventListener('ended', () => { btn.classList.remove('playing'); currentAudio = null; });
    audio.addEventListener('error', (e) => { console.error('[QuoteTTS] Audio error:', e); btn.classList.remove('playing'); currentAudio = null; toastr.error('Audio playback failed'); });
    try {
        await audio.play();
    } catch (e) {
        console.error('[QuoteTTS] Play failed:', e);
        btn.classList.remove('playing');
        currentAudio = null;
    }
}

async function onPlayClick(wrap, charName, forceRegen) {
    console.log('[QuoteTTS] onPlayClick called, forceRegen:', forceRegen);
    const btn = wrap.querySelector('.quote-tts-btn');
    const settings = getSettings();
    const text = settings.includeQuotes ? btn.dataset.ttsTextFull : btn.dataset.ttsText;
    console.log('[QuoteTTS] Text to speak:', text, 'charName:', charName);

    const cached = audioCache.get(wrap);
    if (cached && !forceRegen) {
        console.log('[QuoteTTS] Playing from cache');
        await playUrl(cached, btn);
        return;
    }

    stopCurrentAudio();
    btn.classList.add('playing');

    try {
        const blob = await generateAudio(text, charName);
        console.log('[QuoteTTS] generateAudio returned:', blob);
        if (!blob) { btn.classList.remove('playing'); return; }

        const url = URL.createObjectURL(blob);
        cacheAudio(wrap, url);
        await playUrl(url, btn);
    } catch (err) {
        console.error('[QuoteTTS] Error:', err);
        btn.classList.remove('playing');
        toastr.error('TTS error: ' + err.message);
    }
}

async function callGptSovits(text, settings) {
    const url = settings?.provider_endpoint || 'http://localhost:9880';
    const body = {
        text: text,
        text_lang: settings?.text_lang || 'en',
        prompt_lang: settings?.prompt_lang || 'en',
        prompt_text: settings?.prompt_text || "We left as soon as we came, though it's no skin off my nose in any case.",
        ref_audio_path: settings?.ref_audio_path || '',
        streaming_mode: 'false',
    };

    console.debug('[QuoteTTS] Requesting TTS:', url, body);

    const response = await fetch(`${url}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errText = await response.text();
        console.error('[QuoteTTS] TTS response error:', response.status, errText);
        throw new Error(`GPT-SoVITS returned ${response.status}`);
    }
    return await response.blob();
}

async function callXtts(text, charName, settings) {
    const url = settings?.provider_endpoint || 'http://localhost:8020';
    const response = await fetch(`${url}/tts_to_audio/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speaker_wav: charName, language: settings?.language || 'en' }),
    });
    if (!response.ok) throw new Error(`XTTS returned ${response.status}`);
    return await response.blob();
}

async function fallbackNarrate(text, charName) {
    const { executeSlashCommandsWithOptions } = await import('../../../slash-commands.js');
    const escaped = text.replace(/"/g, '\\"');
    await executeSlashCommandsWithOptions(`/speak voice="${charName}" ${escaped}`);
}

function renderPatternsList() {
    const settings = getSettings();
    const container = document.getElementById('quote_tts_patterns_list');
    if (!container) return;
    container.innerHTML = '';

    settings.patterns.forEach((pattern, idx) => {
        const row = document.createElement('div');
        row.className = 'flex-container';
        row.style.cssText = 'gap:4px;align-items:center';

        const lbl = document.createElement('label');
        lbl.className = 'checkbox_label';
        lbl.style.cssText = 'flex:1';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = pattern.enabled;
        checkbox.dataset.idx = idx;
        checkbox.addEventListener('change', () => {
            settings.patterns[idx].enabled = checkbox.checked;
            saveSettingsDebounced();
            rebuildRegex();
            reprocessAllMessages();
        });

        const small = document.createElement('small');
        small.style.fontFamily = 'monospace';
        small.textContent = pattern.label;

        lbl.appendChild(checkbox);
        lbl.appendChild(small);
        row.appendChild(lbl);

        const isDefault = DEFAULT_PATTERNS.some(d => d.open === pattern.open && d.close === pattern.close);
        if (!isDefault) {
            const delBtn = document.createElement('div');
            delBtn.className = 'menu_button';
            delBtn.style.cssText = 'padding:2px 8px;font-size:12px';
            delBtn.title = 'Remove';
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener('click', () => {
                settings.patterns.splice(idx, 1);
                saveSettingsDebounced();
                rebuildRegex();
                renderPatternsList();
                reprocessAllMessages();
            });
            row.appendChild(delBtn);
        }

        container.appendChild(row);
    });
}

async function addExtensionControls() {
    const settingsHtml = $(`
        <div class="quote-tts-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Quote TTS</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="quote_tts_enabled">
                        <input type="checkbox" id="quote_tts_enabled">
                        <small>Enable</small>
                    </label>
                    <label class="checkbox_label" for="quote_tts_include_quotes">
                        <input type="checkbox" id="quote_tts_include_quotes">
                        <small>Include quote marks in TTS</small>
                    </label>
                    <hr>
                    <span>Enabled quote formats:</span>
                    <div id="quote_tts_patterns_list" style="display:flex;flex-direction:column;gap:4px"></div>
                    <hr>
                    <span>Add custom quote format:</span>
                    <div class="flex-container" style="gap:6px;align-items:center;margin-top:4px">
                        <input id="quote_tts_new_open" type="text" class="text_pole" placeholder="Open" style="width:60px" maxlength="4">
                        <span>...</span>
                        <input id="quote_tts_new_close" type="text" class="text_pole" placeholder="Close" style="width:60px" maxlength="4">
                        <div id="quote_tts_add_btn" class="menu_button" style="padding:4px 10px" title="Add">
                            <i class="fa-solid fa-plus"></i>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);
    $('#extensions_settings2').append(settingsHtml);

    const settings = getSettings();

    $('#quote_tts_include_quotes').prop('checked', settings.includeQuotes).on('change', function () {
        settings.includeQuotes = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#quote_tts_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        if (settings.enabled) {
            reprocessAllMessages();
        } else {
            restoreOriginalText();
            clearAllProcessed();
        }
    });

    $('#quote_tts_add_btn').on('click', () => {
        const openChar = $('#quote_tts_new_open').val().trim();
        const closeChar = $('#quote_tts_new_close').val().trim();
        if (!openChar || !closeChar) {
            toastr.warning('Please enter both open and close characters.');
            return;
        }
        const exists = settings.patterns.some(p => p.open === openChar && p.close === closeChar);
        if (exists) {
            toastr.info('This quote format already exists.');
            return;
        }
        settings.patterns.push({
            open: openChar,
            close: closeChar,
            label: `${openChar}…${closeChar}`,
            enabled: true,
        });
        saveSettingsDebounced();
        rebuildRegex();
        renderPatternsList();
        reprocessAllMessages();
        $('#quote_tts_new_open').val('');
        $('#quote_tts_new_close').val('');
    });

    renderPatternsList();
}

function onMessageRendered(messageId) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (mesEl) processMessageElement(mesEl);
}

function processAllMessages() {
    document.querySelectorAll('#chat .mes').forEach(mesEl => processMessageElement(mesEl));
}

export async function init() {
    getSettings();
    rebuildRegex();
    await addExtensionControls();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(reprocessAllMessages, 500));

    $(document).on('click', '.quote-tts-btn', function (e) {
        e.stopPropagation();
        const wrap = this.closest('.quote-tts-wrap');
        const mesEl = $(this).closest('.mes')[0];
        const charName = getCharNameFromMessage(mesEl);
        onPlayClick(wrap, charName, false);
    });

    $(document).on('click', '.quote-tts-regen', function (e) {
        e.stopPropagation();
        const wrap = this.closest('.quote-tts-wrap');
        const mesEl = $(this).closest('.mes')[0];
        const charName = getCharNameFromMessage(mesEl);
        onPlayClick(wrap, charName, true);
    });

    processAllMessages();
}
