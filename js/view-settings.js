// Settings tab: API keys, engine options, maintenance.
import { h, mount, toast } from './ui.js';
import { S, persist } from './state.js';
import { LLM_PROVIDERS, TTS_ENGINES, KOKORO_MODELS } from './config.js';
import { listModels } from './llm.js';
import { azureVoices, googleVoices, kokoro } from './tts.js';

const KEYS = [
  { id: 'gemini', label: 'Google Gemini', hint: 'Free. Used for script writing and Gemini voices.', url: LLM_PROVIDERS.gemini.keyUrl, test: (k) => listModels('gemini', k).then((m) => `${m.length} models available`) },
  { id: 'groq', label: 'Groq', hint: 'Free tier.', url: LLM_PROVIDERS.groq.keyUrl, test: (k) => listModels('groq', k).then((m) => `${m.length} models available`) },
  { id: 'openrouter', label: 'OpenRouter', hint: 'Free models available.', url: LLM_PROVIDERS.openrouter.keyUrl, test: (k) => listModels('openrouter', k).then((m) => `${m.length} free models`) },
  { id: 'anthropic', label: 'Anthropic (Claude API)', hint: 'Paid API usage. Separate from a Claude.ai subscription.', url: LLM_PROVIDERS.anthropic.keyUrl, test: (k) => listModels('anthropic', k).then((m) => `${m.length} models available`) },
  { id: 'azure', label: 'Azure Speech', hint: 'Create a Speech resource on the Free (F0) tier; copy Key 1 and its region.', url: TTS_ENGINES.azure.keyUrl, test: (k) => azureVoices(k, S.azureRegion).then((v) => `${v.length} English voices`) },
  { id: 'google', label: 'Google Cloud Text-to-Speech', hint: 'Enable the Text-to-Speech API in a Cloud project, then create an API key restricted to it.', url: TTS_ENGINES.google.keyUrl, test: (k) => googleVoices(k).then((v) => `${v.length} English voices`) },
];

export function renderSettings(root, { onChange } = {}) {
  const changed = () => { persist(); onChange?.(); };
  const keyRow = (k) => {
    const status = h('span', { class: 'small muted' });
    const inp = h('input', { type: 'password', value: S.keys[k.id] || '', placeholder: 'Paste key', autocomplete: 'off', spellcheck: 'false', onchange: (e) => { S.keys[k.id] = e.target.value.trim(); changed(); } });
    return h('div', { style: { marginBottom: '14px' } },
      h('label', { class: 'field' }, h('span', null, k.label, h('a', { href: k.url, target: '_blank', rel: 'noopener', class: 'small' }, 'Get a key')), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, inp,
        h('button', { class: 'btn small', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, 'Show'),
        h('button', { class: 'btn small', onclick: async () => { if (!S.keys[k.id]) return toast('Paste a key first'); status.textContent = 'Testing...'; try { status.textContent = 'Works: ' + (await k.test(S.keys[k.id])); } catch (e) { status.textContent = 'Failed: ' + e.message; } } }, 'Test'))),
      h('div', { class: 'small faint' }, k.hint, ' '), status);
  };
  const threadsOn = (() => { try { return localStorage.getItem('pdfpod.threads') !== 'off'; } catch { return true; } })();
  mount(root,
    h('div', { class: 'card' },
      h('h2', null, 'API keys'),
      h('p', { class: 'sub' }, 'Keys are stored only in this browser (localStorage) and are sent only to the provider they belong to. You only need keys for the services you use; Kokoro voices need none.'),
      KEYS.map(keyRow),
      h('label', { class: 'field', style: { maxWidth: '260px' } }, h('span', null, 'Azure region'), h('input', { type: 'text', value: S.azureRegion, placeholder: 'eastus', onchange: (e) => { S.azureRegion = e.target.value.trim(); changed(); } }))),
    h('div', { class: 'card' },
      h('h2', null, 'Custom / local script writer'),
      h('p', { class: 'sub' }, 'Any OpenAI-compatible endpoint. For Ollama, run it with OLLAMA_ORIGINS set to this site\'s address so the browser is allowed to call it.'),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Base URL'), h('input', { type: 'url', value: S.llm.base.custom, onchange: (e) => { S.llm.base.custom = e.target.value.trim(); changed(); } })),
        h('label', { class: 'field' }, h('span', null, 'API key (optional)'), h('input', { type: 'password', value: S.keys.custom, onchange: (e) => { S.keys.custom = e.target.value.trim(); changed(); } })))),
    h('div', { class: 'card' },
      h('h2', null, 'Script writer input budget'),
      h('p', { class: 'sub' }, 'How many tokens of material each AI call may receive. Larger selections are condensed into notes first. Lower this if a provider rejects requests as too large.'),
      h('div', { class: 'grid3' }, Object.entries(LLM_PROVIDERS).filter(([, p]) => !p.hidden).map(([id, p]) => h('label', { class: 'field' }, h('span', null, p.label.split(' (')[0]),
        h('input', { type: 'number', min: 2000, step: 1000, value: S.llm.maxInputTokens[id] || p.maxInputTokens, onchange: (e) => { S.llm.maxInputTokens[id] = +e.target.value; changed(); } }))))),
    h('div', { class: 'card' },
      h('h2', null, 'Kokoro (in-browser voices)'),
      h('label', { class: 'field', style: { maxWidth: '420px' } }, h('span', null, 'Processor'),
        h('select', { onchange: (e) => { S.tts.kokoroDevice = e.target.value; changed(); } },
          h('option', { value: 'wasm', selected: S.tts.kokoroDevice !== 'webgpu' }, `CPU (recommended, ${KOKORO_MODELS.q8.mb} MB download)`),
          h('option', { value: 'webgpu', selected: S.tts.kokoroDevice === 'webgpu', disabled: !navigator.gpu }, `GPU via WebGPU (faster on good GPUs, ${KOKORO_MODELS.fp32.mb} MB download)${navigator.gpu ? '' : ' - not supported in this browser'}`))),
      h('label', { class: 'check', style: { marginTop: '12px' } }, h('input', { type: 'checkbox', checked: threadsOn, onchange: (e) => { try { localStorage.setItem('pdfpod.threads', e.target.checked ? 'on' : 'off'); } catch {} toast('Reloading to apply...'); setTimeout(() => location.reload(), 600); } }), 'Use all CPU cores (multithreading)'),
      h('p', { class: 'small muted' }, `Status: ${self.crossOriginIsolated ? 'multithreading active' : 'single-threaded'}${kokoro.info ? ` · model loaded on ${kokoro.info.device}, ${kokoro.info.threads} thread(s)` : ''}.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await kokoro.init({ device: S.tts.kokoroDevice }, (p) => { b.textContent = p.cached ? 'Loading from cache...' : `Downloading ${Math.round(p.got / 1e6)}/${Math.round(p.total / 1e6)} MB`; }); b.textContent = 'Model ready'; renderSettings(root, { onChange }); } catch (err) { toast(err.message, 6000); b.textContent = 'Download voice model now'; b.disabled = false; } } }, 'Download voice model now'),
        h('button', { class: 'btn small', onclick: async () => { try { await caches.delete('pdfpod-models-v1'); toast('Cached model removed'); } catch (e) { toast(e.message); } } }, 'Remove cached model'))),
    h('div', { class: 'card' },
      h('h2', null, 'Gemini voices'),
      h('label', { class: 'field', style: { maxWidth: '420px' } }, h('span', null, 'TTS model id'), h('input', { type: 'text', list: 'gtts', value: S.tts.geminiTtsModel, onchange: (e) => { S.tts.geminiTtsModel = e.target.value.trim(); changed(); } }),
        h('datalist', { id: 'gtts' }, ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'].map((m) => h('option', { value: m })))),
      h('p', { class: 'small muted' }, 'Model names change over time. If requests fail, use "Load available models" on the Create tab with Gemini selected, and pick one ending in "tts".')),
    h('div', { class: 'card' },
      h('h2', null, 'Reset'),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm('Reset all settings (including saved keys) to defaults? Your Library and usage history are kept.')) { localStorage.removeItem('pdfpod.settings.v1'); location.reload(); } } }, 'Reset settings')));
}
