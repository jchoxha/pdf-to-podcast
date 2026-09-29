// Usage ledger: records every API call / synthesis job, compares against free-tier limits.
import { DEFAULT_LIMITS, SERVICE_LABELS } from './config.js';
import { lsGet, lsSet } from './store.js';

const LEDGER = 'pdfpod.usage.v1';
const LIVE = 'pdfpod.usage.live.v1';
const LIMITS = 'pdfpod.usage.limits.v1';
const MAX_ENTRIES = 5000;

const listeners = new Set();
export const onUsageChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

export function ledger() { return lsGet(LEDGER, []); }

let currentRun = null;
export function startRun(label) { currentRun = { id: 'run_' + Date.now().toString(36), label, started: Date.now(), entries: [] }; return currentRun; }
export function endRun() { const r = currentRun; if (r) r.ended = Date.now(); currentRun = null; return r; }

export function record(e) {
  const entry = { ts: Date.now(), requests: 1, inTok: 0, outTok: 0, chars: 0, audioSec: 0, ms: 0, ...e };
  if (currentRun) { entry.runId = currentRun.id; currentRun.entries.push(entry); }
  const l = ledger(); l.push(entry); if (l.length > MAX_ENTRIES) l.splice(0, l.length - MAX_ENTRIES);
  lsSet(LEDGER, l); emit();
  return entry;
}
export function clearLedger() { lsSet(LEDGER, []); lsSet(LIVE, {}); emit(); }

// Live data reported by providers (rate-limit headers, key info, 429 messages)
export function setLive(service, info) { const all = lsGet(LIVE, {}); all[service] = { ...(all[service] || {}), ...info, at: Date.now() }; lsSet(LIVE, all); emit(); }
export function getLive(service) { return lsGet(LIVE, {})[service] || null; }

export function getLimits(service) {
  const custom = lsGet(LIMITS, {});
  return custom[service] ?? DEFAULT_LIMITS[service] ?? [];
}
export function setLimits(service, arr) { const c = lsGet(LIMITS, {}); c[service] = arr; lsSet(LIMITS, c); emit(); }
export function resetLimits() { lsSet(LIMITS, {}); emit(); }

export function windowStart(win, now = new Date()) {
  if (win === 'minute') return now.getTime() - 60_000;
  if (win === 'day') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (win === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return 0;
}
export function totals(service, win, entries = ledger()) {
  const since = windowStart(win);
  const t = { requests: 0, tokens: 0, inTok: 0, outTok: 0, chars: 0, audioSec: 0, ms: 0 };
  for (const e of entries) {
    if (e.service !== service || e.ts < since) continue;
    t.requests += e.requests || 0; t.inTok += e.inTok || 0; t.outTok += e.outTok || 0; t.chars += e.chars || 0;
    t.audioSec += e.audioSec || 0; t.ms += e.ms || 0;
  }
  t.tokens = t.inTok + t.outTok;
  return t;
}

// Compare a planned job against limits. add = {requests, tokens, chars}
export function check(service, add = {}) {
  const lims = getLimits(service); const entries = ledger();
  return lims.map((L) => {
    const used = totals(service, L.window, entries)[L.metric] || 0;
    const plus = add[L.metric] || 0;
    const after = used + plus;
    return { ...L, used, plus, after, pct: L.limit ? after / L.limit : 0, ok: !L.limit || after <= L.limit,
      // per-minute limits aren't blockers: we pace requests instead
      pacing: L.window === 'minute' };
  });
}

export function servicesSeen() {
  const s = new Set(Object.keys(DEFAULT_LIMITS));
  for (const e of ledger()) s.add(e.service);
  return [...s];
}
export const labelFor = (svc) => SERVICE_LABELS[svc] || svc;

export function summarizeRun(run) {
  if (!run) return null;
  const by = {};
  for (const e of run.entries) {
    const b = by[e.service] ||= { service: e.service, label: labelFor(e.service), requests: 0, inTok: 0, outTok: 0, chars: 0, audioSec: 0, ms: 0, models: new Set() };
    b.requests += e.requests || 0; b.inTok += e.inTok || 0; b.outTok += e.outTok || 0; b.chars += e.chars || 0; b.audioSec += e.audioSec || 0; b.ms += e.ms || 0;
    if (e.model) b.models.add(e.model);
  }
  return { id: run.id, label: run.label, started: run.started, ended: run.ended, services: Object.values(by).map((b) => ({ ...b, models: [...b.models] })) };
}

// Parse Gemini 429 error body to learn quota info
export function parseGeminiQuota(errJson) {
  try {
    const det = errJson?.error?.details || [];
    const out = {};
    for (const d of det) {
      if (d['@type']?.includes('QuotaFailure')) {
        const v = d.violations?.[0];
        if (v) { out.quotaId = v.quotaId; out.metric = v.quotaMetric; out.limit = Number(v.quotaValue) || undefined; }
      }
      if (d['@type']?.includes('RetryInfo') && d.retryDelay) out.retrySec = parseFloat(d.retryDelay);
    }
    return out;
  } catch { return {}; }
}
