// Tiny DOM helpers and formatting.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'innerHTML') el[k] = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function mount(el, ...kids) { el.replaceChildren(); append(el, kids); return el; }

let toastT;
export function toast(msg, ms = 3200) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const fmtInt = (n) => Math.round(n || 0).toLocaleString();
export function fmtK(n) { n = Math.round(n || 0); return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h_ ? `${h_}h ${m}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
export const fmtClock = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
export const slug = (s) => (s || 'podcast').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'podcast';
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function modal(title, body, actions = []) {
  const close = () => m.remove();
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) close(); } },
    h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'row between' }, h('h2', { style: { margin: 0, fontSize: '18px' } }, title), h('button', { class: 'btn ghost small', onclick: close, 'aria-label': 'Close' }, 'Close')),
      h('div', { style: { marginTop: '12px' } }, body),
      actions.length ? h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'flex-end' } }, actions.map((a) => h('button', { class: 'btn ' + (a.primary ? 'primary' : ''), onclick: () => { a.onClick?.(); if (a.close !== false) close(); } }, a.label))) : null));
  document.body.append(m);
  return close;
}

// Meter for usage: used (solid) + planned (tinted)
export function meter(label, used, plus, limit, unit = '') {
  const pctUsed = limit ? Math.min(1, used / limit) : 0, pctPlus = limit ? Math.min(1 - pctUsed, plus / limit) : 0;
  const after = used + plus;
  const cls = !limit ? '' : after > limit ? 'bad' : after > limit * 0.8 ? 'warn' : '';
  return h('div', { class: 'meter' },
    h('span', null, label),
    h('span', { class: 'muted' }, limit ? `${fmtK(used)}${plus ? ` + ${fmtK(plus)}` : ''} / ${fmtK(limit)}${unit}` : `${fmtK(used)}${plus ? ` + ${fmtK(plus)}` : ''}${unit}`),
    limit ? h('div', { class: 'bar ' + cls }, h('i', { style: { width: pctUsed * 100 + '%' } }), h('i', { class: 'plus', style: { left: pctUsed * 100 + '%', width: pctPlus * 100 + '%' } })) : null);
}
