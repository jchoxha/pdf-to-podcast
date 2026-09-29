// Audio helpers: PCM decode/encode, loudness matching, assembling the episode, MP3 export.
export const SR = 24000;

export function pcm16ToFloat(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}
// Parse a WAV (RIFF) file into mono Float32 at its native rate
export function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF') return { data: pcm16ToFloat(bytes), rate: SR };
  let o = 12, rate = SR, ch = 1, bits = 16;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o); let size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
    if (id === 'data') {
      if (size === 0 || size === 0xffffffff || o + 8 + size > bytes.byteLength) size = bytes.byteLength - o - 8;
      let pcm = pcm16ToFloat(bytes.subarray(o + 8, o + 8 + size));
      if (bits !== 16) console.warn('Unexpected WAV bit depth', bits);
      if (ch > 1) { const m = new Float32Array(Math.floor(pcm.length / ch)); for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < ch; c++) s += pcm[i * ch + c]; m[i] = s / ch; } pcm = m; }
      return { data: pcm, rate };
    }
    o += 8 + size + (size & 1);
  }
  return { data: new Float32Array(0), rate };
}
export function resample(data, from, to = SR) {
  if (from === to) return data;
  const ratio = from / to; const n = Math.floor(data.length / ratio); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i * ratio; const i0 = Math.floor(x); const f = x - i0; out[i] = (data[i0] || 0) * (1 - f) + (data[i0 + 1] || 0) * f; }
  return out;
}
export function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

// Trim near-silence at the edges and match loudness to a target RMS.
export function tidy(data, targetRms = 0.085) {
  const th = 0.008; let a = 0, b = data.length - 1;
  while (a < b && Math.abs(data[a]) < th) a++;
  while (b > a && Math.abs(data[b]) < th) b--;
  a = Math.max(0, a - 480); b = Math.min(data.length - 1, b + 1200);
  const d = data.slice(a, b + 1);
  let s = 0, n = 0; for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) > 0.02) { s += d[i] * d[i]; n++; } }
  const rms = n ? Math.sqrt(s / n) : 0;
  if (rms > 0) { const g = Math.min(4, targetRms / rms); for (let i = 0; i < d.length; i++) d[i] = Math.max(-0.98, Math.min(0.98, d[i] * g)); }
  return d;
}

// Build episode from per-line clips. Returns {data, marks:[{start,end}]}
export function assemble(clips, speakers) {
  const gap = (prev, cur) => (prev == null ? 0 : prev === cur ? 0.18 : 0.32);
  let total = 0; const marks = []; let prevSp = null;
  for (const c of clips) { total += Math.round(gap(prevSp, c.speaker) * SR) + (c.data?.length || 0); prevSp = c.speaker; }
  total += SR * 0.6;
  const out = new Float32Array(total); let o = 0; prevSp = null;
  for (const c of clips) {
    o += Math.round(gap(prevSp, c.speaker) * SR); prevSp = c.speaker;
    const start = o / SR; if (c.data) { out.set(c.data, o); o += c.data.length; }
    marks.push({ start, end: o / SR });
  }
  return { data: out, marks };
}

export function encodeWav(data, rate = SR) {
  const b = new ArrayBuffer(44 + data.length * 2); const v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), true);
  return new Blob([b], { type: 'audio/wav' });
}

let lameLoaded = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return lameLoaded ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('../vendor/lame.min.js', import.meta.url).href; s.onload = res; s.onerror = () => rej(new Error('Could not load MP3 encoder')); document.head.appendChild(s); });
}
export async function encodeMp3(data, rate = SR, kbps = 64, onProgress = () => {}) {
  await loadLame();
  const enc = new window.lamejs.Mp3Encoder(1, rate, kbps);
  const block = 1152 * 20; const parts = [];
  const pcm = new Int16Array(block);
  for (let i = 0; i < data.length; i += block) {
    const n = Math.min(block, data.length - i); const chunk = n === block ? pcm : new Int16Array(n);
    for (let j = 0; j < n; j++) chunk[j] = Math.max(-32768, Math.min(32767, Math.round(data[i + j] * 32767)));
    const buf = enc.encodeBuffer(chunk); if (buf.length) parts.push(new Uint8Array(buf));
    if ((i / block) % 40 === 0) { onProgress(i / data.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

// Minimal store-only ZIP writer (for bundling mp3 + transcript where direct downloads are restricted)
export async function zip(files) {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = crcT[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const enc = new TextEncoder(); const chunks = []; const central = []; let off = 0;
  for (const f of files) {
    const data = f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name); const c = crc(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(h.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint32(16, c, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), name); off += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
