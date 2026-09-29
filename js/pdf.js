// PDF loading, outline (chapters/sections) and text extraction.
import * as pdfjs from '../vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export async function loadPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  let labels = null; try { labels = await doc.getPageLabels(); } catch {}
  const meta = await doc.getMetadata().catch(() => null);
  const outline = await buildOutline(doc);
  return { doc, numPages: doc.numPages, labels, outline, title: meta?.info?.Title || file.name.replace(/\.pdf$/i, ''), textCache: new Map() };
}

async function destToPage(doc, dest) {
  try {
    if (typeof dest === 'string') dest = await doc.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (typeof ref === 'number') return ref + 1;
    return (await doc.getPageIndex(ref)) + 1;
  } catch { return null; }
}

// Returns flat list: {id, title, level, start, end, children:[ids]}
async function buildOutline(doc) {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw?.length) return [];
  const flat = []; let n = 0;
  async function walk(items, level, parent) {
    for (const it of items) {
      const node = { id: 'o' + n++, title: (it.title || '').trim() || 'Untitled', level, start: await destToPage(doc, it.dest), parent, children: [] };
      flat.push(node); if (parent) parent.children.push(node.id);
      if (it.items?.length) await walk(it.items, level + 1, node);
    }
  }
  await walk(raw, 0, null);
  // fill missing starts from first child
  for (let i = flat.length - 1; i >= 0; i--) if (flat[i].start == null) { const c = flat.find((f) => f.parent === flat[i] && f.start); if (c) flat[i].start = c.start; }
  // end page = page before next node at same or higher level (in document order)
  const ordered = flat.filter((f) => f.start);
  for (const node of flat) {
    if (!node.start) continue;
    const idx = flat.indexOf(node);
    let end = doc.numPages;
    for (let j = idx + 1; j < flat.length; j++) {
      if (flat[j].level <= node.level && flat[j].start) { end = Math.max(node.start, flat[j].start - (flat[j].start > node.start ? 1 : 0)); break; }
    }
    node.end = end;
  }
  for (const f of flat) delete f.parent;
  return ordered.length ? flat.filter((f) => f.start) : [];
}

// Parse "12-30, 45, 50-52" into sorted unique page numbers.
export function parseRanges(str, max) {
  const out = new Set();
  for (const part of (str || '').split(/[,;\s]+/)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/); if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let p = Math.max(1, a); p <= Math.min(max, b); p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}
export function rangesToString(pages) {
  const out = []; let s = null, prev = null;
  for (const p of pages) { if (s == null) s = prev = p; else if (p === prev + 1) prev = p; else { out.push(s === prev ? `${s}` : `${s}-${prev}`); s = prev = p; } }
  if (s != null) out.push(s === prev ? `${s}` : `${s}-${prev}`);
  return out.join(', ');
}

async function pageLines(pdf, p) {
  if (pdf.textCache.has(p)) return pdf.textCache.get(p);
  const page = await pdf.doc.getPage(p);
  const tc = await page.getTextContent();
  const lines = []; let cur = ''; let lastY = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const y = it.transform?.[5];
    if (lastY != null && Math.abs(y - lastY) > 2 && cur) { lines.push(cur); cur = ''; }
    cur += it.str;
    if (it.hasEOL) { lines.push(cur); cur = ''; }
    lastY = y;
  }
  if (cur) lines.push(cur);
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  pdf.textCache.set(p, clean); page.cleanup();
  return clean;
}

// Extract readable text for pages; strips repeated headers/footers and page numbers; joins hyphenated breaks.
export async function extractText(pdf, pages, onProgress = () => {}) {
  const per = [];
  for (let i = 0; i < pages.length; i++) { per.push(await pageLines(pdf, pages[i])); if (i % 5 === 0) onProgress(i + 1, pages.length); }
  onProgress(pages.length, pages.length);
  // repeated short lines at top/bottom across pages = running headers/footers
  const freq = new Map();
  const norm = (l) => l.toLowerCase().replace(/\d+/g, '#');
  for (const ls of per) { const edge = new Set([...ls.slice(0, 2), ...ls.slice(-2)].map(norm)); for (const e of edge) freq.set(e, (freq.get(e) || 0) + 1); }
  const thresh = Math.max(3, pages.length * 0.3);
  const out = [];
  per.forEach((ls, i) => {
    const kept = ls.filter((l, j) => {
      const edge = j < 2 || j >= ls.length - 2;
      if (edge && /^(page\s*)?[#\divxlc]+$/i.test(l.trim())) return false;
      if (edge && l.length < 90 && (freq.get(norm(l)) || 0) >= thresh) return false;
      return true;
    });
    // merge lines into paragraphs
    let text = '';
    for (const l of kept) {
      if (!text) { text = l; continue; }
      if (/-$/.test(text) && /^[a-z]/.test(l)) text = text.slice(0, -1) + l;
      else if (/[.!?:"”]$/.test(text) && /^[A-Z0-9•\-–(]/.test(l) && l.length < 200) text += '\n' + l;
      else text += ' ' + l;
    }
    out.push({ page: pages[i], text });
  });
  const joined = out.map((o) => o.text).join('\n\n').replace(/\n(?=[a-z])/g, ' ');
  return { text: joined, pages: out, words: (joined.match(/\S+/g) || []).length };
}

export async function quickWordCount(pdf, pages) {
  // Sample-based fast estimate for large selections
  if (pages.length <= 40) return (await extractText(pdf, pages)).words;
  const step = Math.ceil(pages.length / 20); let w = 0, n = 0;
  for (let i = 0; i < pages.length; i += step) { const ls = await pageLines(pdf, pages[i]); w += ls.join(' ').split(/\s+/).length; n++; }
  return Math.round((w / n) * pages.length);
}

export function pageLabel(pdf, p) { return pdf.labels?.[p - 1] || String(p); }
