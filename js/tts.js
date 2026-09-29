// Voice engines: Kokoro (in-browser), Gemini TTS, Azure, Google Cloud TTS.
import { KOKORO_MODELS, KOKORO_VOICE_URLS, KOKORO_VOCAB, TTS_ENGINES, ORT_WASM_URL } from './config.js';
import { decodeWav, resample, b64ToBytes, pcm16ToFloat, SR } from './audio.js';
import { record, setLive, parseGeminiQuota } from './usage.js';
import { lsGet, lsSet } from './store.js';

const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
const esc = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ---------------- Kokoro ----------------
export function parseBlend(spec) {
  // "af_heart" or "af_heart:0.7,bf_emma:0.3"
  return String(spec || 'af_heart').split(',').map((p) => { const [id, w] = p.split(':'); return { id: id.trim(), w: w == null ? 1 : +w }; }).filter((x) => x.id);
}
export function blendLabel(spec) { const b = parseBlend(spec); return b.length === 1 ? b[0].id : b.map((x) => `${x.id} ${Math.round(x.w * 100)}%`).join(' + '); }

class KokoroEngine {
  constructor() { this.worker = null; this.ready = null; this.seq = 0; this.pending = new Map(); this.info = null; }
  _post(msg, onProgress) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress }); this.worker.postMessage({ ...msg, id }); });
  }
  init(opts = {}, onProgress) {
    const device = opts.device === 'webgpu' && navigator.gpu ? 'webgpu' : 'wasm';
    const key = device;
    if (this.ready && this.readyKey === key) return this.ready;
    this.worker?.terminate();
    this.worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id); if (!p) return;
      if (data.type === 'progress') { p.onProgress?.(data); return; }
      this.pending.delete(data.id);
      data.type === 'error' ? p.rej(new Error(data.error)) : p.res(data);
    };
    this.worker.onerror = (e) => { for (const p of this.pending.values()) p.rej(new Error('Voice engine crashed: ' + (e.message || 'unknown'))); this.pending.clear(); this.ready = null; };
    const model = device === 'webgpu' ? KOKORO_MODELS.fp32 : KOKORO_MODELS.q8;
    this.readyKey = key;
    this.ready = this._post({ type: 'init', ortUrl: new URL('../vendor/ort/ort.webgpu.min.mjs', import.meta.url).href, wasmBase: { mjs: new URL('../vendor/ort/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href, wasm: ORT_WASM_URL }, modelUrl: model.url, device, vocab: KOKORO_VOCAB, maxThreads: opts.maxThreads || 8 }, onProgress)
      .then((r) => { this.info = r; return r; })
      .catch(async (e) => {
        this.ready = null;
        if (device === 'webgpu') { console.warn('WebGPU failed, falling back to CPU', e); return this.init({ ...opts, device: 'wasm' }, onProgress); }
        throw e;
      });
    return this.ready;
  }
  async synth(text, voiceSpec, speed = 1) {
    await this.ready;
    const voice = parseBlend(voiceSpec);
    const lang = voice[0].id[0] === 'b' ? 'b' : 'a';
    const urls = KOKORO_VOICE_URLS.map((f) => f('{id}'));
    const r = await this._post({ type: 'synth', text, voice, speed, lang, voiceUrls: urls });
    const audioSec = r.audio.length / SR;
    // keep a running real-time factor for future time estimates
    const rtf = r.ms / 1000 / Math.max(audioSec, 0.5);
    const prev = lsGet('pdfpod.kokoro.rtf', null); lsSet('pdfpod.kokoro.rtf', prev ? prev * 0.8 + rtf * 0.2 : rtf);
    record({ service: 'tts:kokoro', requests: 0, model: this.info?.device || 'wasm', chars: text.length, audioSec, ms: r.ms });
    return r.audio;
  }
}
export const kokoro = new KokoroEngine();
export const kokoroRtf = () => lsGet('pdfpod.kokoro.rtf', null);

// ---------------- Gemini TTS ----------------
async function geminiTTS({ key, model, lines, voices, style, signal }) {
  // lines: [{speaker, text}] ; voices: {speakerName: voiceName}; up to 2 distinct speakers per request
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const multi = speakers.length > 1;
  const chars = lines.reduce((a, l) => a + l.text.length, 0);
  const t0 = performance.now();
  // Interactions API (current)
  const body = {
    model,
    input: [{ type: 'user_input', content: multi
      ? lines.map((l) => ({ type: 'text', text: l.text, annotations: [{ type: 'speech_metadata', speaker: l.speaker, ...(style ? { style } : {}) }] }))
      : [{ type: 'text', text: lines.map((l) => l.text).join('\n'), annotations: [{ type: 'speech_metadata', ...(style ? { style } : {}) }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: multi ? { mode: 'conversational', speakers: speakers.map((s) => ({ speaker: s, voice: voices[s] })) } : [{ voice: voices[speakers[0]] }] },
  };
  let res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  let audio = null;
  if (res.ok) {
    const d = await res.json();
    const parts = (d.steps || d.outputs || []).flatMap((s) => s.content || []).filter((c) => c.type === 'audio' && c.data);
    const last = parts[parts.length - 1];
    if (last) { const w = decodeWav(b64ToBytes(last.data)); audio = resample(w.data, last.sample_rate || w.rate); }
    record({ service: 'tts:gemini', model, chars, inTok: d.usage?.total_input_tokens || 0, outTok: d.usage?.total_output_tokens || 0, audioSec: audio ? audio.length / SR : 0, ms: performance.now() - t0 });
    if (!audio) throw new Error('Gemini TTS returned no audio.');
    setLive('tts:gemini', { exhausted: false });
    return audio;
  }
  if (res.status !== 404 && res.status !== 400) throw await geminiTtsError(res);
  // Fallback: classic generateContent TTS format
  const prompt = multi ? `${style ? style + '\n' : ''}${lines.map((l) => `${l.speaker}: ${l.text}`).join('\n')}` : (style ? `Say ${style}: ` : '') + lines.map((l) => l.text).join('\n');
  const body2 = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: multi
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map((s) => ({ speaker: s, voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[s] } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[speakers[0]] } } } } };
  res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body2) });
  if (!res.ok) throw await geminiTtsError(res);
  const d = await res.json();
  const inline = d.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline) throw new Error('Gemini TTS returned no audio.');
  const bytes = b64ToBytes(inline.data);
  const rate = +(inline.mimeType?.match(/rate=(\d+)/)?.[1] || SR);
  audio = /wav/.test(inline.mimeType || '') ? resample(decodeWav(bytes).data, rate) : resample(pcm16ToFloat(bytes), rate);
  const u = d.usageMetadata || {};
  record({ service: 'tts:gemini', model, chars, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0, audioSec: audio.length / SR, ms: performance.now() - t0 });
  return audio;
}
async function geminiTtsError(res) {
  let body = null, text = ''; try { text = await res.text(); body = JSON.parse(text); } catch {}
  const msg = body?.error?.message || text.slice(0, 300);
  record({ service: 'tts:gemini', requests: 1, failed: true, kind: 'error' });
  if (res.status === 429) {
    const q = parseGeminiQuota(body); const perDay = /PerDay/i.test(q.quotaId || '') || /per.?day/i.test(msg);
    setLive('tts:gemini', { lastError: msg.slice(0, 200), learnedLimit: q.limit, exhausted: perDay });
    const e = new Error(perDay ? `Gemini TTS daily free quota reached${q.limit ? ` (limit ${q.limit}/day)` : ''}.` : 'Gemini TTS rate limited: ' + msg);
    if (!perDay) e.retryAfterSec = q.retrySec ?? 30; e.quota = perDay; return e;
  }
  return new Error(`Gemini TTS error ${res.status}: ${msg}`);
}

// ---------------- Azure ----------------
async function azureTTS({ key, region, lines, voices, speeds, signal }) {
  const chars = lines.reduce((a, l) => a + l.text.length, 0);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${lines.map((l) => {
    const rate = Math.round(((speeds[l.speaker] || 1) - 1) * 100);
    return `<voice name="${esc(voices[l.speaker])}">${rate ? `<prosody rate="${rate >= 0 ? '+' : ''}${rate}%">` : ''}${esc(l.text)}${rate ? '</prosody>' : ''}<break time="250ms"/></voice>`;
  }).join('')}</speak>`;
  const t0 = performance.now();
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', signal,
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm' }, body: ssml });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    record({ service: 'tts:azure', requests: 1, failed: true, kind: 'error' });
    const e = new Error(res.status === 401 ? 'Azure rejected the key or region.' : `Azure TTS error ${res.status}: ${t.slice(0, 200)}`);
    if (res.status === 429) { e.retryAfterSec = +res.headers.get('retry-after') || 20; setLive('tts:azure', { lastError: 'Rate limited (429)' }); }
    throw e;
  }
  const w = decodeWav(new Uint8Array(await res.arrayBuffer()));
  const audio = resample(w.data, w.rate);
  record({ service: 'tts:azure', chars, audioSec: audio.length / SR, ms: performance.now() - t0 });
  return audio;
}
export async function azureVoices(key, region) {
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': key } });
  if (!res.ok) throw new Error(`Azure voice list failed (${res.status}). Check key and region.`);
  return (await res.json()).filter((v) => v.Locale.startsWith('en-')).map((v) => ({ id: v.ShortName, name: `${v.DisplayName} (${v.Locale}, ${v.Gender})`, desc: v.VoiceType }));
}

// ---------------- Google Cloud ----------------
export function googleTier(name) {
  if (/Chirp/i.test(name)) return 'Chirp3-HD';
  if (/Studio/i.test(name)) return 'Studio';
  if (/Neural2|News|Casual|Polyglot/i.test(name)) return 'Neural2';
  if (/Wavenet/i.test(name)) return 'WaveNet';
  return 'Standard';
}
async function googleTTS({ key, text, voice, speed, signal }) {
  const t0 = performance.now();
  const audioConfig = { audioEncoding: 'LINEAR16', sampleRateHertz: SR };
  if (speed && speed !== 1) audioConfig.speakingRate = speed;
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ input: { text }, voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice }, audioConfig }) });
  const svc = 'tts:google:' + googleTier(voice);
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).error?.message; } catch {}
    record({ service: svc, requests: 1, failed: true, kind: 'error' });
    const e = new Error(`Google TTS error ${res.status}: ${msg || ''}`); if (res.status === 429) e.retryAfterSec = 20; throw e;
  }
  const d = await res.json();
  const w = decodeWav(b64ToBytes(d.audioContent));
  const audio = resample(w.data, w.rate);
  record({ service: svc, model: voice, chars: text.length, audioSec: audio.length / SR, ms: performance.now() - t0 });
  return audio;
}
export async function googleVoices(key) {
  const res = await fetch('https://texttospeech.googleapis.com/v1/voices?languageCode=en', { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(`Google voice list failed (${res.status}). Is the Text-to-Speech API enabled for this key?`);
  return ((await res.json()).voices || []).filter((v) => v.languageCodes.some((c) => c.startsWith('en'))).map((v) => ({ id: v.name, name: `${v.name} (${v.ssmlGender?.toLowerCase()})`, desc: googleTier(v.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------- Unified rendering ----------------
// Groups lines into requests per engine. Returns [{from, to, lines}]
export function planRequests(engine, lines, speakerCount) {
  const units = [];
  if (engine === 'kokoro' || engine === 'google') { lines.forEach((l, i) => units.push({ from: i, to: i, lines: [l] })); return units; }
  const maxChars = engine === 'gemini' ? 2400 : 3500, maxLines = engine === 'gemini' ? 60 : 40;
  let cur = null;
  lines.forEach((l, i) => {
    const sps = cur ? new Set([...cur.lines.map((x) => x.speaker), l.speaker]) : null;
    const tooBig = cur && (cur.chars + l.text.length > maxChars || cur.lines.length >= maxLines || (engine === 'gemini' && sps.size > 2));
    if (!cur || tooBig) { cur = { from: i, to: i, lines: [], chars: 0 }; units.push(cur); }
    cur.lines.push(l); cur.to = i; cur.chars += l.text.length;
  });
  return units;
}

// cfg: {engine, keys, geminiModel, azureRegion, speakers:[{name, voice:{kokoro,gemini,azure,google}, speed}], kokoroDevice}
export async function renderUnit(unit, cfg, signal, onStatus = () => {}) {
  const voices = {}, speeds = {};
  for (const s of cfg.speakers) { voices[s.name] = s.voices[cfg.engine]; speeds[s.name] = s.speed || 1; }
  for (let attempt = 0; ; attempt++) {
    try {
      if (cfg.engine === 'kokoro') { const l = unit.lines[0]; return await kokoro.synth(l.text, voices[l.speaker], speeds[l.speaker]); }
      if (cfg.engine === 'google') { const l = unit.lines[0]; return await googleTTS({ key: cfg.keys.google, text: l.text, voice: voices[l.speaker], speed: speeds[l.speaker], signal }); }
      if (cfg.engine === 'azure') return await azureTTS({ key: cfg.keys.azure, region: cfg.azureRegion, lines: unit.lines, voices, speeds, signal });
      if (cfg.engine === 'gemini') return await geminiTTS({ key: cfg.keys.gemini, model: cfg.geminiTtsModel, lines: unit.lines, voices, style: cfg.geminiStyle, signal });
      throw new Error('Unknown voice engine');
    } catch (e) {
      if (e.name === 'AbortError' || e.retryAfterSec == null || attempt >= 4) throw e;
      for (let s = Math.ceil(Math.min(90, e.retryAfterSec)); s > 0; s--) { onStatus(`Rate limited. Retrying in ${s}s...`); await sleep(1000, signal); }
    }
  }
}

export async function previewVoice(engine, voice, cfg, name = 'your host') {
  const text = `Hi, I'm ${name}. Let's break this chapter down together, one big idea at a time.`;
  const speaker = { name: 'P', voices: { [engine]: voice }, speed: cfg.speed || 1 };
  if (engine === 'kokoro') await kokoro.init({ device: cfg.kokoroDevice }, cfg.onProgress);
  return renderUnit({ lines: [{ speaker: 'P', text }] }, { ...cfg, engine, speakers: [speaker] });
}

export const engineNeedsKey = (e) => TTS_ENGINES[e]?.needsKey;
