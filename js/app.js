// SpotScore app shell: state, router, screens ("Malachite" design, handoff 3a).

import { db, now, STORES } from './db.js';
import { createScoring, ratingKey, fmt } from './scoring.js';
import { createElo } from './elo.js';
import * as spotify from './spotify.js';
import { buildDemo } from './demo.js';
import { esc, fmtCalc, ratingPill, calcPill, eloText, changeText, wedge, wedgePanel, enableSwipeRate, podium } from './ui.js';

// ---------- State ----------
const state = {
  tracks: new Map(), albums: new Map(), artists: new Map(),
  ratings: new Map(), elo: new Map(), suggestions: new Map(),
  bracket: null, mode: null, connected: false, h2h: null,
  demoPlaying: null, syncing: null, genreProgress: null,
};
const scoring = createScoring(state);
const elo = createElo(state, scoring);
const ui = { lib: { tracks: { q: '', sort: 'added', genre: '' }, albums: { q: '', sort: 'added', genre: '' }, artists: { q: '', sort: 'name', genre: '' } }, scroll: new Map(), count: new Map(), inlineOpen: null };

const toMap = (rows) => new Map(rows.map(r => [r.id, r]));
async function loadState() {
  const [tracks, albums, artists, ratings, eloRows, sugs, brackets] = await Promise.all(
    ['tracks', 'albums', 'artists', 'ratings', 'elo', 'suggestions', 'brackets'].map(s => db.all(s)));
  Object.assign(state, {
    tracks: toMap(tracks), albums: toMap(albums), artists: toMap(artists),
    ratings: toMap(ratings), elo: toMap(eloRows), suggestions: toMap(sugs),
    bracket: brackets.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null,
    mode: await db.getMeta('mode'),
    connected: await spotify.isConnected(),
  });
}

async function setRating(type, refId, value, { quiet = false } = {}) {
  const id = ratingKey(type, refId);
  const prev = state.ratings.get(id);
  // Cleared ratings stay as tombstones (value null) for a later cloud merge.
  const rec = { id, type, refId, value, createdAt: prev?.createdAt || now(), updatedAt: now() };
  state.ratings.set(id, rec);
  await db.put('ratings', rec);
  if (state.suggestions.has(id)) { state.suggestions.delete(id); await db.delete('suggestions', id); }
  updateBadge();
  drawPlayer();
  if (!quiet) toast(value == null ? 'Rating cleared' : `Saved ${fmt(value)}`, 1400);
}

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const initials = (s) => s.replace(/^The /, '').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, w) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;
const num = (n) => n.toLocaleString('en');
const TYPE_LABEL = { track: 'Tracks', album: 'Albums', artist: 'Artists' };
const DEFAULT_CLIENT_ID = 'a511f15bb84346ccaf4a4317b1285269'; // SpotScore app in the Spotify developer dashboard
const year = (d) => (d || '').slice(0, 4);

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Real covers are shown square, uncropped and without overlays.
function art(item, size = 'sm', round = false) {
  const url = size === 'sm' ? (item.imageSmall || item.albumImageSmall || item.image || item.albumImage) : (item.image || item.albumImage);
  const cls = `art ${size}${round ? ' round' : ''}`;
  if (url) return `<img class="${cls}" src="${esc(url)}" loading="lazy" alt="">`;
  const seed = item.albumId || item.id;
  return `<div class="${cls} ph" style="--h:${hash(seed) % 360}" aria-hidden="true"><span>${esc(initials(item.albumName || item.name || '?'))}</span></div>`;
}

// SpotScore's own mark: a rising wedge of bars in a rounded square. Deliberately
// not green and not a circle, which Spotify reserves for its own logo.
const logoMark = (cls = '') => `<span class="logo ${cls}" aria-hidden="true"><svg viewBox="0 0 34 34"><rect x="7" y="20" width="5" height="7" rx="1.5"/><rect x="14.5" y="14" width="5" height="13" rx="1.5"/><rect x="22" y="8" width="5" height="19" rx="1.5"/></svg></span>`;

// Spotify attribution (Design & Branding Guidelines): Spotify metadata and covers
// must be accompanied by the unmodified Spotify logo, and link back to Spotify.
// Only shown for a real Spotify library; the demo library is fictional.
const hasSpotifyContent = () => state.mode === 'spotify';
const spotifyLogo = (cls = '') => (hasSpotifyContent() ? `<img class="spotify-logo ${cls}" src="icons/spotify/Spotify_Full_Logo_White_RGB.svg" alt="Spotify">` : '');
const spotifyIcon = () => (hasSpotifyContent() ? '<img class="spotify-icon" src="icons/spotify/Spotify_Icon_White_RGB.svg" alt="Spotify">' : '');

const head = (title, { sub = '', logo = false, right = '', attrib = true } = {}) =>
  `<header class="head">${logo ? logoMark() : ''}<div class="head-text"><h1>${esc(title)}</h1>${sub ? `<span class="sub">${sub}</span>` : ''}</div>${right}${attrib ? spotifyLogo() : ''}</header>`;

const listenOnSpotify = (type, id) => (hasSpotifyContent()
  ? `<a class="attrib" href="https://open.spotify.com/${type}/${id}" target="_blank" rel="noopener">${spotifyLogo()}<span>Listen on Spotify ↗</span></a>` : '');

function describe(type, id) {
  if (type === 'track') {
    const t = state.tracks.get(id);
    return t && { title: t.name, sub: `${t.artists.map(a => a.name).join(', ')} · ${t.albumName}`, art: (s) => art(t, s), href: `#/track/${id}` };
  }
  if (type === 'album') {
    const a = state.albums.get(id);
    if (!a) return null;
    const avg = scoring.albumTrackAvg(id);
    return { title: a.name, sub: `${a.artists.map(x => x.name).join(', ')} · ${year(a.releaseDate)}${avg != null ? ` · ø${fmtCalc(avg)}` : ''}`, art: (s) => art(a, s), href: `#/album/${id}` };
  }
  const ar = state.artists.get(id);
  return ar && { title: ar.name, sub: `${ar.genres.length ? ar.genres.slice(0, 2).join(', ') : 'No genres yet'} · ${plural(ar.trackIds.length, 'track')}`, art: (s) => art(ar, s, true), href: `#/artist/${id}` };
}

function genresOf(type, id) {
  const ids = type === 'artist' ? [id]
    : type === 'album' ? (state.albums.get(id)?.artists || []).map(a => a.id)
    : (state.tracks.get(id)?.artists || []).map(a => a.id);
  return new Set(ids.flatMap(a => state.artists.get(a)?.genres || []));
}

function allGenres() {
  const count = new Map();
  for (const a of state.artists.values()) for (const g of a.genres) count.set(g, (count.get(g) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const collection = (type) => (type === 'track' ? state.tracks : type === 'album' ? state.albums : state.artists);

function pool(type, genre) {
  const ids = [...collection(type).keys()];
  return genre ? ids.filter(id => genresOf(type, id).has(genre)) : ids;
}

// Right-hand number of a row, following the number grammar.
function numberFor(type, id, size = 'md') {
  if (type === 'artist') return calcPill(scoring.artistScore(id), { size });
  return ratingPill(scoring.rating(type, id), { size, rateRef: `${type}:${id}` });
}

function row(type, id, { rank, right, cls = '' } = {}) {
  const d = describe(type, id);
  if (!d) return '';
  return `<a class="row ${cls}" href="${d.href}">${rank != null ? `<span class="rank">${rank}</span>` : ''}${d.art('sm')}
    <span class="meta"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.sub)}</span></span>${right ?? numberFor(type, id)}</a>`;
}

const swipeRow = (type, id) => (type === 'artist' ? row(type, id)
  : `<div class="swipe" data-swipe="${type}:${id}"><div class="swipe-strip"></div>${row(type, id)}</div>`);

// Swipe-to-rate for a list; updates the row's pill in place.
function swipeRating(list) {
  enableSwipeRate(list, {
    getValue: (ref) => { const [t, id] = ref.split(':'); return scoring.rating(t, id); },
    onCommit: async (ref, v) => {
      const [t, id] = ref.split(':');
      await setRating(t, id, v);
      const pill = $(`.swipe[data-swipe="${ref}"] .pill`, list);
      if (pill) pill.outerHTML = numberFor(t, id);
    },
  });
}

// Renders long lists in chunks so library size never blocks the UI.
function lazyList(container, ids, renderItem, key) {
  const CHUNK = 60;
  let shown = 0;
  const target = Math.max(CHUNK, ui.count.get(key) || 0);
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  const add = (n) => {
    const html = ids.slice(shown, shown + n).map((id, i) => renderItem(id, shown + i)).join('');
    sentinel.insertAdjacentHTML('beforebegin', html);
    shown = Math.min(ids.length, shown + n);
    ui.count.set(key, shown);
    if (shown >= ids.length) io.disconnect();
  };
  container.append(sentinel);
  const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) add(CHUNK); }, { rootMargin: '600px' });
  add(target);
  if (shown < ids.length) io.observe(sentinel);
  if (!ids.length) container.insertAdjacentHTML('afterbegin', '<p class="empty">Nothing here yet.</p>');
}

function openSheet(build) {
  const dlg = $('#sheet');
  dlg.innerHTML = '<button class="sheet-close" aria-label="Close">✕</button><div class="sheet-body"></div>';
  build($('.sheet-body', dlg));
  $('.sheet-close', dlg).onclick = () => dlg.close();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', res, { once: true }));
}

async function rateInSheet(type, id) {
  const d = describe(type, id);
  if (!d) return;
  await openSheet((body) => {
    body.innerHTML = `<div class="sheet-title">${d.art('sm')}<span class="meta"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.sub)}</span></span></div>`;
    body.append(wedgePanel(`Rate ${type} · drag or tap`, scoring.rating(type, id), v => setRating(type, id, v)));
  });
  route();
}

// ---------- Playback ----------
const player = {
  async play(type, id) {
    try {
      let trackId = type === 'track' ? id : null;
      if (type === 'artist') {
        const ar = state.artists.get(id);
        trackId = [...ar.trackIds].sort((a, b) => (scoring.trackScore(b) ?? 0) - (scoring.trackScore(a) ?? 0))[0];
      }
      if (state.mode === 'demo' || !state.connected) {
        const t = trackId ? state.tracks.get(trackId) : state.tracks.get(state.albums.get(id).trackIds[0]);
        state.demoPlaying = { track: t, playing: true };
        drawPlayer();
        toast(state.mode === 'demo' ? 'Demo mode: simulated playback, no audio.' : 'Connect Spotify in Settings to play on your phone.');
        return;
      }
      if (type === 'album') await spotify.playback.playAlbum(state.albums.get(id).uri);
      else { const tr = state.tracks.get(trackId); await spotify.playback.playTrack(tr.uri, tr.albumUri); }
      // Spotify can accept a play request (204) and still load nothing: say so.
      setTimeout(async () => {
        await refreshPlayer();
        if (!nowPlaying) toast('Spotify accepted the request but did not start playback. Try again from the Spotify app.', 5000);
      }, 1500);
    } catch (e) { playbackError(e); }
  },
  async toggle() {
    if (state.demoPlaying) { state.demoPlaying.playing = !state.demoPlaying.playing; drawPlayer(); return; }
    try {
      const s = await spotify.playback.state();
      await (s?.is_playing ? spotify.playback.pause() : spotify.playback.resume());
      setTimeout(refreshPlayer, 500);
    } catch (e) { playbackError(e); }
  },
  async next() {
    if (state.demoPlaying) {
      const t = state.demoPlaying.track;
      const al = state.albums.get(t.albumId);
      const i = al.trackIds.indexOf(t.id);
      state.demoPlaying = { track: state.tracks.get(al.trackIds[(i + 1) % al.trackIds.length]), playing: true };
      drawPlayer();
      return;
    }
    try { await spotify.playback.next(); setTimeout(refreshPlayer, 700); } catch (e) { playbackError(e); }
  },
};

function playbackError(e) {
  if (e.quota) toast('Spotify request limit reached. Try again later.');
  else if (e.status === 403) toast('Playback needs Spotify Premium.');
  else if (e.status === 404) toast('No active device. Open Spotify on your phone and start any song once.');
  else toast(e.message);
}

let nowPlaying = null;
async function refreshPlayer() {
  if (state.mode !== 'spotify' || !state.connected || document.hidden) return;
  try {
    const s = await spotify.playback.state();
    nowPlaying = s?.item ? { name: s.item.name, artist: s.item.artists.map(a => a.name).join(', '), id: s.item.id, playing: s.is_playing, image: s.item.album.images?.at(-1)?.url } : null;
  } catch { nowPlaying = null; }
  drawPlayer();
}

function drawPlayer() {
  const bar = $('#player');
  let np = nowPlaying;
  if (state.demoPlaying) {
    const t = state.demoPlaying.track;
    np = { name: t.name, artist: t.artists.map(a => a.name).join(', '), id: t.id, playing: state.demoPlaying.playing, demo: true };
  }
  if (!np) { bar.hidden = true; document.body.classList.remove('has-player'); return; }
  bar.hidden = false;
  document.body.classList.add('has-player');
  const t = state.tracks.get(np.id);
  bar.innerHTML = `
    <a class="np" href="${t ? `#/track/${np.id}` : '#/library'}">${t ? art(t, 'sm') : np.image ? `<img class="art sm" src="${esc(np.image)}" alt="">` : ''}
      <span class="meta"><span class="t">${esc(np.name)}</span><span class="s">${esc(np.artist)}${np.demo ? ' · demo' : ''}</span></span></a>
    ${np.demo ? '' : spotifyIcon()}
    ${t ? ratingPill(scoring.trackScore(np.id), { size: 'sm', rateRef: `track:${np.id}`, compact: true }) : ''}
    <button class="icon-btn" data-player="toggle" aria-label="${np.playing ? 'Pause' : 'Play'}">${np.playing ? '❚❚' : '▶'}</button>
    <button class="icon-btn" data-player="next" aria-label="Skip">⏭</button>`;
}

// ---------- Router ----------
const routes = [
  [/^#\/welcome$/, renderWelcome],
  [/^#\/library(?:\/(tracks|albums|artists))?$/, m => renderLibrary(m[1] || 'tracks')],
  [/^#\/track\/(.+)$/, m => renderTrack(m[1])],
  [/^#\/album\/(.+)$/, m => renderAlbum(m[1])],
  [/^#\/artist\/(.+)$/, m => renderArtist(m[1])],
  [/^#\/rate$/, renderRate],
  [/^#\/duel$/, renderDuel],
  [/^#\/h2h$/, renderH2H],
  [/^#\/bracket$/, renderBracket],
  [/^#\/suggestions$/, renderSuggestions],
  [/^#\/rankings(?:\/(tracks|albums|artists|artist-duels))?$/, m => renderRankings(m[1] || 'tracks')],
  [/^#\/settings$/, renderSettings],
];

let lastHash = null;
function route() {
  const h = location.hash || '#/library';
  if (!state.tracks.size && !/^#\/(settings|welcome)$/.test(h)) { location.replace('#/welcome'); return; }
  if (lastHash && lastHash !== h) { ui.scroll.set(lastHash, window.scrollY); ui.inlineOpen = null; }
  const sameView = lastHash === h;
  lastHash = h;
  const match = routes.map(([re, fn]) => [h.match(re), fn]).find(([m]) => m);
  view.innerHTML = '';
  if (!match) { location.replace('#/library'); return; }
  const [m, fn] = match;
  const isDetail = /^#\/(track|album|artist|suggestions)\b/.test(h);
  document.body.classList.toggle('detail', isDetail);
  view.classList.toggle('wash', /^#\/(track|album|artist)\//.test(h));
  $('#back').hidden = !isDetail;
  fn(m);
  const tab = h.split('/')[1];
  const tabFor = { track: 'library', album: 'library', artist: 'library', h2h: 'duel', bracket: 'duel', suggestions: 'duel' }[tab] || tab;
  $$('.tabbar a').forEach(a => { const on = a.dataset.tab === tabFor; a.classList.toggle('active', on); a.toggleAttribute('aria-current', on); });
  if (!sameView) window.scrollTo(0, ui.scroll.get(h) || 0);
}

function setTitle(t) { document.title = t === 'SpotScore' ? t : `${t} · SpotScore`; }

function updateBadge() {
  const n = state.suggestions.size;
  const b = $('#duelBadge');
  b.textContent = n;
  b.hidden = n === 0;
}

// ---------- Screens ----------
function renderWelcome() {
  setTitle('SpotScore');
  view.innerHTML = `
    <section class="welcome">
      ${logoMark('big')}
      <h2>Rate your liked songs and albums</h2>
      <p>Score tracks and albums from 1 to 10, get artist scores automatically, and settle the close calls in head-to-heads and brackets.</p>
      <a class="btn primary" href="#/settings">Connect Spotify</a>
      <button class="btn" id="demoBtn">Try with a demo library</button>
      <p class="fine">Everything is stored on this device. Spotify login uses PKCE, no server is involved.</p>
    </section>`;
  $('#demoBtn').onclick = loadDemo;
}

function renderLibrary(tab) {
  const type = tab.slice(0, -1);
  setTitle('Library');
  const f = ui.lib[tab];
  const genres = allGenres();
  view.innerHTML = `
    ${head('Your library', { logo: true })}
    <nav class="pills" aria-label="Library sections">${['tracks', 'albums', 'artists'].map(t => `<a href="#/library/${t}" class="${t === tab ? 'on' : ''}" ${t === tab ? 'aria-current="page"' : ''}>${t[0].toUpperCase() + t.slice(1)} <small>${num(collection(t.slice(0, -1)).size)}</small></a>`).join('')}</nav>
    <div class="filters">
      <label class="search"><input type="search" id="q" placeholder="Search ${tab}" value="${esc(f.q)}" aria-label="Search ${tab}"></label>
      <select class="chip" id="sort" aria-label="Sort">
        ${type !== 'artist' ? '<option value="added">⇅ Added</option>' : ''}
        <option value="score">⇅ Score</option>
        <option value="name">⇅ Name</option>
        <option value="unrated">⇅ Unrated</option>
      </select>
      <select class="chip" id="genre" aria-label="Genre"><option value="">Genre</option>${genres.map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`).join('')}</select>
    </div>
    ${type !== 'artist' ? '<p class="hint-line">Swipe a row left to rate it in place. Drag sideways over the numbers.</p>' : ''}
    <div class="list" id="list"></div>`;
  $('#sort').value = f.sort;
  $('#genre').value = f.genre;

  const draw = () => {
    const q = f.q.trim().toLowerCase();
    let ids = [...collection(type).keys()];
    if (q) ids = ids.filter(id => { const d = describe(type, id); return (d.title + ' ' + d.sub).toLowerCase().includes(q); });
    if (f.genre) ids = ids.filter(id => genresOf(type, id).has(f.genre));
    const score = (id) => scoring.scoreOf(type, id);
    const name = (id) => describe(type, id).title;
    const added = (id) => type === 'track' ? state.tracks.get(id).addedAt
      : type === 'album' ? state.albums.get(id).trackIds.map(t => state.tracks.get(t).addedAt).sort().at(-1) : '';
    const sorters = {
      added: (a, b) => added(b).localeCompare(added(a)),
      name: (a, b) => name(a).localeCompare(name(b)),
      score: (a, b) => (score(b) ?? -1) - (score(a) ?? -1),
      unrated: (a, b) => (score(a) == null ? 0 : 1) - (score(b) == null ? 0 : 1) || added(b).localeCompare(added(a)),
    };
    ids.sort(sorters[f.sort] || sorters.name);
    const list = $('#list');
    list.innerHTML = '';
    lazyList(list, ids, id => swipeRow(type, id), `lib:${tab}`);
  };
  swipeRating($('#list'));
  $('#q').addEventListener('input', (e) => { f.q = e.target.value; ui.count.delete(`lib:${tab}`); draw(); });
  $('#sort').addEventListener('change', (e) => { f.sort = e.target.value; ui.count.delete(`lib:${tab}`); draw(); });
  $('#genre').addEventListener('change', (e) => { f.genre = e.target.value; ui.count.delete(`lib:${tab}`); draw(); });
  draw();
}

function detailHeader(item, { type, id, title, by, info, round = false }) {
  return `
    <div class="cover-wrap">${art(item, 'lg', round)}</div>
    <div class="title-row">
      <div class="meta"><h2>${esc(title)}</h2>${by ? `<span class="by">${by}</span>` : ''}<span class="info">${info}</span></div>
      <button class="play-btn lg" data-play="${type}:${id}" aria-label="Play"></button>
    </div>
    ${listenOnSpotify(type, id)}`;
}

function renderTrack(id) {
  const t = state.tracks.get(id);
  if (!t) { view.innerHTML = '<p class="empty">Track not found.</p>'; return; }
  setTitle(t.name);
  const e = elo.eloOf('track', id);
  view.innerHTML = `
    ${detailHeader(t, { type: 'track', id, title: t.name,
      by: t.artists.map(a => `<a href="#/artist/${a.id}">${esc(a.name)}</a>`).join(', '),
      info: `Track · <a href="#/album/${t.albumId}">${esc(t.albumName)}</a> · ${year(t.albumReleaseDate)}` })}
    <div class="panels">
      <div class="panel"><span class="label">Your rating</span><span id="ratingPill">${ratingPill(scoring.trackScore(id), { size: 'lg' })}</span></div>
      <div class="panel"><span class="label">Duels</span>${eloText(e)}<span class="fine">Liked ${new Date(t.addedAt).toLocaleDateString()}</span></div>
    </div>
    <div id="slider"></div>`;
  $('#slider').append(wedgePanel('Rate track · drag or tap', scoring.trackScore(id), async v => {
    await setRating('track', id, v);
    $('#ratingPill').innerHTML = ratingPill(v, { size: 'lg' });
  }));
}

function renderAlbum(id) {
  const a = state.albums.get(id);
  if (!a) { view.innerHTML = '<p class="empty">Album not found.</p>'; return; }
  setTitle(a.name);
  const avgPanel = () => {
    const rated = a.trackIds.filter(t => scoring.trackScore(t) != null).length;
    return `<span class="label">Track average · ${rated} of ${a.trackIds.length} rated</span>${calcPill(scoring.albumTrackAvg(id), { size: 'lg' })}`;
  };
  view.innerHTML = `
    ${detailHeader(a, { type: 'album', id, title: a.name,
      by: a.artists.map(x => `<a href="#/artist/${x.id}">${esc(x.name)}</a>`).join(', '),
      info: `Album · ${year(a.releaseDate)}` })}
    <div class="panels">
      <div class="panel"><span class="label">Your rating</span><span id="ratingPill">${ratingPill(scoring.albumScore(id), { size: 'lg' })}</span></div>
      <div class="panel" id="avgPanel">${avgPanel()}</div>
    </div>
    <div id="slider"></div>
    <p class="label section-label">Liked tracks</p>
    <div class="list" id="tracks">${a.trackIds.map(t => {
      const tr = state.tracks.get(t);
      return `<div class="trow" data-tid="${t}"><div class="row compact"><span class="rank">${tr.trackNumber || ''}</span>
        <a class="meta" href="#/track/${t}"><span class="t">${esc(tr.name)}</span></a>
        <span class="pillslot" role="button" tabindex="0" data-inline="${t}" aria-label="Rate ${esc(tr.name)}">${ratingPill(scoring.trackScore(t), { size: 'sm', compact: true })}</span></div></div>`;
    }).join('')}</div>`;
  $('#slider').append(wedgePanel('Rate album · drag or tap', scoring.albumScore(id), async v => {
    await setRating('album', id, v);
    $('#ratingPill').innerHTML = ratingPill(v, { size: 'lg' });
  }));
  // Tapping a track's pill opens an inline slider under the row.
  const openInline = (tid) => {
    $$('.inline-rate', view).forEach(x => x.remove());
    if (ui.inlineOpen === tid) { ui.inlineOpen = null; return; }
    ui.inlineOpen = tid;
    const holder = document.createElement('div');
    holder.className = 'inline-rate';
    holder.append(wedgePanel('Rate track · drag or tap', scoring.trackScore(tid), async v => {
      await setRating('track', tid, v);
      $(`.trow[data-tid="${tid}"] .pillslot`).innerHTML = ratingPill(v, { size: 'sm', compact: true });
      $('#avgPanel').innerHTML = avgPanel();
    }));
    $(`.trow[data-tid="${tid}"]`).append(holder);
  };
  $('#tracks').addEventListener('click', (e) => { const p = e.target.closest('[data-inline]'); if (p) openInline(p.dataset.inline); });
  $('#tracks').addEventListener('keydown', (e) => { const p = e.target.closest('[data-inline]'); if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openInline(p.dataset.inline); } });
  if (ui.inlineOpen) { const tid = ui.inlineOpen; ui.inlineOpen = null; openInline(tid); }
}

function renderArtist(id) {
  const ar = state.artists.get(id);
  if (!ar) { view.innerHTML = '<p class="empty">Artist not found.</p>'; return; }
  setTitle(ar.name);
  const b = scoring.artistBreakdown(id);
  const ranking = artistEloRanking();
  const pos = ranking.findIndex(r => r.refId === id);
  const topTracks = [...ar.trackIds].sort((x, y) => (scoring.trackScore(y) ?? -1) - (scoring.trackScore(x) ?? -1));
  view.innerHTML = `
    ${detailHeader(ar, { type: 'artist', id, title: ar.name, round: true, info: `Artist · ${plural(ar.trackIds.length, 'liked track')}` })}
    ${ar.genres.length ? `<div class="genres" style="margin:-6px 0 14px">${ar.genres.map(g => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
    <div class="panels">
      <div class="panel"><span class="label">Artist score</span>${calcPill(b.score, { size: 'lg' })}</div>
      <div class="panel"><span class="label">Duel ranking</span><b>${pos >= 0 ? `#${pos + 1} of ${ranking.length}` : 'No duels yet'}</b>${pos >= 0 ? eloText(ranking[pos]) : ''}</div>
      <div class="panel"><span class="label">Album average · ${b.albumCount} rated${b.weights ? ` · ${b.weights[0]}%` : ''}</span>${calcPill(b.albumAvg)}</div>
      <div class="panel"><span class="label">Track average · ${b.trackCount} rated${b.weights ? ` · ${b.weights[1]}%` : ''}</span>${calcPill(b.trackAvg)}</div>
    </div>
    <p class="fine">Calculated, not rated directly: 50% album average plus 50% track average. If only one side exists it counts 100%. The duel ranking is separate and does not change this score.</p>
    <p class="label section-label">Albums</p>
    <div class="list">${ar.albumIds.map(a => row('album', a)).join('') || '<p class="fine">No albums as main artist.</p>'}</div>
    <p class="label section-label">Liked tracks</p>
    <div class="list">${topTracks.map(t => row('track', t)).join('')}</div>`;
}

function renderRate() {
  setTitle('Rate');
  const queue = [...state.tracks.values()].filter(t => scoring.trackScore(t.id) == null).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const total = state.tracks.size;
  if (!queue.length) {
    view.innerHTML = `${head('Rate')}<section class="welcome"><h2>All tracks rated</h2><p>All ${num(total)} tracks have a rating. Use duels to fine-tune them.</p><a class="btn primary" href="#/duel">Go to duels</a></section>`;
    return;
  }
  const albumsOpen = [...state.albums.values()].filter(a => scoring.albumScore(a.id) == null).length;
  let i = 0;
  const draw = () => {
    const t = queue[i];
    if (!t) { route(); return; }
    let val = null;
    const left = queue.length - i;
    view.innerHTML = `
      <div class="qr">
        ${head('Rate', { sub: `${num(left)} tracks · ${num(albumsOpen)} albums left` })}
        <div class="progress" role="progressbar" aria-valuenow="${total - left}" aria-valuemax="${total}"><div style="width:${((total - left) / total) * 100}%"></div></div>
        <div class="cover-wrap">${art(t, 'xl')}</div>
        <div class="title-row">
          <div class="meta"><h2>${esc(t.name)}</h2><span class="info">${esc(t.artists.map(a => a.name).join(', '))} · <a href="#/album/${t.albumId}">${esc(t.albumName)}</a></span></div>
          <button class="play-btn ghost" data-play="track:${t.id}" aria-label="Play"></button>
        </div>
        <div id="slider"></div>
        <p class="fine center">Snaps to half steps with a light vibration on each detent.</p>
        <div class="row-actions"><button class="btn" id="skip">Skip</button><button class="btn primary" id="next" disabled>Pick a rating</button></div>
      </div>`;
    const label = (v) => { $('#next').disabled = v == null; $('#next').textContent = v == null ? 'Pick a rating' : `Save ${fmt(v)} · Next`; };
    $('#slider').append(wedge(null, v => { val = v; label(v); }, { size: 'lg', onPreview: label }));
    $('#skip').onclick = () => { i++; draw(); };
    $('#next').onclick = async () => {
      if (val == null) return;
      await setRating('track', t.id, val);
      queue.splice(i, 1);
      draw();
    };
  };
  draw();
}

function choiceGroup(group, options, selected) {
  return `<div class="pills" data-group="${group}" role="radiogroup">${options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === selected}" data-v="${v}" class="${v === selected ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function poolControls(prefix) {
  const genres = allGenres();
  return `
    <label class="field"><span>Compare</span>${choiceGroup(`${prefix}Type`, [['track', 'Tracks'], ['album', 'Albums'], ['artist', 'Artists']], 'track')}</label>
    <label class="field"><span>Pool</span>
      <select id="${prefix}Genre"><option value="">Whole library, random</option>${genres.map(([g, n]) => `<option value="${esc(g)}">Genre: ${esc(g)} (${n} artists)</option>`).join('')}</select></label>`;
}

function readSeg(group) { return $(`[data-group="${group}"] .on`).dataset.v; }

function renderDuel() {
  setTitle('Duel');
  const n = state.suggestions.size;
  const b = state.bracket;
  view.innerHTML = `
    ${head('Duel', { attrib: false })}
    ${n ? `<a class="card notice" href="#/suggestions"><b>${plural(n, 'rating suggestion')}</b><span>Review the changes your duels suggest</span><span class="arrow">›</span></a>` : ''}
    ${b && !b.done ? `<a class="card notice" href="#/bracket"><b>Resume bracket</b><span>${TYPE_LABEL[b.type]} · ${b.size} · ${esc(b.poolLabel)} · ${roundName(b.rounds[b.current.r].length)}</span><span class="arrow">›</span></a>` : ''}
    <section class="card">
      <h3>Head-to-head</h3>
      <p class="fine">Endless pairs of close matches. Each pick updates Elo.</p>
      ${poolControls('h')}
      <p class="fine" id="hInfo"></p>
      <button class="btn primary block" id="hStart">Start head-to-head</button>
    </section>
    <section class="card">
      <h3>Bracket</h3>
      <p class="fine">Single elimination. Tracks and albums produce rating suggestions, artists only move in the artist duel ranking.</p>
      ${poolControls('b')}
      <label class="field"><span>Size</span>${choiceGroup('bSize', [['8', '8'], ['16', '16'], ['32', '32'], ['64', '64']], '16')}</label>
      <p class="fine" id="bInfo"></p>
      <button class="btn primary block" id="bStart">Start bracket</button>
    </section>`;
  $$('[data-group]').forEach(seg => seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    $$('button', seg).forEach(x => { x.classList.toggle('on', x === btn); x.setAttribute('aria-checked', x === btn); });
    info();
  }));
  const info = () => {
    const hp = pool(readSeg('hType'), $('#hGenre').value);
    $('#hInfo').textContent = `${num(hp.length)} ${TYPE_LABEL[readSeg('hType')].toLowerCase()} in pool`;
    $('#hStart').disabled = hp.length < 2;
    const bp = pool(readSeg('bType'), $('#bGenre').value);
    const size = Number(readSeg('bSize'));
    $('#bInfo').textContent = bp.length >= size ? `${num(bp.length)} in pool, ${size} drawn at random` : `Only ${bp.length} in pool, choose a smaller size or another genre.`;
    $('#bStart').disabled = bp.length < size;
  };
  $('#hGenre').onchange = info;
  $('#bGenre').onchange = info;
  info();
  $('#hStart').onclick = () => {
    const type = readSeg('hType');
    const genre = $('#hGenre').value;
    state.h2h = { type, genre, pool: pool(type, genre), count: 0, last: null, pair: null, feedback: null };
    location.hash = '#/h2h';
  };
  $('#bStart').onclick = async () => {
    if (b && !b.done && !confirm('Replace the unfinished bracket?')) return;
    const type = readSeg('bType');
    const genre = $('#bGenre').value;
    const size = Number(readSeg('bSize'));
    const ids = shuffle(pool(type, genre)).slice(0, size);
    const first = [];
    for (let k = 0; k < ids.length; k += 2) first.push({ a: ids[k], b: ids[k + 1], winner: null });
    state.bracket = { id: `bracket:${now()}`, type, size, poolLabel: genre || 'Random', rounds: [first], current: { r: 0, m: 0 }, done: false, champion: null, createdAt: now(), updatedAt: now() };
    await db.put('brackets', state.bracket);
    location.hash = '#/bracket';
  };
}

function roundName(matches) {
  return matches === 1 ? 'Final' : matches === 2 ? 'Semifinals' : matches === 4 ? 'Quarterfinals' : `Round of ${matches * 2}`;
}

function duelCard(type, id) {
  const d = describe(type, id);
  const e = elo.eloOf(type, id);
  const score = type === 'artist' ? calcPill(scoring.artistScore(id), { size: 'sm' }) : ratingPill(scoring.rating(type, id), { size: 'sm' });
  return `<div class="duel-card" data-pick="${id}" role="button" tabindex="0" aria-label="Pick ${esc(d.title)}">
      <div class="duel-top">${d.art('md')}
        <div class="meta"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.sub)}</span>
          <span class="nums">${score}${eloText(e)}</span></div></div>
      <div class="duel-bottom"><button class="play-btn sm" data-play="${type}:${id}" aria-label="Play ${esc(d.title)}"></button><span class="tap-hint">Tap card to pick</span></div>
    </div>`;
}

// Attaches pick handlers to duel cards; the play button never counts as a pick.
function bindPicks(onPick) {
  $$('[data-pick]').forEach(card => {
    const pick = (e) => { if (e.target.closest('[data-play]')) return; onPick(card.dataset.pick); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  });
}

function pickFeedback(type, w, l) {
  if (type !== 'artist') {
    for (const id of [w, l]) {
      const s = state.suggestions.get(ratingKey(type, id));
      if (s) return `Suggestion: <b>${esc(describe(type, id).title)}</b> ${changeText(s.from, s.to)}`;
    }
  }
  return `<b>${esc(describe(type, w).title)}</b> wins`;
}

function renderH2H() {
  const s = state.h2h;
  if (!s) { location.replace('#/duel'); return; }
  setTitle('Head-to-head');
  const pickPair = () => {
    const ids = s.pool;
    for (let tries = 0; tries < 20; tries++) {
      const a = ids[Math.floor(Math.random() * ids.length)];
      const ea = elo.eloOf(s.type, a).elo;
      const cands = Array.from({ length: Math.min(8, ids.length - 1) }, () => ids[Math.floor(Math.random() * ids.length)]).filter(x => x !== a);
      if (!cands.length) continue;
      const b = cands.sort((x, y) => Math.abs(elo.eloOf(s.type, x).elo - ea) - Math.abs(elo.eloOf(s.type, y).elo - ea))[0];
      const key = [a, b].sort().join('|');
      if (key !== s.last || tries > 10) { s.last = key; return Math.random() < 0.5 ? [a, b] : [b, a]; }
    }
    return [ids[0], ids[1]];
  };
  if (!s.pair) s.pair = pickPair();
  const [a, b] = s.pair;
  view.innerHTML = `
    <div class="duel-screen">
      <header class="head stack"><div class="context-row"><span class="context">${TYPE_LABEL[s.type]} · ${esc(s.genre || 'Whole library')} · ${num(s.pool.length)}</span>${spotifyLogo()}</div>
        <div style="display:flex;align-items:center;gap:10px;width:100%"><h1>Which one is better?</h1><a class="btn small" href="#/duel">Done</a></div></header>
      ${duelCard(s.type, a)}
      ${duelCard(s.type, b)}
      <div class="feedback" aria-live="polite">${s.feedback ? `<span class="label">Last pick</span><span>${s.feedback}</span>` : '<span class="label">Tap a card to pick the better one. Play does not count as a pick.</span>'}</div>
      <div class="duel-foot"><span>${plural(s.count, 'pick')} this session</span><button class="link" id="skipPair">Skip pair →</button></div>
    </div>`;
  bindPicks(async (w) => {
    const l = w === a ? b : a;
    await elo.duel(s.type, w, l);
    s.count++;
    s.feedback = pickFeedback(s.type, w, l);
    updateBadge();
    s.pair = pickPair();
    route();
  });
  $('#skipPair').onclick = () => { s.pair = pickPair(); route(); };
}

function podiumValue(type, id) {
  return type === 'artist' ? fmtCalc(scoring.artistScore(id)) : fmt(scoring.rating(type, id));
}

function renderBracket() {
  const b = state.bracket;
  if (!b) { location.replace('#/duel'); return; }
  setTitle('Bracket');
  if (b.done) {
    const final = b.rounds.at(-1)[0];
    const runnerUp = final.winner === final.a ? final.b : final.a;
    const semis = b.rounds.at(-2)?.map(m => (m.winner === m.a ? m.b : m.a)) || [];
    const entry = (id) => { const d = describe(b.type, id); return { href: d.href, art: d.art('md'), title: d.title, value: `Elo ${Math.round(elo.eloOf(b.type, id).elo)}` }; };
    const n = state.suggestions.size;
    view.innerHTML = `
      <header class="head stack"><div class="context-row"><span class="context">${TYPE_LABEL[b.type]} · ${esc(b.poolLabel)} · ${b.size}</span>${spotifyLogo()}</div><h1>Champion</h1></header>
      ${podium([b.champion, runnerUp, semis[0]].filter(Boolean).map(entry))}
      ${semis[1] ? `<p class="label section-label">Also in the semifinals</p><div class="list">${row(b.type, semis[1], { rank: 3 })}</div>` : ''}
      ${b.type !== 'artist' && n ? `<a class="btn primary block" href="#/suggestions">Review ${plural(n, 'suggestion')}</a>` : ''}
      ${b.type === 'artist' ? '<a class="btn primary block" href="#/rankings/artist-duels">See artist duel ranking</a>' : ''}
      <a class="btn block" href="#/duel">New duel</a>
      ${bracketHistory(b)}`;
    return;
  }
  const { r, m } = b.current;
  const match = b.rounds[r][m];
  const done = b.rounds.reduce((acc, rd) => acc + rd.filter(x => x.winner).length, 0);
  view.innerHTML = `
    <div class="duel-screen">
      <header class="head stack"><div class="context-row"><span class="context">${TYPE_LABEL[b.type]} · ${esc(b.poolLabel)} · ${b.size}</span>${spotifyLogo()}</div>
        <div style="display:flex;align-items:center;gap:10px;width:100%"><h1>${roundName(b.rounds[r].length)}</h1><span class="sub">Match ${m + 1} of ${b.rounds[r].length}</span><a class="btn small" href="#/duel">Pause</a></div></header>
      <div class="progress"><div style="width:${(done / (b.size - 1)) * 100}%"></div></div>
      ${duelCard(b.type, match.a)}
      ${duelCard(b.type, match.b)}
      ${bracketHistory(b)}
    </div>`;
  bindPicks(async (w) => {
    const l = w === match.a ? match.b : match.a;
    match.winner = w;
    await elo.duel(b.type, w, l);
    const round = b.rounds[r];
    if (m + 1 < round.length) b.current = { r, m: m + 1 };
    else if (round.length === 1) { b.done = true; b.champion = w; }
    else {
      const next = [];
      for (let k = 0; k < round.length; k += 2) next.push({ a: round[k].winner, b: round[k + 1].winner, winner: null });
      b.rounds.push(next);
      b.current = { r: r + 1, m: 0 };
    }
    b.updatedAt = now();
    await db.put('brackets', b);
    updateBadge();
    route();
  });
}

function bracketHistory(b) {
  const rounds = b.rounds.filter(rd => rd.some(x => x.winner)).reverse();
  if (!rounds.length) return '';
  return `<details class="card"><summary>Results so far</summary>${rounds.map(rd => `
    <p class="label results-title">${roundName(rd.length)}</p><ul class="results">${rd.filter(x => x.winner).map(x => {
      const l = x.winner === x.a ? x.b : x.a;
      return `<li><b>${esc(describe(b.type, x.winner).title)}</b> beat ${esc(describe(b.type, l).title)}</li>`;
    }).join('')}</ul>`).join('')}</details>`;
}

function renderSuggestions() {
  setTitle('Suggestions');
  const list = [...state.suggestions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) {
    view.innerHTML = `${head('Suggestions')}<section class="welcome"><h2>No open suggestions</h2><p>Duels on tracks and albums create rating suggestions when the results disagree with your ratings.</p><a class="btn primary" href="#/duel">Start a duel</a></section>`;
    return;
  }
  view.innerHTML = `
    ${head('Suggestions', { sub: `${num(list.length)} open` })}
    <p class="fine">Duel results imply these rating changes. Nothing changes until you confirm.</p>
    <div class="row-actions"><button class="btn" id="rejectAll">Reject all</button><button class="btn primary" id="acceptAll">Accept all</button></div>
    <div class="list">${list.map(s => {
      const d = describe(s.type, s.refId);
      if (!d) return '';
      return `<div class="sug" data-id="${esc(s.id)}">
        <a class="row" href="${d.href}">${d.art('sm')}<span class="meta"><span class="t">${esc(d.title)}</span><span class="s">${s.type} · ${esc(d.sub)}</span></span><span class="elo">${s.record}</span></a>
        <div class="sug-line">${changeText(s.from, s.to)}
          <button class="btn small" data-reject>Reject</button><button class="btn small primary" data-accept>Accept ${fmt(s.to)}</button></div></div>`;
    }).join('')}</div>`;
  $$('.sug').forEach(el => {
    const id = el.dataset.id;
    $('[data-accept]', el).onclick = async () => { await elo.accept(id, (t, r, v) => setRating(t, r, v)); updateBadge(); route(); };
    $('[data-reject]', el).onclick = async () => { await elo.reject(id); updateBadge(); route(); };
  });
  $('#acceptAll').onclick = async () => { for (const s of list) await elo.accept(s.id, (t, r, v) => setRating(t, r, v, { quiet: true })); updateBadge(); toast(`${plural(list.length, 'rating')} updated`); route(); };
  $('#rejectAll').onclick = async () => { for (const s of list) await elo.reject(s.id); updateBadge(); route(); };
}

function artistEloRanking() {
  return [...state.elo.values()].filter(e => e.type === 'artist' && e.games > 0 && state.artists.has(e.refId)).sort((a, b) => b.elo - a.elo);
}

function renderRankings(tab) {
  setTitle('Rankings');
  let ids; let type; let right; let note = ''; let sub;
  if (tab === 'artist-duels') {
    const r = artistEloRanking();
    ids = r.map(e => e.refId); type = 'artist';
    const byId = new Map(r.map(e => [e.refId, e]));
    right = (id) => eloText(byId.get(id));
    sub = `${num(ids.length)} artists dueled`;
    note = 'From artist head-to-heads and brackets. Separate from artist scores and does not change them.';
  } else {
    type = tab.slice(0, -1);
    ids = [...collection(type).keys()].filter(id => scoring.scoreOf(type, id) != null).sort((a, b) => scoring.scoreOf(type, b) - scoring.scoreOf(type, a));
    sub = `${num(ids.length)} of ${num(collection(type).size)} ${type === 'artist' ? 'scored' : 'rated'}`;
    note = type === 'album' ? 'Ranked by your album rating. Track average shown as ø.' : type === 'artist' ? 'Calculated: 50% album average, 50% track average.' : '';
  }
  const top = ids.slice(0, 3).map(id => {
    const d = describe(type, id);
    return { href: d.href, art: d.art('md'), title: d.title, value: tab === 'artist-duels' ? `Elo ${Math.round(elo.eloOf('artist', id).elo)}` : podiumValue(type, id) };
  });
  view.innerHTML = `
    ${head('Rankings', { sub })}
    <nav class="pills" aria-label="Ranking type">${[['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'], ['artist-duels', 'Duels']].map(([k, l]) => `<a href="#/rankings/${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    ${top.length ? podium(top) : ''}
    ${note ? `<p class="fine">${note}</p>` : ''}
    <div class="list" id="list"></div>`;
  lazyList($('#list'), ids.slice(3), (id, i) => row(type, id, { rank: i + 4, cls: 'ranked', right: right?.(id) }), `rank:${tab}`);
}

async function renderSettings() {
  setTitle('Settings');
  // The Client ID is public by design (PKCE, no secret), so it is prefilled.
  const clientId = (await db.getMeta('clientId')) || DEFAULT_CLIENT_ID;
  const token = await db.getMeta('token');
  const lastSync = await db.getMeta('lastSync');
  const rated = [...state.ratings.values()].filter(r => r.value != null).length;
  const expires = token?.authorizedAt ? new Date(token.authorizedAt + 182 * 86400000) : null;
  view.innerHTML = `
    ${head('Settings', { attrib: false })}
    <section class="card">
      <h3>Spotify</h3>
      <p class="status ${state.connected ? 'ok' : ''}">${state.connected ? 'Connected' : 'Not connected'}${state.mode === 'demo' ? ' · demo library loaded' : ''}</p>
      ${expires ? `<p class="fine">Login renewal due around ${expires.toLocaleDateString()} (refresh tokens expire after six months).</p>` : ''}
      <label class="field"><span>Client ID</span><input id="clientId" value="${esc(clientId)}" placeholder="From developer.spotify.com/dashboard" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Redirect URI (add this in your Spotify app)</span><div class="copy"><code id="redir">${esc(spotify.redirectUri())}</code><button class="btn small" id="copyRedir">Copy</button></div></label>
      <div class="row-actions">${state.connected ? '<button class="btn" id="logout">Disconnect</button>' : ''}<button class="btn primary" id="login">${state.connected ? 'Log in again' : 'Connect Spotify'}</button></div>
    </section>
    <section class="card">
      <h3>Library</h3>
      <p>${plural(state.tracks.size, 'track')} · ${plural(state.albums.size, 'album')} · ${plural(state.artists.size, 'artist')} · ${num(rated)} ratings</p>
      <p class="fine">${lastSync ? `Last sync ${new Date(lastSync).toLocaleString()}` : 'Not synced yet'}</p>
      <div id="syncProgress" class="sync" hidden><div class="progress"><div></div></div><p class="fine"></p></div>
      <div class="row-actions"><button class="btn" id="fullSync" ${state.connected ? '' : 'disabled'}>Full resync</button><button class="btn primary" id="sync" ${state.connected ? '' : 'disabled'}>Sync new likes</button></div>
      ${state.mode === 'spotify' ? '<div id="genreStatus" class="sync"></div>' : ''}
      <p class="fine">Genres need one request per artist. They load slowly in the background while the app is open, artists with the most liked songs first, and pause when Spotify's request limit is reached.</p>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="fine">Export ratings, duel data and library as JSON. Import merges by timestamp, newer entries win.</p>
      <div class="row-actions"><label class="btn">Import<input type="file" id="import" accept="application/json,.json" hidden></label><button class="btn primary" id="export">Export JSON</button></div>
    </section>
    <section class="card">
      <h3>Demo</h3>
      <p class="fine">Load a fictional library of about 300 tracks to try the app without Spotify.</p>
      <button class="btn" id="demo">Load demo library</button>
    </section>
    <section class="card" id="installCard" ${deferredInstall ? '' : 'hidden'}>
      <h3>Install</h3><p class="fine">Add SpotScore to your home screen.</p><button class="btn primary" id="install">Install app</button>
    </section>
    <section class="card"><h3>Reset</h3><button class="btn" id="wipe">Delete all local data</button></section>
    <p class="fine center">SpotScore prototype · data stays on this device</p>`;

  $('#copyRedir').onclick = async () => { try { await navigator.clipboard.writeText(spotify.redirectUri()); toast('Redirect URI copied'); } catch { toast('Copy failed, select the text manually'); } };
  $('#login').onclick = async () => {
    const id = $('#clientId').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) { toast('Enter the 32-character Client ID of your Spotify app.'); return; }
    await spotify.login(id);
  };
  $('#logout')?.addEventListener('click', async () => { await spotify.logout(); state.connected = false; nowPlaying = null; drawPlayer(); route(); });
  $('#sync').onclick = () => runSync(false);
  $('#fullSync').onclick = () => runSync(true);
  $('#export').onclick = exportJson;
  $('#import').onchange = (e) => e.target.files[0] && importJson(e.target.files[0]);
  $('#demo').onclick = loadDemo;
  $('#install')?.addEventListener('click', async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#installCard').hidden = true; });
  $('#wipe').onclick = async () => {
    if (!confirm('Delete all ratings, duels and the library from this device? Export a backup first if you need one.')) return;
    await db.clearAll();
    location.hash = '#/welcome';
    location.reload();
  };
  if (state.syncing) showSyncProgress(state.syncing);
  drawGenreStatus();
}

function showSyncProgress(p) {
  const box = $('#syncProgress');
  if (!box) return;
  box.hidden = false;
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  $('.progress div', box).style.width = `${pct}%`;
  $('p', box).textContent = p.waiting ? `Rate limited, waiting ${Math.round(p.waiting / 1000)} s…`
    : `Liked songs: ${p.done ?? 0}${p.total ? ` of ${p.total}` : ''}`;
}

async function runSync(full) {
  if (state.syncing) return;
  if (state.mode === 'demo' && state.tracks.size && !confirm('This replaces the demo library with your Spotify library and removes the demo ratings and duels. Continue?')) return;
  if (state.mode === 'demo') {
    // Demo data refers to fictional IDs, so it is dropped entirely.
    for (const s of ['tracks', 'albums', 'artists', 'ratings', 'elo', 'suggestions', 'brackets']) await db.clear(s);
    await loadState();
    updateBadge();
    state.demoPlaying = null;
    drawPlayer();
  }
  state.syncing = { phase: 'tracks', done: 0 };
  $$('#sync, #fullSync').forEach(b => { b.disabled = true; });
  try {
    await db.setMeta('mode', 'spotify');
    state.mode = 'spotify';
    const res = await spotify.syncLibrary(state, { full, onProgress: (p) => { state.syncing = p; showSyncProgress(p); } });
    toast(`Sync done: ${plural(res.added, 'new or changed track')}, ${res.total} total`);
  } catch (e) {
    toast(e.quota ? 'Spotify request limit reached. Try the sync again later.' : `Sync stopped: ${e.message}`, 5000);
  } finally {
    state.syncing = null;
    route();
  }
  loadGenres();
}

// Genres load as a slow background trickle and pause when Spotify's quota is used up.
async function loadGenres(force = false) {
  if (state.mode !== 'spotify' || !state.connected) return;
  try {
    const res = await spotify.syncGenres(state, { force, onProgress: (p) => { state.genreProgress = p; drawGenreStatus(); } });
    if (res.paused && force) toast('Spotify request limit reached. Genres resume automatically later.', 5000);
  } catch (e) {
    toast(`Genre loading stopped: ${e.message}`, 5000);
  }
  state.genreProgress = null;
  drawGenreStatus();
}

async function drawGenreStatus() {
  const el = $('#genreStatus');
  if (!el) return;
  const s = await spotify.genreStatus(state);
  const running = state.genreProgress && !state.genreProgress.pausedUntil;
  const pct = s.total ? (s.done / s.total) * 100 : 0;
  el.innerHTML = `
    <div class="progress"><div style="width:${pct}%"></div></div>
    <p class="fine">Artist genres: ${s.done} of ${s.total}${running ? (state.genreProgress.waiting ? `, waiting ${Math.round(state.genreProgress.waiting / 1000)} s` : ', loading in the background') : ''}${s.pausedUntil ? `. Spotify request limit reached, resumes after ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
    ${!running && s.done < s.total ? '<button class="btn small" id="genresNow">Load genres now</button>' : ''}`;
  $('#genresNow')?.addEventListener('click', () => loadGenres(true));
}

async function loadDemo() {
  if (state.mode === 'spotify' && state.tracks.size && !confirm('Replace your Spotify library with the demo library? Ratings are kept.')) return;
  const demo = buildDemo();
  for (const s of ['tracks', 'albums', 'artists']) await db.clear(s);
  await db.putMany('tracks', [...demo.tracks.values()]);
  await db.putMany('albums', [...demo.albums.values()]);
  await db.putMany('artists', [...demo.artists.values()]);
  await db.putMany('ratings', demo.ratings.filter(r => !state.ratings.has(r.id)));
  await db.setMeta('mode', 'demo');
  await loadState();
  updateBadge();
  toast(`Demo library loaded: ${state.tracks.size} tracks`);
  location.hash = '#/library/tracks';
  route();
}

async function exportJson() {
  const data = { app: 'spotscore', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES.filter(x => x !== 'meta')) data[s] = await db.all(s);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spotscore-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'spotscore') throw new Error('Not a SpotScore backup');
    let changed = 0;
    for (const s of STORES.filter(x => x !== 'meta')) {
      if (!Array.isArray(data[s])) continue;
      const existing = toMap(await db.all(s));
      const newer = data[s].filter(r => r && r.id && (!existing.has(r.id) || (r.updatedAt || 0) > (existing.get(r.id).updatedAt || 0)));
      await db.putMany(s, newer);
      changed += newer.length;
    }
    if (!state.mode && data.tracks?.length) await db.setMeta('mode', 'spotify');
    await loadState();
    updateBadge();
    toast(`Import done: ${changed} records added or updated`);
    route();
  } catch (e) {
    toast(`Import failed: ${e.message}`, 5000);
  }
}

// ---------- Global events ----------
document.addEventListener('click', (e) => {
  const play = e.target.closest('[data-play]');
  if (play) { e.preventDefault(); e.stopPropagation(); const [type, id] = play.dataset.play.split(':'); player.play(type, id); return; }
  const rate = e.target.closest('[data-rate]');
  if (rate) { e.preventDefault(); e.stopPropagation(); const [type, id] = rate.dataset.rate.split(':'); rateInSheet(type, id); return; }
  const p = e.target.closest('[data-player]');
  if (p) { player[p.dataset.player](); }
});
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('[data-rate][role="button"]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.click(); }
});
$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/library'));
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', refreshPlayer);
// Poll the player only while something is known to be playing, to save API quota.
setInterval(() => { if (nowPlaying?.playing) refreshPlayer(); }, 30000);

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; const c = $('#installCard'); if (c) c.hidden = false; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- Boot ----------
(async function boot() {
  try {
    const loggedIn = await spotify.handleRedirect();
    await loadState();
    updateBadge();
    if (loggedIn) {
      toast('Connected to Spotify. Starting library sync…');
      location.hash = '#/settings';
      route();
      runSync(false);
      return;
    }
  } catch (e) {
    await loadState();
    toast(e.message, 5000);
  }
  route();
  refreshPlayer();
  loadGenres();
  // Retry paused genre loading now and then while the app stays open.
  setInterval(() => { if (!document.hidden) loadGenres(); }, 10 * 60 * 1000);
})();
