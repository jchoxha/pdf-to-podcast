// Persistence: settings in localStorage, episodes (with audio) in IndexedDB.

const LS_KEY = 'pdfpod.settings.v1';

export function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(defaults);
    return deepMerge(structuredClone(defaults), JSON.parse(raw));
  } catch { return structuredClone(defaults); }
}
export function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { console.warn('settings not saved', e); }
}
function deepMerge(a, b) {
  if (Array.isArray(b)) return b;
  if (b && typeof b === 'object') {
    for (const k of Object.keys(b)) a[k] = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? deepMerge(a[k], b[k]) : b[k];
    return a;
  }
  return b;
}

export function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
export function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('lsSet failed', key, e); } }

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('pdfpod', 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('episodes')) d.createObjectStore('episodes', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('episodes', mode); const s = t.objectStore('episodes');
    const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
  });
}
export async function saveEpisode(ep) { try { await tx('readwrite', (s) => s.put(ep)); return true; } catch (e) { console.warn('episode not saved', e); return false; } }
export async function listEpisodes() {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const out = []; const r = d.transaction('episodes').objectStore('episodes').openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { const { audio, ...meta } = c.value; out.push({ ...meta, hasAudio: !!audio }); c.continue(); } else res(out.sort((a, b) => b.created - a.created)); };
      r.onerror = () => rej(r.error);
    });
  } catch { return []; }
}
export async function getEpisode(id) { try { return await tx('readonly', (s) => s.get(id)); } catch { return null; } }
export async function deleteEpisode(id) { try { await tx('readwrite', (s) => s.delete(id)); } catch (e) { console.warn(e); } }
