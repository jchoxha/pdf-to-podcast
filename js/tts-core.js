// Kokoro TTS core: text normalization + phonemization + tokenization + ONNX inference.
// Adapted from kokoro-js (Apache-2.0). Environment-agnostic: caller injects ort, phonemize, vocab, and loaders.
export function createKokoro({ ort, phonemize, vocab }) {
  const splitNum = (e) => {
    if (e.includes('.')) return e;
    if (e.includes(':')) { const [a, t] = e.split(':').map(Number); return t === 0 ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`; }
    const a = parseInt(e.slice(0, 4), 10);
    if (a < 1100 || a % 1000 < 10) return e;
    const t = e.slice(0, 2), r = parseInt(e.slice(2, 4), 10), n = e.endsWith('s') ? 's' : '';
    if (a % 1000 >= 100 && a % 1000 <= 999) { if (r === 0) return `${t} hundred${n}`; if (r < 10) return `${t} oh ${r}${n}`; }
    return `${t} ${r}${n}`;
  };
  const money = (e) => {
    const a = e[0] === '$' ? 'dollar' : 'pound';
    if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${a}s`;
    if (!e.includes('.')) return `${e.slice(1)} ${a}${e.slice(1) === '1' ? '' : 's'}`;
    const [t, r] = e.slice(1).split('.'); const n = parseInt(r.padEnd(2, '0'), 10);
    return `${t} ${a}${t === '1' ? '' : 's'} and ${n} ${e[0] === '$' ? (n === 1 ? 'cent' : 'cents') : n === 1 ? 'penny' : 'pence'}`;
  };
  const pointNum = (e) => { const [a, t] = e.split('.'); return `${a} point ${t.split('').join(' ')}`; };
  const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
  const punctRe = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');
  const normalize = (e) => e
    .replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, pointNum).replace(/(?<=\d)-(?=\d)/g, ' to ').replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S").replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-').trim();

  async function toPhonemes(text, lang = 'a') {
    text = normalize(text);
    const parts = []; let last = 0;
    for (const m of text.matchAll(punctRe)) {
      if (last < m.index) parts.push({ match: false, text: text.slice(last, m.index) });
      if (m[0].length) parts.push({ match: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ match: false, text: text.slice(last) });
    const code = lang === 'a' ? 'en-us' : 'en';
    let s = (await Promise.all(parts.map(async ({ match, text }) => match ? text : (await phonemize(text, code)).join(' ')))).join('');
    s = s.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ')
      .replace(/x/g, 'k').replace(/ɬ/g, 'l').replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
    if (lang === 'a') s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
    return s.trim();
  }
  const tokenize = (ph) => { const ids = [0]; for (const ch of ph) { const id = vocab[ch]; if (id !== undefined) ids.push(id); } if (ids.length > 511) ids.length = 511; ids.push(0); return ids; };

  // Split long text into chunks that fit the 510-token context (by sentence, then by clause).
  function splitText(text, maxChars = 280) {
    const sents = text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
    const out = []; let cur = '';
    const push = (s) => { s = s.trim(); if (s) out.push(s); };
    for (let s of sents) {
      if (s.length > maxChars) {
        push(cur); cur = '';
        const clauses = s.split(/(?<=[,;:—])\s+/); let c2 = '';
        for (const c of clauses) { if ((c2 + ' ' + c).length > maxChars && c2) { push(c2); c2 = c; } else c2 = c2 ? c2 + ' ' + c : c; }
        if (c2.length > maxChars) { const w = c2.split(' '); let c3 = ''; for (const x of w) { if ((c3 + ' ' + x).length > maxChars) { push(c3); c3 = x; } else c3 = c3 ? c3 + ' ' + x : x; } push(c3); } else push(c2);
        continue;
      }
      if ((cur + s).length > maxChars && cur) { push(cur); cur = s; } else cur += s;
    }
    push(cur);
    return out;
  }

  let session = null, names = null;
  async function load(modelBytes, sessionOptions = {}) {
    session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions });
    names = { ids: session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens', out: session.outputNames[0] };
  }
  async function synthChunk(text, voiceData, speed = 1, lang = 'a') {
    const ph = await toPhonemes(text, lang);
    const ids = tokenize(ph);
    if (ids.length <= 2) return new Float32Array(0);
    const off = 256 * Math.min(Math.max(ids.length - 2, 0), 509);
    const style = voiceData.slice(off, off + 256);
    const feeds = {
      [names.ids]: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    };
    const res = await session.run(feeds);
    return res[names.out].data;
  }
  async function synth(text, voiceData, speed = 1, lang = 'a') {
    const chunks = splitText(text);
    const bufs = [];
    for (const c of chunks) bufs.push(await synthChunk(c, voiceData, speed, lang));
    const n = bufs.reduce((a, b) => a + b.length, 0); const out = new Float32Array(n); let o = 0;
    for (const b of bufs) { out.set(b, o); o += b.length; }
    return out;
  }
  return { load, synth, toPhonemes, splitText, get ready() { return !!session; } };
}
