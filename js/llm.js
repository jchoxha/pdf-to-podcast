// Script-writer providers. Every call is recorded in the usage ledger.
import { LLM_PROVIDERS, TOKENS_PER_CHAR } from './config.js';
import { record, setLive, parseGeminiQuota } from './usage.js';
import { h } from './ui.js';

export class QuotaError extends Error { constructor(msg, info) { super(msg); this.name = 'QuotaError'; this.info = info; } }
const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true }); });

let claudeSample = null;
export async function detectClaudeAi() {
  try { if (window.claude?.use) { claudeSample = await window.claude.use('sample'); } } catch { claudeSample = null; }
  return !!claudeSample;
}

const lastCall = {};
async function pace(provider, signal) {
  const gap = LLM_PROVIDERS[provider]?.minGapMs || 0;
  const wait = (lastCall[provider] || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastCall[provider] = Date.now();
}

// opts: {provider, model, key, base, system, prompt, json, maxTokens, temperature, signal, onStatus}
export async function complete(opts) {
  const { provider, signal, onStatus = () => {} } = opts;
  for (let attempt = 0; attempt < 5; attempt++) {
    await pace(provider, signal);
    const t0 = performance.now();
    try {
      const r = await callProvider(opts);
      record({ service: 'llm:' + provider, model: opts.model, inTok: r.inTok, outTok: r.outTok, ms: performance.now() - t0, kind: opts.kind || 'script' });
      return r;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.retryAfterSec != null && attempt < 4) {
        record({ service: 'llm:' + provider, model: opts.model, requests: 1, failed: true, ms: performance.now() - t0, kind: 'rate-limited' });
        const wait = Math.min(Math.max(e.retryAfterSec, 5), 90);
        for (let s = Math.ceil(wait); s > 0; s--) { onStatus(`Rate limited by ${LLM_PROVIDERS[provider].label}. Retrying in ${s}s...`); await sleep(1000, signal); }
        continue;
      }
      throw e;
    }
  }
  throw new Error('Too many retries');
}

async function httpError(res, provider) {
  let body = null, text = '';
  try { text = await res.text(); body = JSON.parse(text); } catch {}
  const msg = body?.error?.message || body?.message || text.slice(0, 300) || res.statusText;
  if (res.status === 429) {
    if (provider === 'gemini') {
      const q = parseGeminiQuota(body);
      const perDay = /PerDay/i.test(q.quotaId || '') || /per.?day/i.test(msg);
      setLive('llm:gemini', { lastError: msg.slice(0, 200), learnedLimit: q.limit, quotaId: q.quotaId, exhausted: perDay });
      if (perDay) return new QuotaError(`Gemini daily free quota reached${q.limit ? ` (limit ${q.limit}/day)` : ''}. Try again tomorrow or switch model/provider.`, q);
      const e = new Error(msg); e.retryAfterSec = q.retrySec ?? 30; return e;
    }
    const ra = parseFloat(res.headers.get('retry-after'));
    const e = new Error(msg); e.retryAfterSec = isNaN(ra) ? 20 : ra;
    if (/per day|daily|free-models-per-day/i.test(msg)) return new QuotaError(`${LLM_PROVIDERS[provider].label}: daily limit reached. ${msg}`, {});
    return e;
  }
  if (res.status === 401 || res.status === 403) return new Error(`${LLM_PROVIDERS[provider].label} rejected the API key (${res.status}). ${msg}`);
  return new Error(`${LLM_PROVIDERS[provider].label} error ${res.status}: ${msg}`);
}

function readGroqHeaders(res) {
  const h = (n) => res.headers.get(n);
  const lr = h('x-ratelimit-limit-requests');
  if (lr != null) setLive('llm:groq', { limitRequestsDay: +lr, remainingRequestsDay: +h('x-ratelimit-remaining-requests'),
    limitTokensMin: +h('x-ratelimit-limit-tokens'), remainingTokensMin: +h('x-ratelimit-remaining-tokens'), resetRequests: h('x-ratelimit-reset-requests') });
}

// Copy & paste mode: show the prompt, let the user run it in their own chat AI, and wait for the pasted reply.
// check(text) -> number of dialogue lines recognised, shown live so a bad paste is obvious before continuing.
function askUser(prompt, { chatUrl, check, signal }) {
  return new Promise((resolve, reject) => {
    const est = (s) => Math.round(s.length * TOKENS_PER_CHAR);
    const finish = (fn) => { signal?.removeEventListener('abort', onAbort); m.remove(); fn(); };
    const cancel = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const onAbort = () => cancel();
    const promptBox = h('textarea', { rows: 7, readonly: true, value: prompt, style: { width: '100%', fontSize: '12px' } });
    const copyBtn = h('button', { class: 'btn primary', onclick: async () => {
      try { await navigator.clipboard.writeText(prompt); } catch { promptBox.select(); document.execCommand('copy'); }
      copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2000);
    } }, 'Copy prompt');
    const status = h('span', { class: 'small muted' }, 'Nothing pasted yet.');
    const useBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => finish(() => resolve(replyBox.value)) }, 'Use this script');
    const replyBox = h('textarea', { rows: 9, placeholder: 'Paste the AI\'s full reply here...', style: { width: '100%' }, oninput: () => {
      const t = replyBox.value.trim(); const n = t && check ? check(t) : 0;
      useBtn.disabled = !t;
      status.textContent = !t ? 'Nothing pasted yet.' : check ? (n ? `${n} dialogue lines recognised.` : 'No "Name: text" dialogue lines recognised yet. Check the speaker names match.') : `${t.length.toLocaleString()} characters pasted.`;
      status.className = 'small' + (check && t && !n ? '' : ' muted'); status.style.color = check && t && !n ? 'var(--warn)' : '';
    } });
    const m = h('div', { class: 'modal' },
      h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Write the script with your own AI' },
        h('div', { class: 'row between' }, h('h2', { style: { margin: 0, fontSize: '18px' } }, 'Write the script with your own AI'), h('button', { class: 'btn ghost small', onclick: cancel, 'aria-label': 'Cancel' }, 'Cancel')),
        h('p', { class: 'small muted' }, `1. Copy the prompt (~${est(prompt).toLocaleString()} tokens) and paste it into a new chat in Claude, ChatGPT, Gemini or any other AI. 2. Paste its whole reply below. If the reply gets cut off, ask it to "continue" and paste both parts.`),
        promptBox,
        h('div', { class: 'row', style: { marginTop: '8px' } }, copyBtn, chatUrl ? h('a', { class: 'btn', href: chatUrl, target: '_blank', rel: 'noopener' }, 'Open Claude') : null),
        h('h3', { style: { marginTop: '16px' } }, 'Paste the reply'),
        replyBox,
        h('div', { class: 'row', style: { marginTop: '8px' } }, status, h('span', { class: 'spacer' }), useBtn)));
    signal?.addEventListener('abort', onAbort, { once: true });
    document.body.append(m);
    promptBox.scrollTop = 0;
  });
}

async function callProvider({ provider, model, key, base, system, prompt, json, maxTokens = 8192, temperature = 0.9, signal, onText, check }) {
  const P = LLM_PROVIDERS[provider];
  if (P.needsKey && !key) throw new Error(`Add your ${P.label} API key in Settings.`);

  if (P.manual) {
    const full = (system ? system + '\n\n' : '') + prompt;
    const text = await askUser(full, { chatUrl: P.chatUrl, check, signal });
    const est = (s) => Math.round(s.length * TOKENS_PER_CHAR);
    return { text, truncated: false, inTok: est(full), outTok: est(text), estimated: true };
  }

  if (provider === 'gemini') {
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
    if (!res.ok) throw await httpError(res, provider);
    const d = await res.json();
    const c = d.candidates?.[0];
    const text = (c?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
    if (!text) throw new Error(`Gemini returned no text (${c?.finishReason || d.promptFeedback?.blockReason || 'unknown reason'}).`);
    const u = d.usageMetadata || {};
    setLive('llm:gemini', { exhausted: false });
    return { text, truncated: c?.finishReason === 'MAX_TOKENS', inTok: u.promptTokenCount || 0, outTok: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, temperature, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) throw await httpError(res, provider);
    const d = await res.json();
    const text = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, truncated: d.stop_reason === 'max_tokens', inTok: d.usage?.input_tokens || 0, outTok: d.usage?.output_tokens || 0 };
  }

  if (provider === 'claudeai') {
    if (!claudeSample) throw new Error('Claude (your plan) is only available when this app runs inside claude.ai.');
    const full = (system ? system + '\n\n' : '') + prompt;
    try {
      const r = await claudeSample(full, { modelTier: model || 'default', signal, cache: false, onText: onText ? ({ text }) => onText(text) : undefined });
      const est = (s) => Math.round(s.length * TOKENS_PER_CHAR);
      return { text: r.text, truncated: r.truncated, inTok: est(full), outTok: est(r.text), estimated: true };
    } catch (e) { const err = new Error('Claude: ' + (e.message || e.code)); if (e.code === 'rate_limited') err.retryAfterSec = 30; throw err; }
  }

  // OpenAI-compatible (groq, openrouter, custom)
  const url = (base || P.base).replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'PDF to Podcast'; }
  const body = { model, temperature, max_tokens: maxTokens,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] };
  if (json && provider !== 'custom') body.response_format = { type: 'json_object' };
  if (/gpt-oss/.test(model) && provider === 'groq') body.reasoning_effort = 'low';
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (provider === 'groq') readGroqHeaders(res);
  if (!res.ok) throw await httpError(res, provider);
  const d = await res.json();
  const text = d.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${P.label} returned an empty reply.`);
  const est = (s) => Math.round(s.length * TOKENS_PER_CHAR);
  return { text, truncated: d.choices?.[0]?.finish_reason === 'length',
    inTok: d.usage?.prompt_tokens ?? est(prompt + (system || '')), outTok: d.usage?.completion_tokens ?? est(text) };
}

export async function listModels(provider, key, base) {
  const P = LLM_PROVIDERS[provider];
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await httpError(res, provider);
    const d = await res.json();
    return (d.models || []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace('models/', ''));
  }
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    if (!res.ok) throw await httpError(res, provider);
    return ((await res.json()).data || []).map((m) => m.id);
  }
  if (provider === 'claudeai' || P.manual) return P.models;
  const res = await fetch((base || P.base).replace(/\/$/, '') + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
  if (!res.ok) throw await httpError(res, provider);
  const d = await res.json();
  let ids = (d.data || []).map((m) => m.id);
  if (provider === 'openrouter') ids = ['openrouter/free', ...(d.data || []).filter((m) => m.id.endsWith(':free') || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0)).map((m) => m.id)];
  return [...new Set(ids)];
}

export async function openRouterKeyInfo(key) {
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) throw await httpError(res, 'openrouter');
  const d = (await res.json()).data || {};
  setLive('llm:openrouter', { keyUsage: d.usage, keyLimit: d.limit, isFreeTier: d.is_free_tier });
  return d;
}
