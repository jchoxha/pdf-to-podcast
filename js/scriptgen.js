// Turns selected source text into a multi-speaker podcast script.
import { WORDS_PER_MIN, TOKENS_PER_CHAR, LLM_PROVIDERS } from './config.js';
import { complete } from './llm.js';

const OVERHEAD_TOK = 2500;           // instructions + plan + context per call
const wc = (s) => (s.match(/\S+/g) || []).length;

export function segmentCount(durationMin) { return durationMin <= 5 ? 1 : Math.max(2, Math.round(durationMin / 4)); }

function budgetChars(llm) {
  const maxTok = llm.maxInputTokens || LLM_PROVIDERS[llm.provider]?.maxInputTokens || 30000;
  return Math.max(4000, Math.floor((maxTok - OVERHEAD_TOK) / TOKENS_PER_CHAR));
}

// Split text into n roughly equal parts at paragraph (or sentence) boundaries.
export function splitEven(text, n) {
  if (n <= 1) return [text];
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const units = paras.length >= n * 2 ? paras : text.split(/(?<=[.!?])\s+/);
  const total = units.reduce((a, p) => a + p.length, 0); const target = total / n;
  const out = []; let cur = []; let len = 0;
  for (const u of units) {
    cur.push(u); len += u.length;
    if (len >= target && out.length < n - 1) { out.push(cur.join('\n\n')); cur = []; len = 0; }
  }
  if (cur.length) out.push(cur.join('\n\n'));
  while (out.length < n) out.push(out[out.length - 1] || '');
  return out;
}
function splitBySize(text, maxChars) { return splitEven(text, Math.max(1, Math.ceil(text.length / maxChars))); }

// Plan the job without calling anything: used for the pre-generation estimate.
export function planJob(srcLen, cfg, llm) {
  const segs = segmentCount(cfg.durationMin);
  const budget = budgetChars(llm);
  const needNotes = srcLen > budget;
  const chunkLen = srcLen / segs;
  let notesCalls = 0, notesIn = 0, notesOut = 0;
  if (needNotes) {
    for (let i = 0; i < segs; i++) { const n = Math.max(1, Math.ceil(chunkLen / budget)); notesCalls += n; notesIn += chunkLen * TOKENS_PER_CHAR + n * 600; notesOut += n * 1100; }
  }
  const sourceText = { length: srcLen };
  const words = cfg.durationMin * WORDS_PER_MIN;
  const outPerSeg = (words / segs) * 1.45 + 60;       // tokens per word incl. speaker labels
  const planCalls = segs > 1 ? 1 : 0;
  const materialTok = needNotes ? notesOut : sourceText.length * TOKENS_PER_CHAR;
  const planIn = planCalls ? Math.min(materialTok, budget * TOKENS_PER_CHAR) + 1200 : 0;
  const segIn = segs * (OVERHEAD_TOK) + (needNotes ? notesOut : sourceText.length * TOKENS_PER_CHAR);
  return {
    segments: segs, needNotes, notesCalls, planCalls, segCalls: segs,
    calls: notesCalls + planCalls + segs,
    inTok: Math.round(notesIn + planIn + segIn), outTok: Math.round(notesOut + planCalls * 700 + segs * outPerSeg),
    targetWords: words,
  };
}

function showBible(cfg) {
  const solo = cfg.speakers.length === 1;
  const sp = cfg.speakers.map((s, i) => `- ${s.name} (${s.role}${i === 0 && !solo ? ', leads the show' : ''}): ${s.personality}`).join('\n');
  if (solo) return `SHOW: an educational solo podcast. One engaging narrator talks directly to the listener (a student), like a great tutor: conversational, asking rhetorical questions and answering them.
NARRATOR:
${sp}
TONE: ${cfg.tone}. AUDIENCE LEVEL: ${cfg.level}. FOCUS: ${cfg.focus}.
${[cfg.analogies && 'Use vivid analogies and concrete examples.', cfg.misconceptions && 'Call out common misconceptions.', cfg.recap && 'Close with a crisp recap of key takeaways.', cfg.quiz && 'Near the end, pose 2-3 quick review questions, pause briefly, then answer them.'].filter(Boolean).join('\n')}
${cfg.custom ? 'LISTENER\'S EXTRA INSTRUCTIONS: ' + cfg.custom : ''}`.trim();
  const extras = [];
  if (cfg.analogies) extras.push('Use vivid analogies and concrete examples to make abstract ideas stick.');
  if (cfg.misconceptions) extras.push('Call out common misconceptions and mistakes students make.');
  if (cfg.recap) extras.push('Close with a crisp recap of the key takeaways.');
  if (cfg.quiz) extras.push('Near the end, one speaker poses 2-3 quick review questions and pauses briefly before the answers are given.');
  return `SHOW: an educational podcast that turns textbook material into an engaging conversation for a student.
SPEAKERS (${cfg.speakers.length}):
${sp}
TONE: ${cfg.tone}. AUDIENCE LEVEL: ${cfg.level}. FOCUS: ${cfg.focus}.
${extras.join('\n')}
${cfg.custom ? 'LISTENER\'S EXTRA INSTRUCTIONS: ' + cfg.custom : ''}`.trim();
}

const RULES = (names) => `WRITING RULES
- Output ONLY dialogue lines in the exact form "Name: what they say". One line per turn. Names must be exactly one of: ${names.join(', ')}.
- No stage directions, sound effects, markdown, headings, bullet points or parentheticals. Everything you write will be read aloud by a text-to-speech voice.
- Write for the ear: short sentences, natural contractions, occasional brief reactions ("Right.", "Wait, so..."), but no filler padding.
- Say numbers, units, formulas and symbols the way a person would speak them ("x squared", "twenty-five percent", "delta G"). Expand abbreviations on first use.
- Stay faithful to the source material. Do not invent specific facts, data or quotes that are not supported by it; general background knowledge is fine if clearly helpful.
- Keep talk time balanced; the lead speaker guides the flow. Speakers should build on each other, not take turns giving mini-lectures. Keep most turns under 80 words.`;

function parseJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); const s = m ? m[1] : text;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(s.slice(a, b + 1));
}

export function parseScript(text, speakers) {
  const names = speakers.map((s) => s.name);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const lines = [];
  for (let raw of text.split('\n')) {
    raw = raw.replace(/^\s*[-*>\d.)]*\s*/, '').replace(/\*\*/g, '').trim();
    if (!raw) continue;
    const m = raw.match(/^([A-Za-z][\w .'-]{0,40}?)\s*:\s*(.+)$/);
    const who = m && lower.get(m[1].trim().toLowerCase());
    if (who) lines.push({ speaker: who, text: cleanLine(m[2]) });
    else if (lines.length && !/^(\[|\(|#|segment|part)/i.test(raw)) lines[lines.length - 1].text += ' ' + cleanLine(raw);
  }
  return lines.filter((l) => l.text.trim());
}
const cleanLine = (s) => s.replace(/\[[^\]]*\]|\([^)]*(laughs|pause|music|sighs|chuckles)[^)]*\)/gi, '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();

// Main entry. hooks: {onStatus(msg), onProgress(done,total), onLines(allLinesSoFar)}
export async function generateScript(sourceText, meta, cfg, llm, hooks = {}, signal) {
  const { onStatus = () => {}, onProgress = () => {}, onLines = () => {} } = hooks;
  const job = planJob(sourceText.length, cfg, llm);
  const names = cfg.speakers.map((s) => s.name);
  const bible = showBible(cfg);
  const call = (prompt, extra = {}) => complete({ ...llm, prompt, signal, onStatus, ...extra });
  let done = 0; const tick = () => onProgress(++done, job.calls);

  // 1) Condense source if it doesn't fit the model's input budget.
  const chunks = splitEven(sourceText, job.segments);
  let material = chunks;
  if (job.needNotes) {
    material = [];
    const budget = budgetChars(llm);
    for (let i = 0; i < chunks.length; i++) {
      const parts = splitBySize(chunks[i], budget); const notes = [];
      for (let j = 0; j < parts.length; j++) {
        onStatus(`Reading the material: part ${i + 1}.${j + 1}`);
        const r = await call(`You are preparing study notes for a podcast script.\nCondense the following textbook excerpt into dense, well-organized notes (about 500-800 words) that keep every key concept, definition, mechanism, example, number and relationship needed to teach it accurately. Plain text, no preamble.\n\nEXCERPT:\n"""${parts[j]}"""`, { maxTokens: 2048, temperature: 0.3, kind: 'notes' });
        notes.push(r.text.trim()); tick();
      }
      material.push(notes.join('\n\n'));
    }
  }

  // 2) Plan the episode arc.
  let plan = { title: meta.title || 'Study Session', segments: material.map((_, i) => ({ title: `Part ${i + 1}`, points: [] })) };
  if (job.planCalls) {
    onStatus('Planning the episode');
    const all = material.map((m, i) => `--- PART ${i + 1} ---\n${m}`).join('\n\n');
    const r = await call(`${bible}\n\nPlan a ${cfg.durationMin}-minute episode covering the material below, which is split into ${material.length} parts in order. Create exactly ${material.length} segments, one per part, each with a short title and 3-6 talking points drawn from that part. Give the episode a catchy but clear title.\nReply with ONLY JSON: {"title": string, "segments": [{"title": string, "points": [string]}]}\n\nSOURCE: ${meta.label || ''}\n\n${all}`,
      { json: true, maxTokens: 3000, temperature: 0.5, kind: 'plan' });
    try { const p = parseJSON(r.text); if (p.segments?.length) { plan = p; while (plan.segments.length < material.length) plan.segments.push({ title: 'Continued', points: [] }); } } catch (e) { console.warn('plan parse failed', e, r.text); }
    tick();
  }

  // 3) Write each segment.
  const perSeg = Math.round(job.targetWords / job.segments);
  const lines = [];
  for (let i = 0; i < job.segments; i++) {
    onStatus(job.segments > 1 ? `Writing segment ${i + 1} of ${job.segments}: ${plan.segments[i]?.title || ''}` : 'Writing the script');
    const first = i === 0, last = i === job.segments - 1;
    const outline = plan.segments.map((s, j) => `${j + 1}. ${s.title}${j === i ? '  <== YOU ARE WRITING THIS ONE' : ''}${s.points?.length && j === i ? '\n   - ' + s.points.join('\n   - ') : ''}`).join('\n');
    const prev = lines.slice(-6).map((l) => `${l.speaker}: ${l.text}`).join('\n');
    const role = first && last ? `This is the whole episode: open with a quick welcome and hook (the lead speaker names the episode "${plan.title}"), then teach the material, then wrap up and sign off.`
      : first ? `This is the OPENING segment: start with a short welcome and hook (the lead speaker introduces the episode "${plan.title}" and what it covers), then dive in. Do NOT wrap up the episode; end mid-conversation, leading naturally into the next topic.`
      : last ? 'This is the FINAL segment: continue seamlessly from the previous lines (no new welcome), cover this part, then wrap up the whole episode and sign off.'
      : 'This is a MIDDLE segment: continue seamlessly from the previous lines (no greetings, no sign-off), cover this part, and end leading into the next topic.';
    const prompt = `${bible}\n\n${RULES(names)}\n\nEPISODE PLAN:\n${outline}\n\n${role}\nLENGTH: about ${perSeg} words of dialogue (roughly ${Math.max(6, Math.round(perSeg / 45))} turns). Length matters because it sets the episode duration.\n${prev ? `\nPREVIOUS LINES (continue right after these, do not repeat them):\n${prev}\n` : ''}\nSOURCE MATERIAL FOR THIS SEGMENT (${meta.label || 'textbook'}):\n"""${material[i]}"""\n\nNow write the dialogue.`;
    const r = await call(prompt, { maxTokens: Math.min(16000, Math.round(perSeg * 2.2) + 1500), kind: 'segment',
      onText: (t) => onLines([...lines, ...parseScript(t, cfg.speakers)]) });
    const segLines = parseScript(r.text, cfg.speakers);
    if (!segLines.length) throw new Error('The AI reply did not contain dialogue in "Name: text" form. Try again or pick another model.');
    segLines[0].segment = plan.segments[i]?.title;
    lines.push(...segLines); onLines(lines); tick();
  }
  return { title: plan.title, plan, lines, words: lines.reduce((a, l) => a + wc(l.text), 0) };
}

export const scriptWords = (lines) => lines.reduce((a, l) => a + wc(l.text), 0);
export const scriptChars = (lines) => lines.reduce((a, l) => a + l.text.length, 0);
