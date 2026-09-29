// Usage tab: live meters per service, editable limits, run history, export.
import { h, mount, fmtK, fmtInt, fmtDur, download, toast } from './ui.js';
import { servicesSeen, labelFor, getLimits, setLimits, resetLimits, totals, getLive, ledger, clearLedger, onUsageChange } from './usage.js';
import { lsGet, lsSet } from './store.js';
import { S } from './state.js';
import { openRouterKeyInfo } from './llm.js';
import { LLM_PROVIDERS } from './config.js';

const RUNS = 'pdfpod.runs.v1';
export function saveRunSummary(sum) { if (!sum?.services?.length) return; const r = lsGet(RUNS, []); r.unshift(sum); lsSet(RUNS, r.slice(0, 100)); }

let rootEl = null; let editing = null;
onUsageChange(() => { if (rootEl?.classList.contains('active')) renderUsage(rootEl); });

function limitMeter(svc, L) {
  const used = totals(svc, L.window)[L.metric] || 0;
  const pct = L.limit ? used / L.limit : 0;
  const cls = pct > 1 ? 'bad' : pct > 0.8 ? 'warn' : '';
  return h('div', { class: 'meter' },
    h('span', null, `${L.metric === 'chars' ? 'Characters' : L.metric === 'tokens' ? 'Tokens' : 'Requests'} per ${L.window}`),
    h('span', { class: 'muted' }, `${fmtK(used)} / ${fmtK(L.limit)} · ${fmtK(Math.max(0, L.limit - used))} left`),
    h('div', { class: 'bar ' + cls }, h('i', { style: { width: Math.min(100, pct * 100) + '%' } })),
    L.note ? h('span', { class: 'small faint', style: { gridColumn: '1 / -1' } }, L.note) : null);
}

function liveInfo(svc) {
  const L = getLive(svc); if (!L) return null;
  const bits = [];
  if (L.remainingRequestsDay != null) bits.push(`Groq reports ${fmtInt(L.remainingRequestsDay)} of ${fmtInt(L.limitRequestsDay)} requests left today, ${fmtInt(L.remainingTokensMin)} of ${fmtInt(L.limitTokensMin)} tokens left this minute`);
  if (L.keyUsage != null) bits.push(`OpenRouter key: ${L.isFreeTier ? 'free tier' : 'has credits'}, usage $${(+L.keyUsage).toFixed(4)}${L.keyLimit != null ? ` of $${L.keyLimit}` : ''}`);
  if (L.learnedLimit) bits.push(`Provider reported a limit of ${fmtInt(L.learnedLimit)} for ${L.quotaId || 'this quota'}`);
  if (L.exhausted) bits.push('Quota reported as used up' + (L.lastError ? `: ${L.lastError}` : ''));
  else if (L.lastError) bits.push('Last error: ' + L.lastError);
  if (!bits.length) return null;
  return h('div', { class: 'note small ' + (L.exhausted ? 'bad' : ''), style: { marginTop: '6px' } }, h('b', null, 'Live from provider: '), bits.join(' · '), h('span', { class: 'faint' }, ` (${new Date(L.at).toLocaleTimeString()})`));
}

function limitEditor(svc) {
  const lims = structuredClone(getLimits(svc));
  const rows = lims.map((L, i) => h('div', { class: 'row', style: { marginTop: '6px' } },
    h('select', { onchange: (e) => (L.metric = e.target.value) }, ['requests', 'tokens', 'chars'].map((m) => h('option', { value: m, selected: L.metric === m }, m))),
    h('span', null, 'per'),
    h('select', { onchange: (e) => (L.window = e.target.value) }, ['minute', 'day', 'month'].map((w) => h('option', { value: w, selected: L.window === w }, w))),
    h('input', { type: 'number', min: 0, value: L.limit, style: { width: '140px' }, onchange: (e) => (L.limit = +e.target.value) }),
    h('button', { class: 'btn small ghost danger', onclick: () => { lims.splice(i, 1); setLimits(svc, lims); } }, 'Remove')));
  return h('div', { style: { marginTop: '8px' } }, rows,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn small', onclick: () => { lims.push({ metric: 'requests', window: 'day', limit: 100 }); setLimits(svc, lims); } }, 'Add limit'),
      h('button', { class: 'btn small primary', onclick: () => { setLimits(svc, lims); editing = null; renderUsage(rootEl); toast('Limits saved'); } }, 'Save'),
      h('button', { class: 'btn small ghost', onclick: () => { editing = null; renderUsage(rootEl); } }, 'Cancel')));
}

function serviceCard(svc) {
  const day = totals(svc, 'day'), month = totals(svc, 'month');
  const lims = getLimits(svc).filter((l) => l.window !== 'minute');
  const minute = getLimits(svc).filter((l) => l.window === 'minute');
  const isTts = svc.startsWith('tts:');
  const summary = (t) => svc === 'tts:kokoro' ? `${fmtK(t.chars)} chars · ${fmtDur(t.audioSec)} audio · ${fmtDur(t.ms / 1000)} rendering` : isTts ? `${fmtInt(t.requests)} req · ${fmtK(t.chars)} chars · ${fmtDur(t.audioSec)} audio` : `${fmtInt(t.requests)} req · ${fmtK(t.inTok)} in / ${fmtK(t.outTok)} out tokens`;
  const prov = svc.startsWith('llm:') ? svc.slice(4) : null;
  return h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { class: 'row between' }, h('b', null, labelFor(svc)),
      h('div', { class: 'row' },
        prov === 'openrouter' && S.keys.openrouter ? h('button', { class: 'btn small', onclick: async () => { try { await openRouterKeyInfo(S.keys.openrouter); } catch (e) { toast(e.message); } } }, 'Check key usage') : null,
        prov && LLM_PROVIDERS[prov]?.usageUrl ? h('a', { class: 'btn small', href: LLM_PROVIDERS[prov].usageUrl, target: '_blank', rel: 'noopener' }, 'Provider dashboard') : null,
        svc.startsWith('tts:gemini') ? h('a', { class: 'btn small', href: 'https://aistudio.google.com/rate-limit', target: '_blank', rel: 'noopener' }, 'Provider dashboard') : null,
        h('button', { class: 'btn small', onclick: () => { editing = editing === svc ? null : svc; renderUsage(rootEl); } }, 'Edit limits'))),
    h('div', { class: 'grid2', style: { marginTop: '8px' } },
      h('div', { class: 'small' }, h('div', { class: 'muted' }, 'Today'), summary(day)),
      h('div', { class: 'small' }, h('div', { class: 'muted' }, 'This month'), summary(month))),
    lims.length ? h('div', { style: { marginTop: '8px' } }, lims.map((L) => limitMeter(svc, L))) : h('div', { class: 'small faint', style: { marginTop: '8px' } }, svc === 'tts:kokoro' ? 'Unlimited: runs on your device.' : 'No free-tier cap set. Add one with Edit limits if your plan has one.'),
    minute.length ? h('div', { class: 'small faint' }, 'Paced automatically: ', minute.map((l) => `${l.limit} ${l.metric}/minute`).join(', ')) : null,
    liveInfo(svc),
    editing === svc ? limitEditor(svc) : null);
}

export function renderUsage(root) {
  rootEl = root;
  const led = ledger();
  const used = new Set(led.map((e) => e.service));
  const current = new Set(['llm:' + S.llm.provider, S.tts.engine === 'google' ? null : 'tts:' + S.tts.engine].filter(Boolean));
  const all = servicesSeen();
  const primary = all.filter((s) => used.has(s) || current.has(s));
  const others = all.filter((s) => !primary.includes(s));
  const runs = lsGet(RUNS, []);
  mount(root,
    h('div', { class: 'card' },
      h('h2', null, 'Usage & free-tier limits'),
      h('p', { class: 'sub' }, 'Every request this app makes is counted here, in this browser. Limits are the published free-tier amounts where known; providers change them, so edit any that differ for your account. Where a provider reports live numbers (Groq headers, OpenRouter key info, Gemini quota errors) they are shown too. Days reset at local midnight, months on the 1st.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => exportCsv(led) }, 'Export CSV'),
        h('button', { class: 'btn small', onclick: () => { resetLimits(); toast('Limits reset to defaults'); } }, 'Reset limits to defaults'),
        h('button', { class: 'btn small danger', onclick: () => { if (confirm('Clear all usage history in this browser?')) { clearLedger(); lsSet(RUNS, []); renderUsage(root); } } }, 'Clear history'))),
    primary.map(serviceCard),
    others.length ? h('details', { style: { margin: '8px 0 16px' } }, h('summary', null, `Other services (${others.length}, unused so far)`), h('div', { style: { marginTop: '10px' } }, others.map(serviceCard))) : null,
    h('div', { class: 'card' }, h('h2', null, 'Recent generations'),
      runs.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('tr', null, h('th', null, 'When'), h('th', null, 'What'), h('th', null, 'Service'), h('th', { class: 'n' }, 'Req'), h('th', { class: 'n' }, 'Tokens'), h('th', { class: 'n' }, 'Chars'), h('th', { class: 'n' }, 'Audio'), h('th', { class: 'n' }, 'Took')),
        runs.slice(0, 40).flatMap((r) => r.services.map((s, i) => h('tr', null,
          h('td', null, i ? '' : new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
          h('td', null, i ? '' : r.label), h('td', null, s.label), h('td', { class: 'n' }, s.requests), h('td', { class: 'n' }, fmtK(s.inTok + s.outTok)), h('td', { class: 'n' }, fmtK(s.chars)),
          h('td', { class: 'n' }, s.audioSec ? fmtDur(s.audioSec) : '–'), h('td', { class: 'n' }, i ? '' : fmtDur(((r.ended || r.started) - r.started) / 1000))))))) : h('p', { class: 'muted' }, 'Nothing generated yet.')));
}

function exportCsv(led) {
  const cols = ['ts', 'service', 'model', 'kind', 'requests', 'inTok', 'outTok', 'chars', 'audioSec', 'ms', 'failed', 'runId'];
  const rows = [cols.join(','), ...led.map((e) => cols.map((c) => c === 'ts' ? new Date(e.ts).toISOString() : JSON.stringify(e[c] ?? '')).join(','))];
  download(new Blob([rows.join('\n')], { type: 'text/csv' }), 'podcast-usage.csv');
}
