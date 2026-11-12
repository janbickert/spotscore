// Social features (two users): friend's ratings side by side, friend's
// rankings, taste match, biggest disagreements and shared brackets.
// Items are matched across the two libraries by version rules (versions.js),
// so different editions or versions of the same song or album still match.

import { fmt } from './scoring.js';
import { esc, fmtCalc, ratingPill, calcPill, eloText, podium } from './ui.js';
import { songKey, albumKey } from './versions.js';

const TYPE_LABEL = { track: 'Tracks', album: 'Albums', artist: 'Artists' };
const first = (s) => String(s || 'Friend').split(/\s+/)[0];

export function createSocial(ctx) {
  const { state, scoring, elo, view, $, $$, art, head, row, toast, setTitle, plural, num, getCloud, markDirty, shuffle, now } = ctx;
  const friend = () => state.cloud.friend;
  const friendName = () => first(friend()?.profile.display_name);

  // ---------- Matching across libraries ----------
  // My item id → the friend's matching item id (or null).
  function toFriend(type, id) {
    const f = friend();
    if (!f) return null;
    if (type === 'track') {
      const t = state.tracks.get(id);
      return t ? f.view.resolvePlaying({ id: t.id, name: t.name, artistId: t.artists[0]?.id, durationMs: t.durationMs }) : null;
    }
    if (type === 'album') {
      const a = state.albums.get(id);
      for (const eid of a?.editions || []) { const fid = f.view.resolveAlbum(state.rawAlbums.get(eid)); if (fid) return fid; }
      return null;
    }
    return f.state.artists.has(id) ? id : null;
  }
  // The friend's item id → my matching item id (or null).
  function toMine(type, fid) {
    const f = friend();
    if (type === 'track') {
      const t = f.state.tracks.get(fid);
      return t ? state.resolvePlaying({ id: t.id, name: t.name, artistId: t.artists[0]?.id, durationMs: t.durationMs }) : null;
    }
    if (type === 'album') return state.resolveAlbum(f.state.albums.get(fid));
    return state.artists.has(fid) ? fid : null;
  }
  const friendScore = (type, fid) => (type === 'artist' ? friend().scoring.artistScore(fid) : friend().scoring.rating(type, fid));

  // The friend's rating: filled off-white pill (theirs), next to the Malachite one (mine).
  const friendPill = (v, size = 'md') => (v == null ? `<span class="pill unrated ${size}">not rated</span>`
    : `<span class="pill friend ${size}">${fmt(v)}</span>`);
  const friendCalc = (v, size = 'md') => `<span class="pill calc friend-calc ${size}${v == null ? ' empty' : ''}">ø ${fmtCalc(v)}</span>`;

  // ---------- 1. Side by side on detail pages ----------
  function friendPanel(type, id) {
    if (!friend()) return '';
    const fid = toFriend(type, id);
    const label = `<span class="label">${esc(friendName())}</span>`;
    if (!fid) return `<div class="panel friend-panel">${label}<span class="fine">Not in their library</span></div>`;
    const v = friendScore(type, fid);
    const extra = type === 'album' ? `<span class="fine">their track average ø${fmtCalc(friend().scoring.albumTrackAvg(fid))}</span>` : '';
    return `<div class="panel friend-panel">${label}${type === 'artist' ? friendCalc(v, 'lg') : friendPill(v, 'lg')}${extra}</div>`;
  }

  // ---------- 2. Friend's rankings ----------
  function describeFriend(type, fid) {
    const f = friend().state;
    const mine = toMine(type, fid);
    const ext = (kind, sid) => `https://open.spotify.com/${kind}/${sid}`;
    if (type === 'track') {
      const t = f.tracks.get(fid);
      return { title: t.name, sub: `${t.artists.map(a => a.name).join(', ')} · ${t.albumName}`, artHtml: art(t, 'sm'), href: mine ? `#/track/${mine}` : ext('track', t.id), mine };
    }
    if (type === 'album') {
      const a = f.albums.get(fid);
      return { title: a.name, sub: `${a.artists.map(x => x.name).join(', ')} · ${(a.releaseDate || '').slice(0, 4)}`, artHtml: art(a, 'sm'), href: mine ? `#/album/${mine}` : ext('album', a.id), mine };
    }
    const ar = f.artists.get(fid);
    return { title: ar.name, sub: ar.genres?.length ? ar.genres.slice(0, 2).join(', ') : `${plural(ar.trackIds.length, 'track')}`, artHtml: art(ar, 'sm', true), href: mine ? `#/artist/${mine}` : ext('artist', ar.id), mine };
  }

  function friendRow(type, fid, rank, right) {
    const d = describeFriend(type, fid);
    const external = !d.mine;
    return `<a class="row ranked" href="${d.href}" ${external ? 'target="_blank" rel="noopener"' : ''}><span class="rank">${rank}</span>${d.artHtml}
      <span class="meta"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.sub)}${external ? ' · not in your library ↗' : ''}</span></span>${right}</a>`;
  }

  function whoPills(active) {
    if (!friend()) return '';
    return `<nav class="pills who" aria-label="Whose rankings">
      <a href="#/rankings" class="${active === 'me' ? 'on' : ''}">You</a>
      <a href="#/friend/tracks" class="${active === 'friend' ? 'on' : ''}">${esc(friendName())}</a>
      <a href="#/compare" class="${active === 'compare' ? 'on' : ''}">Compare</a></nav>`;
  }

  function renderFriendRankings(tab) {
    if (!friend()) { location.replace('#/rankings'); return; }
    setTitle(`${friendName()}'s rankings`);
    const f = friend();
    let ids; let type; let value;
    if (tab === 'artist-duels') {
      type = 'artist';
      const r = [...f.elo.values()].filter(e => e.type === 'artist' && e.games > 0 && f.state.artists.has(e.refId)).sort((a, b) => b.elo - a.elo);
      ids = r.map(e => e.refId);
      const byId = new Map(r.map(e => [e.refId, e]));
      value = (id) => ({ pill: eloText(byId.get(id)), pod: `Elo ${Math.round(byId.get(id).elo)}` });
    } else {
      type = tab.slice(0, -1);
      const coll = type === 'track' ? f.state.tracks : type === 'album' ? f.state.albums : f.state.artists;
      ids = [...coll.keys()].filter(id => friendScore(type, id) != null).sort((a, b) => friendScore(type, b) - friendScore(type, a));
      value = (id) => { const v = friendScore(type, id); return { pill: type === 'artist' ? friendCalc(v) : friendPill(v), pod: type === 'artist' ? fmtCalc(v) : fmt(v) }; };
    }
    const top = ids.slice(0, 3).map(id => { const d = describeFriend(type, id); return { href: d.href, art: art(type === 'track' ? f.state.tracks.get(id) : type === 'album' ? f.state.albums.get(id) : f.state.artists.get(id), 'md', type === 'artist'), title: d.title, value: value(id).pod }; });
    view.innerHTML = `
      ${head('Rankings', { sub: `${esc(friendName())} · ${num(ids.length)} ${type === 'artist' && tab !== 'artist-duels' ? 'scored' : 'rated'}` })}
      ${whoPills('friend')}
      <nav class="pills" aria-label="Ranking type">${[['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'], ['artist-duels', 'Duels']].map(([k, l]) => `<a href="#/friend/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
      ${top.length ? podium(top) : '<p class="empty">Nothing rated yet.</p>'}
      <div class="list" id="list"></div>`;
    $('#list').innerHTML = ids.slice(3, 300).map((id, i) => friendRow(type, id, i + 4, value(id).pill)).join('');
  }

  // ---------- 3 + 4. Taste match and biggest disagreements ----------
  function comparison() {
    const f = friend();
    const songs = [];
    for (const id of state.tracks.keys()) {
      const fid = toFriend('track', id);
      if (fid) songs.push({ type: 'track', id, fid, mine: scoring.trackScore(id), theirs: f.scoring.trackScore(fid) });
    }
    const albums = [];
    for (const id of state.albums.keys()) {
      const fid = toFriend('album', id);
      if (fid) albums.push({ type: 'album', id, fid, mine: scoring.albumScore(id), theirs: f.scoring.albumScore(fid) });
    }
    const artistCount = new Map();
    for (const s of songs) for (const a of state.tracks.get(s.id).artists) artistCount.set(a.id, (artistCount.get(a.id) || 0) + 1);
    const bothRated = (list) => list.filter(x => x.mine != null && x.theirs != null);
    const ratedSongs = bothRated(songs);
    const meanDiff = ratedSongs.length ? ratedSongs.reduce((s, x) => s + Math.abs(x.mine - x.theirs), 0) / ratedSongs.length : null;
    return {
      songs, albums, ratedSongs, meanDiff,
      match: ratedSongs.length >= 5 ? Math.round(100 - (meanDiff / 9) * 100) : null,
      sharedArtists: [...artistCount.entries()].sort((a, b) => b[1] - a[1]),
      disagreements: [...bothRated(songs), ...bothRated(albums)].sort((a, b) => Math.abs(b.mine - b.theirs) - Math.abs(a.mine - a.theirs)),
    };
  }

  function renderCompare(tab = 'all') {
    if (!friend()) { location.replace('#/rankings'); return; }
    setTitle('Compare');
    const c = comparison();
    const f = friend();
    const name = esc(friendName());
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
    const list = c.disagreements.filter(x => tab === 'all' || x.type === tab.slice(0, -1)).slice(0, 60);
    view.innerHTML = `
      ${head('Compare', { sub: `You & ${name}` })}
      ${whoPills('compare')}
      <section class="card match">
        <span class="label">Taste match</span>
        <div class="match-row"><span class="match-num">${c.match == null ? '–' : `${c.match}%`}</span>
          <span class="fine">${c.match == null ? `Rate at least 5 songs you both like to see your match. Now: ${c.ratedSongs.length}.`
            : `Based on ${plural(c.ratedSongs.length, 'song')} you both rated. On average your ratings are ${c.meanDiff.toFixed(1)} points apart.`}</span></div>
        <div class="panels stats3">
          <div class="panel"><span class="label">Liked by both</span><b>${num(c.songs.length)}</b><span class="fine">${pct(c.songs.length, state.tracks.size)}% of yours · ${pct(c.songs.length, f.state.tracks.size)}% of ${name}'s</span></div>
          <div class="panel"><span class="label">Shared artists</span><b>${num(c.sharedArtists.length)}</b><span class="fine">${c.sharedArtists.slice(0, 3).map(([id]) => esc(state.artists.get(id)?.name)).join(', ') || '–'}</span></div>
        </div>
      </section>
      <p class="label section-label">Biggest disagreements</p>
      <nav class="pills" aria-label="Disagreement type">${[['all', 'All'], ['tracks', 'Songs'], ['albums', 'Albums']].map(([k, l]) => `<a href="#/compare/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
      ${list.length ? '' : `<p class="empty">No ${tab === 'albums' ? 'albums' : 'songs'} rated by both of you yet.</p>`}
      <div class="list">${list.map(x => {
        const d = x.mine - x.theirs;
        return row(x.type, x.id, { cls: 'versus', right: `<span class="vs-pills">${ratingPill(x.mine, { size: 'sm' })}${friendPill(x.theirs, 'sm')}<small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)}</small></span>` });
      }).join('')}</div>
      <p class="fine center">Green: you · White: ${name}</p>`;
  }

  // ---------- 6. Shared brackets ----------
  let brackets = [];
  let poll = null;

  function candidates(type, poolKind) {
    const f = friend();
    const mineByKey = new Map();
    const theirsByKey = new Map();
    const keyOf = (t, item) => (t === 'track' ? songKey(item.artists[0]?.id, item.name) : t === 'album' ? albumKey(item) : item.id);
    const myColl = type === 'track' ? state.tracks : type === 'album' ? state.albums : state.artists;
    const theirColl = type === 'track' ? f.state.tracks : type === 'album' ? f.state.albums : f.state.artists;
    for (const it of myColl.values()) mineByKey.set(keyOf(type, it), it);
    for (const it of theirColl.values()) theirsByKey.set(keyOf(type, it), it);
    const keys = poolKind === 'both' ? [...mineByKey.keys()].filter(k => theirsByKey.has(k)) : [...new Set([...mineByKey.keys(), ...theirsByKey.keys()])];
    return keys.map(k => snapshot(type, k, mineByKey.get(k) || theirsByKey.get(k)));
  }

  // Everything both phones need to show an entry, independent of their libraries.
  function snapshot(type, key, it) {
    if (type === 'track') return { key, type, id: it.id, name: it.name, artistId: it.artists[0]?.id, durationMs: it.durationMs, sub: `${it.artists.map(a => a.name).join(', ')} · ${it.albumName}`, image: it.albumImage, imageSmall: it.albumImageSmall, albumId: it.albumId };
    if (type === 'album') return { key, type, id: it.id, name: it.name, artists: it.artists, sub: `${it.artists.map(a => a.name).join(', ')} · ${(it.releaseDate || '').slice(0, 4)}`, image: it.image, imageSmall: it.imageSmall };
    return { key, type, id: it.id, name: it.name, sub: it.genres?.slice(0, 2).join(', ') || '', image: it.image };
  }

  // Resolves an entry to my library and to the friend's library.
  function entryMine(e) {
    if (e.type === 'track') return state.resolvePlaying({ id: e.id, name: e.name, artistId: e.artistId, durationMs: e.durationMs });
    if (e.type === 'album') return state.resolveAlbum({ id: e.id, name: e.name, artists: e.artists });
    return state.artists.has(e.id) ? e.id : null;
  }
  function entryTheirs(e) {
    const f = friend();
    if (!f) return null;
    if (e.type === 'track') return f.view.resolvePlaying({ id: e.id, name: e.name, artistId: e.artistId, durationMs: e.durationMs });
    if (e.type === 'album') return f.view.resolveAlbum({ id: e.id, name: e.name, artists: e.artists });
    return f.state.artists.has(e.id) ? e.id : null;
  }
  const myScore = (e) => { const id = entryMine(e); return id ? scoring.scoreOf(e.type, id) : null; };
  const theirScore = (e) => { const id = entryTheirs(e); return id ? friendScore(e.type, id) : null; };

  // Rounds derived from the seeded entries and the decided results.
  function structure(data, results) {
    const res = new Map(results.map(r => [r.match_key, r]));
    const rounds = [];
    let prev = data.entries.map(e => e.key);
    for (let r = 0; ; r++) {
      const matches = [];
      for (let m = 0; m < prev.length / 2; m++) {
        const key = `r${r}m${m}`;
        matches.push({ key, a: prev[2 * m] || null, b: prev[2 * m + 1] || null, result: res.get(key) || null });
      }
      rounds.push(matches);
      if (matches.length === 1) break;
      prev = matches.map(x => x.result?.winner || null);
    }
    return rounds;
  }

  const roundName = (n) => (n === 1 ? 'Final' : n === 2 ? 'Semifinals' : n === 4 ? 'Quarterfinals' : `Round of ${n * 2}`);

  // Decides matches both have voted on. Agreement wins outright; otherwise the
  // entry with the higher average of both ratings, then the higher seed.
  async function settle(bracket, rounds, votes) {
    const c = await getCloud();
    const entries = new Map(bracket.data.entries.map((e, i) => [e.key, { ...e, seed: i }]));
    let wrote = false;
    for (const round of rounds) for (const m of round) {
      if (m.result || !m.a || !m.b) continue;
      const vs = votes.filter(v => v.match_key === m.key);
      if (new Set(vs.map(v => v.user_id)).size < 2) continue;
      let winner; let by;
      if (vs.every(v => v.winner === vs[0].winner)) { winner = vs[0].winner; by = 'agreed'; }
      else {
        const avg = (k) => { const e = entries.get(k); const vals = [myScore(e), theirScore(e)].filter(v => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; };
        const [sa, sb] = [avg(m.a), avg(m.b)];
        winner = sa != null && sb != null && sa !== sb ? (sa > sb ? m.a : m.b) : sa != null && sb == null ? m.a : sb != null && sa == null ? m.b : (entries.get(m.a).seed < entries.get(m.b).seed ? m.a : m.b);
        by = 'tiebreak';
      }
      await c.recordResult(bracket.id, m.key, winner, by);
      wrote = true;
    }
    return wrote;
  }

  function sharedCard(e, mine) {
    const myId = entryMine(e);
    const cover = art({ id: e.key, name: e.name, image: e.image, imageSmall: e.imageSmall }, 'md', e.type === 'artist');
    const play = myId ? `<button class="play-btn sm" data-play="${e.type}:${myId}" aria-label="Play ${esc(e.name)}"></button>`
      : `<a class="play-btn sm" href="https://open.spotify.com/${e.type}/${e.id}" target="_blank" rel="noopener" aria-label="Listen on Spotify"></a>`;
    const pills = e.type === 'artist' ? `${calcPill(myScore(e), { size: 'sm' })}${friendCalc(theirScore(e), 'sm')}` : `${ratingPill(myScore(e), { size: 'sm' })}${friendPill(theirScore(e), 'sm')}`;
    return `<div class="duel-card${mine ? ' picked' : ''}" data-shared-pick="${esc(e.key)}" role="button" tabindex="0" aria-label="Pick ${esc(e.name)}">
      <div class="duel-top">${cover}<div class="meta"><span class="t">${esc(e.name)}</span><span class="s">${esc(e.sub)}</span><span class="nums">${pills}</span></div></div>
      <div class="duel-bottom">${play}<span class="tap-hint">${mine ? 'Your pick' : 'Tap card to pick'}</span></div></div>`;
  }

  async function renderShared(id) {
    if (!friend() || !state.cloud.user) { location.replace('#/duel'); return; }
    setTitle('Shared bracket');
    clearInterval(poll);
    const c = await getCloud();
    view.innerHTML = '<p class="empty">Loading bracket…</p>';
    let bracket = brackets.find(b => b.id === id);
    if (!bracket) { brackets = await c.sharedBrackets(); bracket = brackets.find(b => b.id === id); }
    if (!bracket) { view.innerHTML = '<p class="empty">This bracket no longer exists.</p>'; return; }
    let { votes, results } = await c.bracketVotesAndResults(id);
    let rounds = structure(bracket.data, results);
    if (await settle(bracket, rounds, votes)) ({ votes, results } = await c.bracketVotesAndResults(id));
    rounds = structure(bracket.data, results);
    if (location.hash !== `#/shared/${id}`) return;

    const me = state.cloud.user.id;
    const entries = new Map(bracket.data.entries.map(e => [e.key, e]));
    const final = rounds.at(-1)[0];
    const myVote = (m) => votes.find(v => v.match_key === m.key && v.user_id === me);
    const ctxLine = `${TYPE_LABEL[bracket.data.type]} · ${esc(bracket.data.poolLabel)} · ${bracket.data.size} · with ${esc(friendName())}`;
    const decided = results.length;
    const tiebreaks = results.filter(r => r.decided_by === 'tiebreak').length;
    const history = `<details class="card"><summary>Results so far · ${decided} decided${tiebreaks ? `, ${tiebreaks} by tiebreak` : ''}</summary>${rounds.filter(r => r.some(m => m.result)).reverse().map(r => `
      <p class="label results-title">${roundName(r.length)}</p><ul class="results">${r.filter(m => m.result).map(m => {
        const w = entries.get(m.result.winner); const l = entries.get(m.result.winner === m.a ? m.b : m.a);
        return `<li><b>${esc(w.name)}</b> beat ${esc(l.name)}${m.result.decided_by === 'tiebreak' ? ' <small>(tiebreak)</small>' : ''}</li>`;
      }).join('')}</ul>`).join('')}</details>`;

    if (final.result) {
      const runnerUp = final.result.winner === final.a ? final.b : final.a;
      const semis = (rounds.at(-2) || []).map(m => (m.result?.winner === m.a ? m.b : m.a)).filter(Boolean);
      const pod = [final.result.winner, runnerUp, semis[0]].filter(Boolean).map(k => {
        const e = entries.get(k);
        return { href: `https://open.spotify.com/${e.type}/${e.id}`, art: art({ id: e.key, name: e.name, image: e.image }, 'md', e.type === 'artist'), title: e.name, value: '' };
      });
      view.innerHTML = `
        <header class="head stack"><div class="context-row"><span class="context">${ctxLine}</span></div><h1>Shared champion</h1></header>
        ${podium(pod)}
        <p class="fine center">${decided - tiebreaks} matches agreed, ${tiebreaks} decided by tiebreak.</p>
        <a class="btn block" href="#/duel">Back to duels</a>${history}`;
      return;
    }

    const current = rounds.find(r => r.some(m => !m.result));
    const ready = current.filter(m => m.a && m.b && !m.result);
    const todo = ready.filter(m => !myVote(m));
    const done = rounds.flat().filter(m => m.result).length;
    const total = bracket.data.size - 1;
    const pick = todo[0];
    view.innerHTML = `
      <div class="duel-screen">
        <header class="head stack"><div class="context-row"><span class="context">${ctxLine}</span></div>
          <div style="display:flex;align-items:center;gap:10px;width:100%"><h1>${roundName(current.length)}</h1>
          <span class="sub">${pick ? `${todo.length} to vote` : 'Waiting'}</span><a class="btn small" href="#/duel">Pause</a></div></header>
        <div class="progress"><div style="width:${(done / total) * 100}%"></div></div>
        ${pick ? `${sharedCard(entries.get(pick.a))}${sharedCard(entries.get(pick.b))}
          <div class="feedback"><span class="label">${esc(friendName())} has ${votes.some(v => v.match_key === pick.key && v.user_id !== me) ? 'voted on this match. You will see the result after your vote.' : 'not voted on this match yet.'}</span></div>`
        : `<section class="welcome"><h2>Waiting for ${esc(friendName())}</h2><p>You have voted on every match of this round. The next round opens when ${esc(friendName())} has voted too.</p><button class="btn" id="refreshShared">Check again</button></section>`}
        ${history}
      </div>`;
    $('#refreshShared')?.addEventListener('click', () => renderShared(id));
    $$('[data-shared-pick]').forEach(card => {
      const choose = async (ev) => {
        if (ev.target.closest('[data-play], a')) return;
        const winner = card.dataset.sharedPick;
        const loser = winner === pick.a ? pick.b : pick.a;
        try {
          await c.vote(id, pick.key, me, winner);
          // Also counts as a personal duel when both are in my library.
          const [w, l] = [entryMine(entries.get(winner)), entryMine(entries.get(loser))];
          if (w && l && w !== l) { await elo.duel(bracket.data.type, w, l); markDirty(); }
        } catch (e) { toast(`Vote not saved: ${e.message}`, 5000); return; }
        renderShared(id);
      };
      card.addEventListener('click', choose);
      card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(ev); } });
    });
    // Check for the friend's votes while the screen is open.
    poll = setInterval(() => { if (location.hash === `#/shared/${id}` && !document.hidden) renderShared(id); else clearInterval(poll); }, 30000);
  }

  // Card on the Duel hub: open shared brackets and a form to start one.
  function sharedHubCard() {
    if (!friend() || !state.cloud.user) return '';
    return `<section class="card" id="sharedCard">
      <h3>Shared bracket with ${esc(friendName())}</h3>
      <p class="fine">You both vote on every match. If you disagree, the higher average of your two ratings wins.</p>
      <div id="sharedList"><p class="fine">Loading…</p></div>
      <label class="field"><span>Compare</span><div class="pills" data-group="sType">${['track', 'album', 'artist'].map((t, i) => `<button type="button" data-v="${t}" class="${i === 0 ? 'on' : ''}">${TYPE_LABEL[t]}</button>`).join('')}</div></label>
      <label class="field"><span>Pool</span><select id="sPool"><option value="union">Both libraries, random</option><option value="both">Liked by both of you</option></select></label>
      <label class="field"><span>Size</span><div class="pills" data-group="sSize">${[8, 16, 32, 64].map((s, i) => `<button type="button" data-v="${s}" class="${i === 1 ? 'on' : ''}">${s}</button>`).join('')}</div></label>
      <p class="fine" id="sInfo"></p>
      <button class="btn primary block" id="sStart">Start shared bracket</button>
    </section>`;
  }

  async function bindSharedHub() {
    const card = $('#sharedCard');
    if (!card) return;
    const read = (g) => $(`[data-group="${g}"] .on`, card).dataset.v;
    const info = () => {
      const n = candidates(read('sType'), $('#sPool').value).length;
      const size = Number(read('sSize'));
      $('#sInfo').textContent = n >= size ? `${num(n)} in pool, ${size} drawn at random` : `Only ${n} in pool, choose a smaller size.`;
      $('#sStart').disabled = n < size;
    };
    $$('[data-group]', card).forEach(seg => seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', seg).forEach(x => x.classList.toggle('on', x === b)); info(); }));
    $('#sPool').onchange = info;
    info();
    $('#sStart').onclick = async () => {
      const type = read('sType'); const size = Number(read('sSize')); const poolKind = $('#sPool').value;
      const entries = shuffle(candidates(type, poolKind)).slice(0, size);
      try {
        const c = await getCloud();
        const row = await c.createSharedBracket({ type, size, poolLabel: poolKind === 'both' ? 'Liked by both' : 'Both libraries', entries, createdByName: state.cloud.profile?.display_name, createdAt: now() });
        brackets = [row, ...brackets];
        location.hash = `#/shared/${row.id}`;
      } catch (e) { toast(`Could not start the bracket: ${e.message}`, 5000); }
    };
    try {
      const c = await getCloud();
      brackets = await c.sharedBrackets();
      const list = $('#sharedList');
      if (!list) return;
      list.innerHTML = brackets.length ? `<div class="list">${brackets.slice(0, 5).map(b => `<a class="row compact" href="#/shared/${b.id}"><span class="meta"><span class="t">${TYPE_LABEL[b.data.type]} · ${b.data.size} · ${esc(b.data.poolLabel)}</span><span class="s">Started by ${esc(first(b.data.createdByName))} · ${new Date(b.data.createdAt).toLocaleDateString()}</span></span><span class="arrow">›</span></a>`).join('')}</div>` : '<p class="fine">No shared brackets yet.</p>';
    } catch { $('#sharedList').innerHTML = '<p class="fine">Shared brackets need a connection.</p>'; }
  }

  return { friendPanel, whoPills, renderFriendRankings, renderCompare, renderShared, sharedHubCard, bindSharedHub, friendName };
}
