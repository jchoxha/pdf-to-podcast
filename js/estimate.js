// Pre-generation estimates for script writing and audio rendering.
import { WORDS_PER_MIN, CHARS_PER_WORD, LLM_PROVIDERS, TTS_ENGINES } from './config.js';
import { planJob } from './scriptgen.js';
import { planRequests, googleTier, kokoroRtf, kokoro } from './tts.js';
import { check, getLive } from './usage.js';
import { S, R, llmConfig, activeSpeakers } from './state.js';

export function estimateScript() {
  const llm = llmConfig();
  const srcLen = R.sourceText ? R.sourceText.length : R.words * CHARS_PER_WORD;
  const job = planJob(srcLen, S.episode, llm);
  const svc = 'llm:' + llm.provider;
  const checks = check(svc, { requests: job.calls, tokens: job.inTok + job.outTok });
  const live = getLive(svc);
  const minuteReq = checks.find((c) => c.metric === 'requests' && c.window === 'minute');
  const gapS = Math.max((LLM_PROVIDERS[llm.provider].minGapMs || 0) / 1000, minuteReq ? 60 / minuteReq.limit : 0);
  const secs = job.calls * 18 + Math.max(0, job.calls - 1) * gapS;
  return { svc, job, checks, live, secs, blocked: checks.some((c) => !c.ok && !c.pacing) || live?.exhausted };
}

export function estimateAudio() {
  const engine = S.tts.engine;
  const sp = activeSpeakers();
  let lines = R.script?.lines;
  let chars, nLines, audioSec, estimated = !lines;
  if (lines?.length) {
    chars = lines.reduce((a, l) => a + l.text.length, 0); nLines = lines.length;
    audioSec = lines.reduce((a, l) => a + l.text.split(/\s+/).length, 0) / WORDS_PER_MIN * 60;
  } else {
    const words = S.episode.durationMin * WORDS_PER_MIN;
    chars = Math.round(words * CHARS_PER_WORD); nLines = Math.max(4, Math.round(words / 42)); audioSec = S.episode.durationMin * 60;
    lines = Array.from({ length: nLines }, (_, i) => ({ speaker: sp[i % sp.length].name, text: 'x'.repeat(Math.round(chars / nLines)) }));
  }
  const units = planRequests(engine, lines, sp.length);
  const services = [];
  if (engine === 'google') {
    const byTier = {};
    for (const l of lines) { const s = sp.find((x) => x.name === l.speaker) || sp[0]; const t = googleTier(s.voices.google || ''); (byTier[t] ||= { chars: 0, requests: 0 }); byTier[t].chars += l.text.length; byTier[t].requests++; }
    for (const [t, v] of Object.entries(byTier)) services.push({ svc: 'tts:google:' + t, add: v });
  } else {
    services.push({ svc: 'tts:' + engine, add: { requests: engine === 'kokoro' ? 0 : units.length, chars } });
  }
  const checks = services.map((s) => ({ ...s, checks: check(s.svc, s.add), live: getLive(s.svc) }));
  let secs;
  if (engine === 'kokoro') { const rtf = kokoroRtf(); secs = audioSec * (rtf || 0.7); }
  else {
    const minute = checks[0]?.checks.find((c) => c.metric === 'requests' && c.window === 'minute');
    const perReq = engine === 'google' ? 1.2 : engine === 'azure' ? 4 : 12;
    secs = units.length * perReq + (minute ? Math.max(0, units.length - minute.limit) * (60 / minute.limit) : 0);
  }
  return { engine, label: TTS_ENGINES[engine].label, chars, nLines, audioSec, requests: engine === 'kokoro' ? 0 : units.length, units: units.length, secs, estimated,
    rtfKnown: engine === 'kokoro' ? !!kokoroRtf() : true, checks, blocked: checks.some((c) => c.checks.some((x) => !x.ok && !x.pacing) || c.live?.exhausted),
    gemini3plus: engine === 'gemini' && sp.length > 2 };
}
