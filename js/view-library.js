// Library tab: episodes saved in this browser.
import { h, mount, fmtClock, download, slug, toast } from './ui.js';
import { listEpisodes, getEpisode, deleteEpisode } from './store.js';

export async function renderLibrary(root, { openEpisode }) {
  mount(root, h('div', { class: 'card' }, h('h2', null, 'Library'), h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' Loading...')));
  const eps = await listEpisodes();
  const items = eps.map((ep) => h('div', { class: 'card libitem', style: { marginBottom: 0 } },
    h('div', null, h('b', null, ep.title || 'Untitled'),
      h('div', { class: 'small muted' }, `${new Date(ep.updated || ep.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${ep.lines?.length || 0} lines · ${ep.hasAudio ? fmtClock(ep.durationSec) + ' audio' : 'script only'}`),
      h('div', { class: 'small faint' }, ep.source || '')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: async () => openEpisode(await getEpisode(ep.id)) }, ep.hasAudio ? 'Open & play' : 'Open'),
      ep.hasAudio ? h('button', { class: 'btn small', onclick: async () => { const e = await getEpisode(ep.id); download(e.audio, slug(e.title) + '.mp3'); } }, 'MP3') : null,
      h('button', { class: 'btn small ghost danger', onclick: async () => { if (confirm(`Delete "${ep.title}" from this browser?`)) { await deleteEpisode(ep.id); toast('Deleted'); renderLibrary(root, { openEpisode }); } } }, 'Delete'))));
  mount(root,
    h('div', { class: 'card' }, h('h2', null, 'Library'), h('p', { class: 'sub', style: { margin: 0 } }, 'Episodes are saved in this browser only (nothing is uploaded). Download MP3s to keep them elsewhere.')),
    items.length ? h('div', { class: 'lib' }, items) : h('div', { class: 'card muted' }, 'No episodes yet. Create one from the Create tab.'));
}
