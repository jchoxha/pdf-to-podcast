// Web Worker that runs the Kokoro voice model off the main thread.
import { createKokoro } from './tts-core.js';
import { phonemize } from '../vendor/phonemizer.js';

let k = null, ort = null;
const voiceBins = new Map();
const blends = new Map();

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open('pdfpod-models-v1'); const hit = await cache.match(url); if (hit) { onProgress?.(1, 1, true); return new Uint8Array(await hit.arrayBuffer()); } } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = +res.headers.get('content-length') || 0;
  let bytes;
  if (res.body && total) {
    const reader = res.body.getReader(); bytes = new Uint8Array(total); let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (got + value.length > bytes.length) { const nb = new Uint8Array(Math.max(bytes.length * 2, got + value.length)); nb.set(bytes); bytes = nb; } bytes.set(value, got); got += value.length; onProgress?.(got, total); }
    bytes = bytes.subarray(0, got);
  } else bytes = new Uint8Array(await res.arrayBuffer());
  try { await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { console.warn('cache put failed', e); }
  return bytes;
}

async function voiceData(spec, urls) {
  // spec: [{id, w}] ; returns blended Float32Array (510*256)
  const key = JSON.stringify(spec);
  if (blends.has(key)) return blends.get(key);
  const parts = [];
  for (const { id, w } of spec) {
    if (!voiceBins.has(id)) {
      let last;
      for (const u of urls) { try { const b = await cachedFetch(u.replace('{id}', id)); voiceBins.set(id, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); break; } catch (e) { last = e; } }
      if (!voiceBins.has(id)) throw last || new Error('voice download failed: ' + id);
    }
    parts.push({ v: voiceBins.get(id), w });
  }
  const sum = parts.reduce((a, p) => a + p.w, 0) || 1;
  const out = new Float32Array(parts[0].v.length);
  for (const { v, w } of parts) for (let i = 0; i < out.length; i++) out[i] += v[i] * (w / sum);
  blends.set(key, out);
  return out;
}

self.onmessage = async ({ data: m }) => {
  const reply = (msg, transfer) => self.postMessage({ id: m.id, ...msg }, transfer || []);
  try {
    if (m.type === 'init') {
      ort = await import(m.ortUrl);
      const threads = self.crossOriginIsolated ? Math.max(1, Math.min(m.maxThreads || 8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
      ort.env.wasm.numThreads = threads;
      if (m.wasmBase) ort.env.wasm.wasmPaths = m.wasmBase;
      const bytes = await cachedFetch(m.modelUrl, (got, total, cached) => self.postMessage({ id: m.id, type: 'progress', got, total, cached }));
      k = createKokoro({ ort, phonemize, vocab: m.vocab });
      await k.load(bytes, { executionProviders: [m.device === 'webgpu' ? 'webgpu' : 'wasm'] });
      reply({ type: 'ready', threads, device: m.device });
    } else if (m.type === 'synth') {
      if (!k) throw new Error('Voice model not loaded');
      const v = await voiceData(m.voice, m.voiceUrls);
      const t0 = performance.now();
      const audio = await k.synth(m.text, v, m.speed || 1, m.lang || 'a');
      const out = new Float32Array(audio);
      reply({ type: 'audio', audio: out, ms: performance.now() - t0 }, [out.buffer]);
    }
  } catch (e) {
    reply({ type: 'error', error: String(e?.message || e) });
  }
};
