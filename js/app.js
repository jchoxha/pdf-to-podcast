// Main app: Create tab (source -> episode -> script -> audio) and tab routing.
import { LLM_PROVIDERS, TTS_ENGINES, KOKORO_VOICES, GEMINI_VOICES, PERSONALITY_PRESETS, STYLE_OPTIONS, DEPTH_PRESETS, WORDS_PER_MIN, KOKORO_MODELS } from './config.js';
import { S, R, persist, activeSpeakers, llmConfig, ttsConfig } from './state.js';
import { h, mount, toast, download, fmtInt, fmtK, fmtDur, fmtClock, slug, debounce, modal, meter } from './ui.js';
import { loadPdf, parseRanges, rangesToString, extractText, quickWordCount, pageLabel } from './pdf.js';
import { generateScript, parseScript, scriptWords } from './scriptgen.js';
import { detectClaudeAi, QuotaError } from './llm.js';
import { kokoro, planRequests, renderUnit, previewVoice, parseBlend, azureVoices, googleVoices } from './tts.js';
import { tidy, assemble, encodeWav, encodeMp3, SR } from './audio.js';
import { startRun, endRun, summarizeRun, onUsageChange, labelFor, getLimits } from './usage.js';
import { saveEpisode } from './store.js';
import { estimateScript, estimateAudio } from './estimate.js';
import { renderUsage, saveRunSummary } from './view-usage.js';
import { renderSettings } from './view-settings.js';
import { renderLibrary } from './view-library.js';

const el = {};
const SPK_CLASS = (i) => 'sp' + (i % 4);

// ---------------- Tabs ----------------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'usage') renderUsage(document.getElementById('tab-usage'));
  if (name === 'settings') renderSettings(document.getElementById('tab-settings'), { onChange: () => { renderEpisode(); } });
  if (name === 'library') renderLibrary(document.getElementById('tab-library'), { openEpisode });
  window.scrollTo({ top: 0 });
}
export { showTab };

// ---------------- Create tab skeleton ----------------
function initCreate() {
  const root = document.getElementById('tab-create');
  el.source = h('div', { class: 'card', id: 'c-source' });
  el.episode = h('div', { class: 'card', id: 'c-episode' });
  el.script = h('div', { class: 'card hidden', id: 'c-script' });
  el.audio = h('div', { class: 'card hidden', id: 'c-audio' });
  mount(root, el.source, el.episode, el.script, el.audio);
  renderSource(); renderEpisode(); renderScript(); renderAudio();
}

// ---------------- 1. Source ----------------
function renderSource() {
  const card = el.source;
  if (!R.pdf) {
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden', onchange: (e) => e.target.files[0] && openPdf(e.target.files[0]) });
    const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => input.click(), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && input.click(),
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) openPdf(f); } },
      h('strong', null, 'Drop a textbook PDF here'), h('span', { class: 'muted' }, 'or click to choose a file. It stays on your computer; only the text you select is sent to the script writer.'));
    return mount(card, h('h2', null, h('span', { class: 'step' }, '1'), 'Choose your material'), h('p', { class: 'sub' }, 'Pick a PDF, then choose chapters, sections or pages.'), drop, input);
  }
  const pdf = R.pdf;
  const pagesInput = h('input', { type: 'text', value: R.pagesText, placeholder: 'e.g. 45-72, 80', oninput: debounce((e) => { R.pagesText = e.target.value; R.checked.clear(); setSelection(parseRanges(R.pagesText, pdf.numPages), false); renderOutline(); }, 350) });
  el.outlineBox = h('div');
  el.selStats = h('div');
  mount(card,
    h('div', { class: 'row between' },
      h('h2', null, h('span', { class: 'step' }, '1'), 'Choose your material'),
      h('button', { class: 'btn small', onclick: () => { R.pdf = null; R.checked.clear(); R.selPages = []; R.pagesText = ''; R.sourceText = null; R.words = 0; renderSource(); renderEpisode(); } }, 'Change PDF')),
    h('p', { class: 'sub' }, h('b', null, pdf.title), ` · ${pdf.numPages} pages · ${R.fileName}`),
    h('div', { class: 'grid2' },
      h('div', null, h('h3', { style: { marginTop: 0 } }, 'Chapters & sections'), el.outlineBox),
      h('div', null,
        h('h3', { style: { marginTop: 0 } }, 'Pages'),
        h('label', { class: 'field' }, h('span', null, 'PDF page numbers', h('span', { class: 'faint' }, 'ranges like 12-30, 45')), pagesInput),
        h('p', { class: 'small muted' }, 'Ticking a chapter fills this in. Page numbers here are the PDF\'s own page count, which can differ from the numbers printed in the book (shown in brackets in the list).'),
        el.selStats)));
  renderOutline(); renderSelStats();
}

function renderOutline() {
  const pdf = R.pdf; if (!pdf || !el.outlineBox) return;
  if (!pdf.outline.length) return mount(el.outlineBox, h('div', { class: 'note' }, 'This PDF has no chapter bookmarks, so choose pages on the right. Tip: check the table of contents in the PDF to find page ranges.'));
  const filter = el.filter?.value?.toLowerCase() || '';
  const byId = new Map(pdf.outline.map((n) => [n.id, n]));
  const ancestorsChecked = (n) => { for (const o of pdf.outline) if (o.children.includes(n.id)) return R.checked.has(o.id) || ancestorsChecked(o); return false; };
  const visible = (n) => { for (const o of pdf.outline) if (o.children.includes(n.id)) return R.expanded.has(o.id) && visible(o); return true; };
  const rows = [];
  for (const n of pdf.outline) {
    if (filter ? !n.title.toLowerCase().includes(filter) : !visible(n)) continue;
    const inherited = ancestorsChecked(n);
    const lab = (p) => { const l = pageLabel(pdf, p); return l !== String(p) ? `${p} (${l})` : `${p}`; };
    rows.push(h('div', { class: 'onode lvl' + Math.min(n.level, 2), style: { paddingLeft: 6 + (filter ? 0 : n.level * 16) + 'px' } },
      n.children.length && !filter ? h('button', { class: 'tw', 'aria-label': R.expanded.has(n.id) ? 'Collapse' : 'Expand', onclick: () => { R.expanded.has(n.id) ? R.expanded.delete(n.id) : R.expanded.add(n.id); renderOutline(); } }, R.expanded.has(n.id) ? '▼' : '▶') : h('span', { class: 'tw' }),
      h('input', { type: 'checkbox', checked: R.checked.has(n.id) || inherited, disabled: inherited, 'aria-label': n.title, onchange: (e) => toggleNode(n, e.target.checked) }),
      h('span', { class: 'ttl', title: n.title, onclick: () => !inherited && toggleNode(n, !R.checked.has(n.id)) }, n.title),
      h('span', { class: 'pg' }, n.end && n.end !== n.start ? `${lab(n.start)}–${lab(n.end)}` : lab(n.start))));
  }
  el.filter ||= h('input', { type: 'text', placeholder: 'Filter chapters...', style: { marginBottom: '8px' }, oninput: () => renderOutline() });
  mount(el.outlineBox, el.filter, h('div', { class: 'outline' }, rows.length ? rows : h('div', { class: 'muted small', style: { padding: '8px' } }, 'No matches')));
  void byId;
}

function toggleNode(n, on) {
  const pdf = R.pdf;
  const desc = (id) => { const x = pdf.outline.find((o) => o.id === id); return [id, ...x.children.flatMap(desc)]; };
  if (on) { R.checked.add(n.id); desc(n.id).slice(1).forEach((d) => R.checked.delete(d)); } else R.checked.delete(n.id);
  const pages = new Set();
  for (const id of R.checked) { const o = pdf.outline.find((x) => x.id === id); for (let p = o.start; p <= (o.end || o.start); p++) pages.add(p); }
  const arr = [...pages].sort((a, b) => a - b);
  R.pagesText = rangesToString(arr);
  const inp = el.source.querySelector('input[type=text][placeholder^="e.g."]'); if (inp) inp.value = R.pagesText;
  setSelection(arr, true); renderOutline();
}

const recount = debounce(async () => {
  const key = R.selPages.join(',');
  if (!R.selPages.length) { R.words = 0; renderSelStats(); renderEpisode(); return; }
  R.counting = true; renderSelStats();
  try {
    const w = await quickWordCount(R.pdf, R.selPages);
    if (key !== R.selPages.join(',')) return;
    R.words = w; R.wordsExact = R.selPages.length <= 40;
    const sug = suggestDurations(w); const prevSug = R.suggested; R.suggested = sug;
    if (!prevSug || S.episode.durationMin === prevSug.standard) { S.episode.durationMin = sug.standard; persist(); }
  } finally { R.counting = false; renderSelStats(); renderEpisode(); }
}, 250);

function setSelection(pages) {
  R.selPages = pages; R.sourceText = null; R.sourceKey = '';
  recount();
}

function renderSelStats() {
  if (!el.selStats) return;
  const n = R.selPages.length;
  if (!n) return mount(el.selStats, h('div', { class: 'note' }, 'Nothing selected yet.'));
  const lowText = R.words && R.words / n < 40;
  mount(el.selStats,
    h('div', { class: 'grid3', style: { margin: '10px 0' } },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtInt(n)), h('div', { class: 'k' }, n === 1 ? 'page' : 'pages')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, R.counting ? h('span', { class: 'spin' }) : (R.wordsExact ? '' : '~') + fmtK(R.words)), h('div', { class: 'k' }, 'words')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, R.counting ? '...' : fmtDur((R.words / 230) * 60)), h('div', { class: 'k' }, 'to read'))),
    lowText ? h('div', { class: 'note warn' }, 'Very little text found on these pages. If the PDF is scanned images, it needs OCR first (e.g. "Make searchable" in a PDF tool) before it can be turned into a podcast.') : null,
    h('button', { class: 'btn small', onclick: previewText }, 'Preview extracted text'));
}

async function ensureSourceText(onProgress) {
  const key = R.selPages.join(',');
  if (R.sourceText && R.sourceKey === key) return R.sourceText;
  const r = await extractText(R.pdf, R.selPages, onProgress);
  R.sourceText = r.text; R.sourceKey = key; R.words = r.words; R.wordsExact = true;
  return R.sourceText;
}
async function previewText() {
  const close = modal('Extracted text', h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' Reading pages...'));
  try {
    const t = await ensureSourceText();
    close();
    modal('Extracted text', [h('p', { class: 'small muted' }, `${fmtInt(R.words)} words from ${R.selPages.length} pages. Running headers, footers and page numbers are removed automatically. This is exactly what the script writer will read.`),
      h('pre', { class: 'preview' }, t.slice(0, 20000) + (t.length > 20000 ? '\n\n[... preview truncated ...]' : ''))]);
    renderSelStats();
  } catch (e) { close(); toast('Could not read text: ' + e.message); }
}

async function openPdf(file) {
  mount(el.source, h('h2', null, h('span', { class: 'step' }, '1'), 'Choose your material'), h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' Opening ', file.name, '...'));
  try {
    R.pdf = await loadPdf(file); R.fileName = file.name; R.checked.clear(); R.expanded.clear(); R.suggested = null;
    R.pagesText = ''; setSelection([]); renderSource(); renderEpisode();
  } catch (e) {
    R.pdf = null; renderSource(); toast('Could not open that PDF: ' + e.message, 6000);
  }
}

function suggestDurations(words) {
  const r = (x) => { const v = Math.min(90, Math.max(3, x)); return v > 20 ? Math.round(v / 5) * 5 : Math.round(v); };
  const out = {}; for (const d of DEPTH_PRESETS) out[d.id] = r(words / d.wordsPerMin);
  return out;
}

// ---------------- 2. Episode ----------------
function renderEpisode() {
  const E = S.episode; const card = el.episode;
  const save = () => { persist(); renderEstimate(); };
  const sug = R.words ? suggestDurations(R.words) : null;

  const durNum = h('input', { type: 'number', min: 2, max: 90, value: E.durationMin, style: { width: '84px' }, onchange: (e) => { E.durationMin = Math.min(90, Math.max(2, +e.target.value || 10)); durRange.value = E.durationMin; save(); markChips(); } });
  const durRange = h('input', { type: 'range', min: 2, max: 90, value: E.durationMin, oninput: (e) => { E.durationMin = +e.target.value; durNum.value = E.durationMin; save(); markChips(); } });
  const chipsBox = h('div', { class: 'chips' });
  const markChips = () => mount(chipsBox, sug ? DEPTH_PRESETS.map((d) => h('button', { class: 'chip' + (E.durationMin === sug[d.id] ? ' on' : ''), onclick: () => { E.durationMin = sug[d.id]; durNum.value = durRange.value = E.durationMin; save(); markChips(); } },
    d.id === 'standard' ? h('span', { class: 'tag' }, 'Suggested') : null, d.label, h('b', null, `${sug[d.id]} min`))) : h('span', { class: 'small muted' }, 'Select material to get a length suggestion.'));
  markChips();

  // speakers
  const spkCount = h('div', { class: 'chips' }, [1, 2, 3, 4].map((n) => h('button', { class: 'chip' + (E.speakerCount === n ? ' on' : ''), onclick: () => { E.speakerCount = n; persist(); renderEpisode(); } }, n === 1 ? '1 (solo)' : `${n} speakers`)));
  const spkCards = h('div', { class: 'speakers' }, activeSpeakers().map((sp, i) => speakerCard(sp, i)));

  const sel = (key, opts) => h('select', { onchange: (e) => { E[key] = e.target.value; save(); } }, opts.map((o) => h('option', { value: o, selected: E[key] === o }, o)));
  const chk = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: E[key], onchange: (e) => { E[key] = e.target.checked; save(); } }), label);

  // engines
  const prov = S.llm.provider; const P = LLM_PROVIDERS[prov];
  const provSel = h('select', { onchange: (e) => { S.llm.provider = e.target.value; persist(); renderEpisode(); } },
    Object.entries(LLM_PROVIDERS).filter(([k, p]) => !p.hidden || (k === 'claudeai' && R.claudeAi)).map(([k, p]) => h('option', { value: k, selected: k === prov }, p.label)));
  const listId = 'models-' + prov;
  const modelInp = h('input', { type: 'text', list: listId, value: S.llm.models[prov] || P.defaultModel, onchange: (e) => { S.llm.models[prov] = e.target.value.trim(); save(); } });
  const modelList = h('datalist', { id: listId }, (R.voiceLists['models:' + prov] || P.models).map((m) => h('option', { value: m })));
  const keyState = (need, key, label) => need && !key ? h('div', { class: 'note warn small' }, `Needs a ${label} key. `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); showTab('settings'); } }, 'Add it in Settings')) : null;

  const eng = S.tts.engine;
  const engSel = h('select', { onchange: (e) => { S.tts.engine = e.target.value; persist(); renderEpisode(); maybeLoadVoices(); } },
    Object.entries(TTS_ENGINES).map(([k, t]) => h('option', { value: k, selected: k === eng }, t.label)));

  el.estimate = h('div');
  mount(card,
    h('h2', null, h('span', { class: 'step' }, '2'), 'Design the episode'),
    h('p', { class: 'sub' }, 'Good defaults are set. Change as much or as little as you like; your choices are remembered.'),
    h('h3', null, 'Length'),
    chipsBox,
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { style: { flex: 1, minWidth: '180px' } }, durRange), durNum, h('span', { class: 'muted' }, 'minutes')),
    R.words ? h('p', { class: 'small muted' }, `Suggestions are based on ${R.wordsExact ? '' : 'about '}${fmtInt(R.words)} words of material: Overview hits the main ideas, Standard explains everything important, Deep dive adds nuance and examples.`) : null,
    h('h3', null, 'Speakers'), spkCount, h('div', { style: { height: '10px' } }), spkCards,
    h('h3', null, 'Style'),
    h('div', { class: 'grid3' }, h('label', { class: 'field' }, h('span', null, 'Tone'), sel('tone', STYLE_OPTIONS.tone)), h('label', { class: 'field' }, h('span', null, 'Level'), sel('level', STYLE_OPTIONS.level)), h('label', { class: 'field' }, h('span', null, 'Focus'), sel('focus', STYLE_OPTIONS.focus))),
    h('div', { class: 'row', style: { marginTop: '10px', gap: '18px' } }, chk('analogies', 'Analogies & examples'), chk('misconceptions', 'Common misconceptions'), chk('recap', 'Recap at the end'), chk('quiz', 'Quiz questions')),
    h('label', { class: 'field', style: { marginTop: '10px' } }, h('span', null, 'Extra instructions (optional)'), h('textarea', { rows: 2, placeholder: 'e.g. My exam is on Friday, focus on enzyme kinetics. Skip the history section.', value: E.custom, oninput: debounce((e) => { E.custom = e.target.value; persist(); }, 300) })),
    h('h3', null, 'Engines'),
    h('div', { class: 'grid2' },
      h('div', null, h('label', { class: 'field' }, h('span', null, 'Script writer (AI)', h('span', { class: 'faint' }, P.free)), provSel),
        P.manual ? h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'When you click Write script, you get one prompt to copy into your own chat AI, then paste its reply back. Uses your own subscription, no API key needed.')
          : h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', null, 'Model', R.keyOk(prov) ? h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); loadModels(prov); } }, 'Load available models') : ''), modelInp, modelList),
        keyState(P.needsKey, S.keys[prov], P.label)),
      h('div', null, h('label', { class: 'field' }, h('span', null, 'Voices'), engSel),
        eng === 'azure' ? h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', null, 'Azure region'), h('input', { type: 'text', value: S.azureRegion, onchange: (e) => { S.azureRegion = e.target.value.trim(); persist(); } })) : null,
        eng === 'gemini' ? h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', null, 'Delivery style (sent to Gemini TTS)'), h('input', { type: 'text', value: S.tts.geminiStyle, onchange: (e) => { S.tts.geminiStyle = e.target.value; persist(); } })) : null,
        eng === 'kokoro' ? h('p', { class: 'small muted' }, `Runs on your device. First use downloads the voice model (${KOKORO_MODELS.q8.mb} MB), then it's cached.`) : null,
        keyState(TTS_ENGINES[eng].needsKey, S.keys[eng], TTS_ENGINES[eng].label.split(' (')[0]))),
    h('h3', null, 'Before you generate'),
    el.estimate,
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn primary big', disabled: !R.selPages.length || R.scriptBusy, onclick: writeScript }, R.scriptBusy ? [h('span', { class: 'spin' }), ' Writing...'] : R.script ? 'Rewrite script' : 'Write script'),
      !R.selPages.length ? h('span', { class: 'muted small' }, 'Select some chapters or pages first.') : h('span', { class: 'muted small' }, 'You can review and edit the script before any audio is made.')));
  renderEstimate();
}
R.keyOk = (p) => !LLM_PROVIDERS[p]?.needsKey || !!S.keys[p];

async function loadModels(prov) {
  try { const { listModels } = await import('./llm.js'); const ids = await listModels(prov, S.keys[prov], S.llm.base[prov]); R.voiceLists['models:' + prov] = ids; toast(`${ids.length} models available`); renderEpisode(); }
  catch (e) { toast(e.message, 6000); }
}

async function maybeLoadVoices(force) {
  const eng = S.tts.engine;
  if (R.voiceLists[eng] && !force) return;
  try {
    if (eng === 'azure' && S.keys.azure) { R.voiceLists.azure = await azureVoices(S.keys.azure, S.azureRegion); renderEpisode(); }
    if (eng === 'google' && S.keys.google) { R.voiceLists.google = await googleVoices(S.keys.google); renderEpisode(); }
  } catch (e) { toast(e.message, 6000); }
}

function voiceOptions(eng) {
  if (eng === 'kokoro') return KOKORO_VOICES.map((v) => ({ id: v.id, label: `${v.name} (${v.accent} ${v.gender === 'F' ? 'female' : 'male'}, grade ${v.grade})` }));
  if (eng === 'gemini') return GEMINI_VOICES.map((v) => ({ id: v.id, label: `${v.name} (${v.desc})` }));
  return (R.voiceLists[eng] || []).map((v) => ({ id: v.id, label: v.name }));
}

function speakerCard(sp, i) {
  const E = S.episode; const eng = S.tts.engine;
  const save = () => { persist(); renderEstimate(); };
  const presetSel = h('select', { onchange: (e) => { const p = PERSONALITY_PRESETS.find((x) => x.role === e.target.value); if (p) { sp.role = p.role; sp.personality = p.personality; persist(); renderEpisode(); } } },
    h('option', { value: '' , selected: !PERSONALITY_PRESETS.some((p) => p.role === sp.role) }, 'Custom'), PERSONALITY_PRESETS.map((p) => h('option', { value: p.role, selected: p.role === sp.role }, p.role)));
  let voiceCtl;
  const opts = voiceOptions(eng);
  if (eng === 'kokoro') {
    const blend = parseBlend(sp.voices.kokoro);
    const a = blend[0], b = blend[1];
    const setBlend = (ida, idb, wb) => { sp.voices.kokoro = idb && wb > 0 ? `${ida}:${(1 - wb).toFixed(2)},${idb}:${wb.toFixed(2)}` : ida; save(); };
    const selA = h('select', { onchange: (e) => { setBlend(e.target.value, b?.id, b ? b.w : 0); renderEpisode(); } }, opts.map((o) => h('option', { value: o.id, selected: o.id === a.id }, o.label)));
    const selB = h('select', { onchange: (e) => { setBlend(a.id, e.target.value, Math.max(0.3, b?.w || 0.3)); renderEpisode(); } }, h('option', { value: '' }, 'No blend'), opts.map((o) => h('option', { value: o.id, selected: o.id === b?.id }, o.label)));
    const mix = b ? h('input', { type: 'range', min: 5, max: 95, value: Math.round(b.w * 100), onchange: (e) => { setBlend(a.id, b.id, +e.target.value / 100); renderEpisode(); } }) : null;
    voiceCtl = [h('label', { class: 'field' }, h('span', null, 'Voice'), selA),
      h('details', { open: !!b }, h('summary', null, 'Blend with another voice'), h('div', { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' } }, selB,
        b ? h('div', { class: 'small muted' }, `${100 - Math.round(b.w * 100)}% ${a.id} + ${Math.round(b.w * 100)}% ${b.id}`) : null, mix))];
  } else if (eng === 'gemini') {
    voiceCtl = h('label', { class: 'field' }, h('span', null, 'Voice'), h('select', { onchange: (e) => { sp.voices.gemini = e.target.value; save(); } }, opts.map((o) => h('option', { value: o.id, selected: o.id === sp.voices.gemini }, o.label))));
  } else {
    const lid = `vl-${eng}-${i}`;
    voiceCtl = h('label', { class: 'field' }, h('span', null, 'Voice', S.keys[eng] ? h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); maybeLoadVoices(true); } }, opts.length ? `${opts.length} voices loaded` : 'Load voices') : ''),
      h('input', { type: 'text', list: lid, value: sp.voices[eng], onchange: (e) => { sp.voices[eng] = e.target.value.trim(); save(); } }), h('datalist', { id: lid }, opts.map((o) => h('option', { value: o.id }, o.label))));
  }
  const prevBtn = h('button', { class: 'btn small', onclick: async () => {
    prevBtn.disabled = true; prevBtn.replaceChildren(h('span', { class: 'spin' }), ' Preview');
    try {
      const audio = await previewVoice(eng, sp.voices[eng], { ...ttsConfig(), speed: sp.speed, onProgress: (p) => { if (!p.cached && p.total) prevBtn.replaceChildren(h('span', { class: 'spin' }), ` Model ${Math.round(p.got / 1e6)}/${Math.round(p.total / 1e6)} MB`); } }, sp.name);
      playFloat(audio);
    } catch (e) { toast(e.message, 6000); }
    finally { prevBtn.disabled = false; prevBtn.replaceChildren('Preview voice'); }
  } }, 'Preview voice');
  return h('div', { class: 'spk ' + SPK_CLASS(i) },
    h('div', { class: 'head' }, h('span', { class: 'dot' }), h('input', { type: 'text', value: sp.name, 'aria-label': 'Speaker name', style: { fontWeight: 600 }, onchange: (e) => { const v = e.target.value.trim().replace(/:/g, ''); if (v && !activeSpeakers().some((s, j) => j !== i && s.name.toLowerCase() === v.toLowerCase())) { sp.name = v; persist(); } else { e.target.value = sp.name; toast('Speaker names must be unique'); } } }),
      presetSel),
    h('label', { class: 'field' }, h('span', null, 'Personality'), h('textarea', { rows: 4, value: sp.personality, oninput: debounce((e) => { sp.personality = e.target.value; sp.role = PERSONALITY_PRESETS.find((p) => p.personality === sp.personality)?.role || sp.role; persist(); }, 300) })),
    voiceCtl,
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Speed'), h('input', { type: 'range', min: 0.8, max: 1.25, step: 0.05, value: sp.speed || 1, style: { flex: 1 }, oninput: (e) => { sp.speed = +e.target.value; e.target.nextSibling.textContent = sp.speed.toFixed(2) + 'x'; }, onchange: save }), h('span', { class: 'small mono' }, (sp.speed || 1).toFixed(2) + 'x'), prevBtn));
}

let previewCtx;
function playFloat(data) {
  previewCtx ||= new AudioContext({ sampleRate: SR });
  const b = previewCtx.createBuffer(1, data.length, SR); b.copyToChannel(data, 0);
  const s = previewCtx.createBufferSource(); s.buffer = b; s.connect(previewCtx.destination); s.start();
}

// ---------------- Estimates ----------------
function checkRows(checks, unitMap = {}) {
  return checks.filter((c) => !c.pacing).map((c) => meter(`${c.metric === 'chars' ? 'Characters' : c.metric === 'tokens' ? 'Tokens' : 'Requests'} this ${c.window}`, c.used, c.plus, c.limit, unitMap[c.metric] || ''));
}
function statusPill(blocked, near) { return blocked ? h('span', { class: 'pill bad' }, 'Over free limit') : near ? h('span', { class: 'pill warn' }, 'Near limit') : h('span', { class: 'pill ok' }, 'Within free limits'); }

function renderEstimate() {
  if (!el.estimate) return;
  if (!R.selPages.length) return mount(el.estimate, h('div', { class: 'note' }, 'Select material to see what this episode will use.'));
  const s = estimateScript(); const a = estimateAudio();
  const sNear = s.checks.some((c) => !c.pacing && c.pct > 0.8); const aNear = a.checks.some((x) => x.checks.some((c) => !c.pacing && c.pct > 0.8));
  const pacing = s.checks.find((c) => c.pacing && c.metric === 'requests');
  mount(el.estimate, h('div', { class: 'estimate' },
    h('div', { class: 'erow' },
      h('div', null, h('b', null, 'Script'), h('div', { class: 'small muted' }, labelFor(s.svc)), statusPill(s.blocked, sNear)),
      h('div', null,
        LLM_PROVIDERS[llmConfig().provider]?.manual ? h('div', { class: 'small' }, `One copy & paste round · ~${fmtK(s.job.inTok)} token prompt, ~${fmtK(s.job.outTok)} token reply (about ${fmtInt(s.job.targetWords)} words of dialogue).`)
        : h('div', { class: 'small' }, `${s.job.calls} AI call${s.job.calls > 1 ? 's' : ''}`, s.job.needNotes ? ` (${s.job.notesCalls} to condense the material first, since it's larger than this model's input budget)` : '', ` · ~${fmtK(s.job.inTok)} input + ~${fmtK(s.job.outTok)} output tokens · about ${fmtDur(s.secs)}`),
        checkRows(s.checks),
        pacing ? h('div', { class: 'small faint' }, `Paced to stay under ${pacing.limit} requests/minute.`) : null,
        s.live?.exhausted ? h('div', { class: 'note bad small' }, 'The provider reported your daily quota is used up: ', s.live.lastError || '') : null,
        !s.checks.length ? h('div', { class: 'small faint' }, llmConfig().provider === 'custom' ? 'Local models have no quota.' : LLM_PROVIDERS[llmConfig().provider]?.manual ? 'Counts against your own chat subscription, not an API.' : 'No free-tier limit applies (paid or unmetered). Usage is still tracked.') : null)),
    h('div', { class: 'erow' },
      h('div', null, h('b', null, 'Audio'), h('div', { class: 'small muted' }, a.label.split(' (')[0]), statusPill(a.blocked, aNear)),
      h('div', null,
        h('div', { class: 'small' }, a.estimated ? 'Estimated from target length: ' : 'From the current script: ',
          `~${fmtK(a.chars)} characters · ~${fmtDur(a.audioSec)} of audio · `,
          a.engine === 'kokoro' ? `${a.nLines} lines rendered on your device, about ${fmtDur(a.secs)}${a.rtfKnown ? '' : ' (rough guess until your device has been measured)'}` : `${a.requests} request${a.requests === 1 ? '' : 's'} · about ${fmtDur(a.secs)}`),
        a.checks.map((x) => [a.checks.length > 1 ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, labelFor(x.svc)) : null, checkRows(x.checks), x.live?.exhausted ? h('div', { class: 'note bad small' }, x.live.lastError || 'Quota exhausted') : null]),
        a.engine === 'kokoro' ? h('div', { class: 'small faint' }, 'Unlimited and free: runs on your computer.') : null,
        a.gemini3plus ? h('div', { class: 'note warn small' }, 'Gemini voices can only do 2 speakers per request, so with 3+ speakers each line is a separate request. Consider 2 speakers or Kokoro.') : null))));
}
onUsageChange(debounce(() => renderEstimate(), 200));

// ---------------- 3. Script ----------------
async function writeScript() {
  if (R.scriptBusy) return;
  const est = estimateScript();
  if (est.blocked && !confirm('This looks like it will go over your free limit for the script writer. Continue anyway?')) return;
  R.scriptBusy = true; R.scriptErr = null; R.scriptStatus = 'Reading pages...'; R.scriptProgress = [0, 0]; R.draftLines = [];
  R.abort = new AbortController();
  el.script.classList.remove('hidden'); renderEpisode(); renderScript(); el.script.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const label = `${R.pdf.title}, pages ${rangesToString(R.selPages)}`;
  const run = startRun('Script · ' + label);
  try {
    const text = await ensureSourceText((d, t) => { R.scriptStatus = `Reading pages ${d}/${t}`; renderScriptStatus(); });
    if (R.words < 80) throw new Error('Almost no text was found on the selected pages. If this is a scanned PDF, run OCR on it first.');
    const res = await generateScript(text, { title: R.pdf.title, label }, { ...S.episode, speakers: activeSpeakers() }, llmConfig(), {
      onStatus: (m) => { R.scriptStatus = m; renderScriptStatus(); },
      onProgress: (d, t) => { R.scriptProgress = [d, t]; renderScriptStatus(); },
      onLines: (lines) => { R.draftLines = lines; renderDraft(); },
    }, R.abort.signal);
    R.script = { title: res.title, lines: res.lines, plan: res.plan, source: label };
    R.audio = null; R.episodeId = 'ep_' + Date.now().toString(36);
    await saveDraftEpisode();
  } catch (e) {
    if (e.name === 'AbortError') R.scriptErr = 'Stopped.';
    else R.scriptErr = e instanceof QuotaError ? e.message : (e.message || String(e));
    console.error(e);
  } finally {
    R.scriptRun = summarizeRun(endRun()); saveRunSummary(R.scriptRun);
    R.scriptBusy = false; R.abort = null; renderEpisode(); renderScript(); renderAudio();
  }
}

function renderScriptStatus() {
  if (!el.scriptStatus) return;
  const [d, t] = R.scriptProgress;
  mount(el.scriptStatus, h('div', { class: 'row' }, h('span', { class: 'spin' }), h('span', null, R.scriptStatus), h('span', { class: 'spacer' }), t ? h('span', { class: 'small muted' }, `step ${Math.min(d + 1, t)} of ${t}`) : null, h('button', { class: 'btn small', onclick: () => R.abort?.abort() }, 'Stop')),
    h('div', { class: 'progress', style: { marginTop: '8px' } }, h('i', { style: { width: (t ? (d / t) * 100 : 3) + '%' } })));
}
function renderDraft() {
  if (!el.draft) return;
  const lines = R.draftLines || [];
  const names = activeSpeakers().map((s) => s.name);
  mount(el.draft, lines.slice(-8).map((l) => h('div', { class: 'tline ' + SPK_CLASS(Math.max(0, names.indexOf(l.speaker))) }, h('b', null, l.speaker), l.text)));
}

function runSummaryCard(sum, title) {
  if (!sum?.services?.length) return null;
  return h('details', { class: 'note', style: { marginTop: '12px' } }, h('summary', null, `${title}: ${sum.services.map((s) => `${s.label} ${s.requests} req` + (s.inTok || s.outTok ? `, ${fmtK(s.inTok + s.outTok)} tokens` : '') + (s.chars ? `, ${fmtK(s.chars)} chars` : '')).join(' · ')}`),
    h('div', { class: 'tablewrap', style: { marginTop: '8px' } }, h('table', { class: 't' },
      h('tr', null, h('th', null, 'Service'), h('th', { class: 'n' }, 'Requests'), h('th', { class: 'n' }, 'Input tok'), h('th', { class: 'n' }, 'Output tok'), h('th', { class: 'n' }, 'Chars'), h('th', { class: 'n' }, 'Audio'), h('th', { class: 'n' }, 'Time')),
      sum.services.map((s) => h('tr', null, h('td', null, s.label, h('div', { class: 'faint small' }, s.models.join(', '))), h('td', { class: 'n' }, s.requests), h('td', { class: 'n' }, fmtInt(s.inTok)), h('td', { class: 'n' }, fmtInt(s.outTok)), h('td', { class: 'n' }, fmtInt(s.chars)), h('td', { class: 'n' }, s.audioSec ? fmtDur(s.audioSec) : '–'), h('td', { class: 'n' }, fmtDur(s.ms / 1000)))))),
    h('div', { class: 'small', style: { marginTop: '8px' } }, 'Remaining after this run: ', sum.services.map((s) => { const lim = getLimits(s.service).filter((l) => l.window !== 'minute'); return lim.length ? lim.map((l) => `${s.label}: ${fmtK(Math.max(0, l.limit - usedFor(s.service, l)))} ${l.metric} left this ${l.window}`).join('; ') : `${s.label}: no free-tier cap`; }).join(' · ')),
    h('div', { class: 'small faint', style: { marginTop: '4px' } }, `Took ${fmtDur((sum.ended - sum.started) / 1000)}. Full history is in the Usage tab.`));
}
import { totals } from './usage.js';
function usedFor(svc, l) { return totals(svc, l.window)[l.metric] || 0; }

function renderScript() {
  const card = el.script;
  if (!R.scriptBusy && !R.script && !R.scriptErr) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const head = h('h2', null, h('span', { class: 'step' }, '3'), 'Review the script');
  if (R.scriptBusy) {
    el.scriptStatus = h('div'); el.draft = h('div', { class: 'transcript', style: { marginTop: '12px' } });
    mount(card, head, el.scriptStatus, el.draft); renderScriptStatus(); renderDraft(); return;
  }
  el.scriptStatus = el.draft = null;
  const err = R.scriptErr ? h('div', { class: 'note bad' }, R.scriptErr) : null;
  if (!R.script) return mount(card, head, err, runSummaryCard(R.scriptRun, 'Usage'));
  const sc = R.script; const sp = activeSpeakers(); const names = sp.map((s) => s.name);
  // Make sure lines only reference active speakers
  for (const l of sc.lines) if (!names.includes(l.speaker)) l.speaker = names[0];
  const words = scriptWords(sc.lines);
  const statsBox = h('span', { class: 'muted small' });
  const updStats = () => { statsBox.textContent = `${sc.lines.length} lines · ${fmtInt(scriptWords(sc.lines))} words · about ${fmtDur(scriptWords(sc.lines) / WORDS_PER_MIN * 60)} of audio`; };
  updStats();
  const listBox = h('div', { class: 'script' });
  const renderLines = () => mount(listBox, sc.lines.map((l, i) => [
    l.segment ? h('div', { class: 'segtitle' }, l.segment) : null,
    h('div', { class: 'line ' + SPK_CLASS(Math.max(0, names.indexOf(l.speaker))) },
      h('select', { 'aria-label': 'Speaker', onchange: (e) => { l.speaker = e.target.value; renderLines(); saveDraftEpisode(); } }, names.map((n) => h('option', { value: n, selected: n === l.speaker }, n))),
      h('textarea', { rows: Math.max(1, Math.ceil(l.text.length / 95)), value: l.text, oninput: debounce((e) => { l.text = e.target.value; updStats(); renderEstimate(); saveDraftEpisode(); }, 400) }),
      h('div', { class: 'row', style: { gap: '2px' } },
        h('button', { class: 'btn ghost small x', title: 'Insert line below', onclick: () => { sc.lines.splice(i + 1, 0, { speaker: names[(names.indexOf(l.speaker) + 1) % names.length], text: '' }); renderLines(); } }, '+'),
        h('button', { class: 'btn ghost small x danger', title: 'Delete line', onclick: () => { sc.lines.splice(i, 1); renderLines(); updStats(); saveDraftEpisode(); } }, '×')))]));
  renderLines();
  const ae = estimateAudio();
  mount(card, head,
    h('div', { class: 'row between' }, h('input', { type: 'text', value: sc.title, 'aria-label': 'Episode title', style: { fontSize: '17px', fontWeight: 600, maxWidth: '520px' }, onchange: (e) => { sc.title = e.target.value; saveDraftEpisode(); } }), statsBox),
    err,
    words < S.episode.durationMin * WORDS_PER_MIN * 0.7 ? h('div', { class: 'note warn small', style: { marginTop: '8px' } }, `The script came out shorter than the ${S.episode.durationMin}-minute target. Rewrite, or try a stronger model.`) : null,
    h('p', { class: 'small muted' }, 'Edit anything below. Changes are saved to your Library automatically.'),
    listBox,
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn primary big', disabled: R.audioBusy, onclick: renderEpisodeAudio }, 'Make the audio'),
      h('span', { class: 'small muted' }, ae.engine === 'kokoro' ? `${ae.label.split(' (')[0]} · ~${fmtDur(ae.audioSec)} audio · about ${fmtDur(ae.secs)} to render` : `${ae.label.split(' (')[0]} · ${ae.requests} requests · ${fmtK(ae.chars)} chars`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => download(new Blob([transcriptText()], { type: 'text/markdown' }), slug(sc.title) + '-transcript.md') }, 'Download script')),
    runSummaryCard(R.scriptRun, 'Script usage'));
}

function transcriptText() {
  const sc = R.script; if (!sc) return '';
  return `# ${sc.title}\n\n_Source: ${sc.source || ''}_\n\n` + sc.lines.map((l) => `${l.segment ? `\n## ${l.segment}\n\n` : ''}**${l.speaker}:** ${l.text}`).join('\n\n') + '\n';
}

async function saveDraftEpisode() {
  if (!R.script) return;
  R.episodeId ||= 'ep_' + Date.now().toString(36);
  await saveEpisode({ id: R.episodeId, created: parseInt(R.episodeId.slice(3), 36) || Date.now(), updated: Date.now(), title: R.script.title, source: R.script.source,
    speakers: activeSpeakers().map((s) => ({ name: s.name, role: s.role })), engine: R.audio?.engine || null, lines: R.script.lines, marks: R.audio?.marks || null,
    durationSec: R.audio?.durationSec || null, audio: R.audio?.mp3 || null, usage: [R.scriptRun, R.audioRun].filter(Boolean) });
}
const saveDraftDebounced = debounce(saveDraftEpisode, 800); void saveDraftDebounced;

// ---------------- 4. Audio ----------------
let live = null;
function livePlayerStart() {
  live = { ctx: new AudioContext({ sampleRate: SR }), next: 0, queued: 0, prevSpeaker: null };
  live.next = live.ctx.currentTime + 0.1;
  (R.clips || []).forEach(liveEnqueue);
}
function liveEnqueue(c) {
  if (!live || !c.data?.length) return;
  const gap = live.prevSpeaker == null ? 0 : live.prevSpeaker === c.speaker ? 0.18 : 0.32; live.prevSpeaker = c.speaker;
  const b = live.ctx.createBuffer(1, c.data.length, SR); b.copyToChannel(c.data, 0);
  const s = live.ctx.createBufferSource(); s.buffer = b; s.connect(live.ctx.destination);
  live.next = Math.max(live.next + gap, live.ctx.currentTime + 0.05); s.start(live.next); live.next += b.duration;
}
function livePlayerStop() { try { live?.ctx.close(); } catch {} live = null; }

async function renderEpisodeAudio() {
  if (R.audioBusy || !R.script?.lines.length) return;
  const est = estimateAudio();
  if (est.blocked && !confirm('This looks like it will go over your free voice limit. Continue anyway?')) return;
  const cfg = ttsConfig();
  if (TTS_ENGINES[cfg.engine].needsKey && !S.keys[cfg.engine]) { toast('Add your key for this voice engine in Settings first.'); return; }
  const lines = R.script.lines.filter((l) => l.text.trim());
  R.audioBusy = true; R.audioErr = null; R.audio = null; R.clips = []; R.audioStart = Date.now();
  R.abort = new AbortController(); const signal = R.abort.signal;
  el.audio.classList.remove('hidden'); renderScript(); renderAudio(); el.audio.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const run = startRun('Audio · ' + R.script.title); void run;
  try {
    if (cfg.engine === 'kokoro') {
      R.audioStatus = 'Loading the voice model...'; renderAudioStatus();
      await kokoro.init({ device: cfg.kokoroDevice }, (p) => { R.audioStatus = p.cached ? 'Loading the voice model from cache...' : `Downloading the voice model (one time): ${Math.round(p.got / 1e6)} / ${Math.round(p.total / 1e6)} MB`; renderAudioStatus(); });
    }
    const units = planRequests(cfg.engine, lines, cfg.speakers.length);
    const svc = cfg.engine === 'google' ? null : 'tts:' + cfg.engine;
    const perMin = svc ? getLimits(svc).find((l) => l.window === 'minute' && l.metric === 'requests')?.limit : null;
    const gapMs = perMin ? 60000 / perMin : 0;
    R.audioProgress = [0, lines.length];
    let lastReq = 0;
    for (const u of units) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const wait = lastReq + gapMs - Date.now(); if (wait > 0) { R.audioStatus = `Pacing requests to stay under the free per-minute limit (${Math.ceil(wait / 1000)}s)`; renderAudioStatus(); await new Promise((r) => setTimeout(r, wait)); }
      lastReq = Date.now();
      R.audioStatus = `Rendering line ${u.from + 1}${u.to > u.from ? `-${u.to + 1}` : ''} of ${lines.length}`; renderAudioStatus();
      const raw = await renderUnit(u, cfg, signal, (m) => { R.audioStatus = m; renderAudioStatus(); });
      const clip = { data: tidy(raw), speaker: u.lines.length === 1 ? u.lines[0].speaker : null, unit: u };
      R.clips.push(clip); liveEnqueue(clip);
      R.audioProgress = [u.to + 1, lines.length]; renderAudioStatus();
    }
    R.audioStatus = 'Mixing and encoding MP3...'; renderAudioStatus();
    const { data, marks: clipMarks } = assemble(R.clips);
    const marks = [];
    R.clips.forEach((c, ci) => {
      const m = clipMarks[ci]; const ls = c.unit.lines; const total = ls.reduce((a, l) => a + l.text.length, 0) || 1; let t = m.start;
      for (const l of ls) { const d = (m.end - m.start) * (l.text.length / total); marks.push({ start: t, end: t + d }); t += d; }
    });
    const mp3 = await encodeMp3(data, SR, 64, (p) => { R.audioStatus = `Encoding MP3 ${Math.round(p * 100)}%`; renderAudioStatus(); });
    R.audio = { mp3, wavData: data, marks, lines, durationSec: data.length / SR, engine: cfg.engine, url: URL.createObjectURL(mp3) };
  } catch (e) {
    R.audioErr = e.name === 'AbortError' ? 'Stopped.' : e.message || String(e); console.error(e);
  } finally {
    R.audioRun = summarizeRun(endRun()); saveRunSummary(R.audioRun);
    R.audioBusy = false; R.abort = null; livePlayerStop();
    if (R.audio) await saveDraftEpisode();
    renderScript(); renderAudio();
  }
}

function renderAudioStatus() {
  if (!el.audioStatus) return;
  const [d, t] = R.audioProgress; const elapsed = (Date.now() - R.audioStart) / 1000;
  const eta = d > 0 && t ? (elapsed / d) * (t - d) : null;
  mount(el.audioStatus,
    h('div', { class: 'row' }, h('span', { class: 'spin' }), h('span', null, R.audioStatus), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${fmtDur(elapsed)} elapsed${eta != null ? ` · ~${fmtDur(eta)} left` : ''}`),
      h('button', { class: 'btn small', onclick: () => R.abort?.abort() }, 'Stop')),
    h('div', { class: 'progress', style: { marginTop: '8px' } }, h('i', { style: { width: (t ? (d / t) * 100 : 2) + '%' } })));
}

function renderAudio() {
  const card = el.audio;
  if (!R.audioBusy && !R.audio && !R.audioErr) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const head = h('h2', null, h('span', { class: 'step' }, '4'), 'Listen');
  if (R.audioBusy) {
    el.audioStatus = h('div');
    const liveBtn = h('button', { class: 'btn', onclick: () => { if (live) { livePlayerStop(); liveBtn.textContent = 'Listen while it renders'; } else { livePlayerStart(); liveBtn.textContent = 'Stop listening'; } } }, live ? 'Stop listening' : 'Listen while it renders');
    mount(card, head, el.audioStatus, h('div', { class: 'row', style: { marginTop: '12px' } }, liveBtn, h('span', { class: 'small muted' }, 'Plays finished lines as they come in.')));
    renderAudioStatus(); return;
  }
  el.audioStatus = null;
  const err = R.audioErr ? h('div', { class: 'note bad' }, R.audioErr, R.clips?.length ? ` (${R.clips.length} parts finished before stopping.)` : '') : null;
  if (!R.audio) return mount(card, head, err, runSummaryCard(R.audioRun, 'Audio usage'));
  const A = R.audio; const names = activeSpeakers().map((s) => s.name);
  const player = h('audio', { controls: true, src: A.url, preload: 'auto' });
  const tl = A.lines.map((l, i) => h('div', { class: 'tline ' + SPK_CLASS(Math.max(0, names.indexOf(l.speaker))), onclick: () => { player.currentTime = A.marks[i]?.start || 0; player.play(); } }, h('b', null, l.speaker), l.text));
  let cur = -1;
  player.addEventListener('timeupdate', () => {
    const t = player.currentTime; let i = A.marks.findIndex((m) => t >= m.start && t < m.end + 0.3);
    if (i !== cur) { tl[cur]?.classList.remove('now'); cur = i; if (i >= 0) { tl[i].classList.add('now'); tl[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }
  });
  const base = slug(R.script?.title || 'podcast');
  mount(card, head, err,
    h('div', { class: 'row between' }, h('b', null, R.script?.title || 'Episode'), h('span', { class: 'muted small' }, `${fmtClock(A.durationSec)} · ${TTS_ENGINES[A.engine]?.label.split(' (')[0] || ''} · saved to Library`)),
    h('div', { style: { margin: '10px 0' } }, player),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => download(A.mp3, base + '.mp3') }, 'Download MP3'),
      A.wavData ? h('button', { class: 'btn', onclick: () => download(encodeWav(A.wavData), base + '.wav') }, 'Download WAV') : null,
      h('button', { class: 'btn', onclick: () => download(new Blob([transcriptText()], { type: 'text/markdown' }), base + '-transcript.md') }, 'Transcript')),
    h('h3', null, 'Transcript (click a line to jump)'),
    h('div', { class: 'transcript' }, tl),
    runSummaryCard(R.audioRun, 'Audio usage'));
}

// ---------------- Library open ----------------
async function openEpisode(ep) {
  R.script = { title: ep.title, lines: ep.lines, source: ep.source };
  R.episodeId = ep.id; R.scriptRun = ep.usage?.[0] || null; R.audioRun = ep.usage?.[1] || null; R.scriptErr = R.audioErr = null;
  // map speakers back onto current slots by name if possible
  const names = ep.speakers?.map((s) => s.name) || [...new Set(ep.lines.map((l) => l.speaker))];
  S.episode.speakerCount = Math.min(4, Math.max(1, names.length));
  names.slice(0, 4).forEach((n, i) => { S.episode.speakers[i].name = n; });
  persist();
  R.audio = ep.audio ? { mp3: ep.audio, marks: ep.marks || [], lines: ep.lines, durationSec: ep.durationSec, engine: ep.engine, url: URL.createObjectURL(ep.audio) } : null;
  showTab('create'); renderEpisode(); renderScript(); renderAudio();
  (R.audio ? el.audio : el.script).scrollIntoView({ behavior: 'smooth' });
}

// ---------------- Boot ----------------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
detectClaudeAi().then((ok) => { R.claudeAi = ok; if (ok && !R.keyOk(S.llm.provider)) { S.llm.provider = 'claudeai'; } renderEpisode(); });
initCreate();
maybeLoadVoices();
window.addEventListener('beforeunload', (e) => { if (R.scriptBusy || R.audioBusy) { e.preventDefault(); e.returnValue = ''; } });
