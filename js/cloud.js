// Cloud account and sync (Supabase). The app stays offline-first: IndexedDB is
// the working copy, the cloud is synced in the background.
//
// - Sign-in: Spotify through Supabase Auth (PKCE). Returns to the app with ?sb=1.
// - Push: own liked songs, Spotify metadata (shared catalog) and records
//   (ratings, Elo, suggestions, brackets, edition overrides) changed since the
//   last push. The server keeps the newer version of each row.
// - Pull own: changes made on another device of the same person.
// - Pull friend: the friend's likes and records, plus catalog rows for songs
//   that are not in the own library, cached locally for offline use.
// - Shared brackets: entries snapshot, one vote per person per match, results.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { db, now } from './db.js';
import { redirectUri } from './spotify.js';

// Public by design: the publishable key only allows what the row level
// security policies allow (see supabase/schema.sql).
const SUPABASE_URL = 'https://fwyzudbodjhccnacbzoc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_P1NNEqkxHd86wtrB7lSkzQ_Gf4AErZW';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'spotscore-cloud-auth' },
});

const PAGE = 1000;
const CHUNK = 400;

// ---------- Auth ----------
export async function signIn() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'spotify',
    options: { redirectTo: `${redirectUri()}?sb=1`, scopes: 'user-read-email' },
  });
  if (error) throw error;
}

// Completes the sign-in after the redirect. Returns true if this was one.
export async function handleAuthRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('sb')) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  const err = p.get('error_description') || p.get('error');
  if (err) throw new Error(`Sign-in failed: ${err}`);
  const code = p.get('code');
  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) throw error;
  }
  return true;
}

export async function currentUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}

export async function signOut() {
  await sb.auth.signOut();
  await resetLocalCloudState();
}

export async function deleteAccount() {
  const { error } = await sb.rpc('delete_my_account');
  if (error) throw error;
  await sb.auth.signOut();
  await resetLocalCloudState();
}

async function resetLocalCloudState() {
  for (const k of ['cloudPushedAt', 'cloudOwnCursor', 'cloudLikeIds', 'friendId']) await db.setMeta(k, null);
  await db.clear('friend');
}

export async function saveProfile(user) {
  const m = user.user_metadata || {};
  const row = {
    id: user.id,
    spotify_id: m.provider_id || m.sub || null,
    display_name: m.full_name || m.name || m.user_name || 'Me',
    image: m.avatar_url || m.picture || null,
    updated_at: now(),
  };
  const { error } = await sb.from('profiles').upsert(row);
  if (error) throw error;
  return row;
}

export async function otherProfiles(userId) {
  const { data, error } = await sb.from('profiles').select('*').neq('id', userId).order('display_name');
  if (error) throw error;
  return data;
}

// ---------- Helpers ----------
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (error) throw error;
  }
}

// All rows matching a filter, changed after a server-time cursor, oldest first.
async function fetchSince(table, build, cursor) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = build(sb.from(table).select('*'));
    if (cursor) q = q.gt('synced_at', cursor);
    const { data, error } = await q.order('synced_at').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function fetchByIds(table, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from(table).select('id,data').in('id', ids.slice(i, i + 150));
    if (error) throw error;
    out.push(...data);
  }
  return out;
}

const maxCursor = (rows, cur) => rows.reduce((m, r) => (!m || r.synced_at > m ? r.synced_at : m), cur || null);

// Catalog rows hold only shared Spotify metadata, nothing user specific.
const catalogTrack = ({ addedAt, createdAt, versions, ...rest }) => rest;
const catalogAlbum = ({ trackIds, editions, createdAt, ...rest }) => rest;
const catalogArtist = ({ trackIds, albumIds, createdAt, ...rest }) => rest;

const RECORD_STORES = { rating: 'ratings', elo: 'elo', suggestion: 'suggestions', bracket: 'brackets' };

// ---------- Push ----------
export async function push(state, userId, onProgress = () => {}) {
  const since = (await db.getMeta('cloudPushedAt')) || 0;
  const t0 = now();
  const newer = (r) => (r.updatedAt || 0) > since;

  // Liked songs and the catalog rows they need.
  const tracks = [...state.rawTracks.values()].filter(newer);
  const albumIds = new Set(tracks.map(t => t.albumId));
  const artistIds = new Set(tracks.flatMap(t => [...t.artists, ...t.albumArtists].map(a => a.id)));
  for (const a of state.rawArtists.values()) if ((a.genresFetchedAt || 0) > since) artistIds.add(a.id);
  onProgress(`Uploading ${tracks.length} songs`);
  await upsert('catalog_tracks', tracks.map(t => ({ id: t.id, data: catalogTrack(t), updated_at: t.updatedAt || t0 })), 'id');
  await upsert('catalog_albums', [...albumIds].map(id => state.rawAlbums.get(id)).filter(Boolean)
    .map(a => ({ id: a.id, data: catalogAlbum(a), updated_at: a.updatedAt || t0 })), 'id');
  await upsert('catalog_artists', [...artistIds].map(id => state.rawArtists.get(id)).filter(Boolean)
    .map(a => ({ id: a.id, data: catalogArtist(a), updated_at: a.genresFetchedAt || a.updatedAt || t0 })), 'id');

  const likeRows = tracks.map(t => ({ user_id: userId, track_id: t.id, added_at: t.addedAt, deleted: false, updated_at: t.updatedAt || t0 }));
  // Unliked songs: pushed before, no longer in the library.
  const pushedIds = new Set((await db.getMeta('cloudLikeIds')) || []);
  for (const id of pushedIds) if (!state.rawTracks.has(id)) likeRows.push({ user_id: userId, track_id: id, added_at: '', deleted: true, updated_at: t0 });
  await upsert('likes', likeRows, 'user_id,track_id');

  // Records.
  const rows = [];
  for (const [kind, store] of Object.entries(RECORD_STORES)) {
    for (const r of await db.all(store)) if (newer(r)) rows.push({ user_id: userId, kind, id: r.id, data: r, updated_at: r.updatedAt || t0 });
  }
  if (state.overrides?.updatedAt > since) rows.push({ user_id: userId, kind: 'override', id: 'editions', data: state.overrides, updated_at: state.overrides.updatedAt });
  onProgress(`Uploading ${rows.length} ratings and duel records`);
  await upsert('user_records', rows, 'user_id,kind,id');

  await db.setMeta('cloudLikeIds', [...state.rawTracks.keys()]);
  await db.setMeta('cloudPushedAt', t0);
  return { tracks: tracks.length, records: rows.length };
}

// ---------- Pull own changes (other devices) ----------
// Returns new raw tracks to add, ids to remove, and whether records changed.
export async function pullOwn(state, userId) {
  const cursor = await db.getMeta('cloudOwnCursor');
  const [records, likes] = await Promise.all([
    fetchSince('user_records', q => q.eq('user_id', userId), cursor?.records),
    fetchSince('likes', q => q.eq('user_id', userId), cursor?.likes),
  ]);

  let recordsChanged = false;
  for (const r of records) {
    if (r.kind === 'override') {
      if ((r.updated_at || 0) > (state.overrides?.updatedAt || 0)) { state.overrides = r.data; await db.setMeta('versionOverrides', r.data); recordsChanged = true; }
      continue;
    }
    const store = RECORD_STORES[r.kind];
    if (!store) continue;
    const local = await db.get(store, r.id);
    if (!local || (r.updated_at || 0) > (local.updatedAt || 0)) { await db.put(store, r.data); recordsChanged = true; }
  }

  const add = [];
  const remove = [];
  const missing = [];
  for (const l of likes) {
    const local = state.rawTracks.get(l.track_id);
    if (l.deleted) { if (local && (l.updated_at || 0) > (local.updatedAt || 0)) remove.push(l.track_id); continue; }
    if (!local) missing.push(l);
  }
  if (missing.length) {
    const cat = new Map((await fetchByIds('catalog_tracks', missing.map(l => l.track_id))).map(r => [r.id, r.data]));
    for (const l of missing) {
      const data = cat.get(l.track_id);
      if (data) add.push({ ...data, addedAt: l.added_at, createdAt: now(), updatedAt: l.updated_at });
    }
  }
  await db.setMeta('cloudOwnCursor', { records: maxCursor(records, cursor?.records), likes: maxCursor(likes, cursor?.likes) });
  return { add, remove, recordsChanged };
}

// ---------- Friend ----------
// Updates the local cache of the friend's likes and records, and fetches
// catalog rows for songs and artists that are not in the own library.
export async function pullFriend(friendId, state) {
  const cache = (await db.get('friend', friendId)) || { id: friendId, likes: {}, records: {}, cursor: {} };
  const [likes, records] = await Promise.all([
    fetchSince('likes', q => q.eq('user_id', friendId), cache.cursor.likes),
    fetchSince('user_records', q => q.eq('user_id', friendId).in('kind', ['rating', 'elo', 'override']), cache.cursor.records),
  ]);
  for (const l of likes) {
    if (l.deleted) delete cache.likes[l.track_id];
    else cache.likes[l.track_id] = { addedAt: l.added_at, updatedAt: l.updated_at };
  }
  for (const r of records) cache.records[`${r.kind}:${r.id}`] = { kind: r.kind, data: r.data };
  cache.cursor = { likes: maxCursor(likes, cache.cursor.likes), records: maxCursor(records, cache.cursor.records) };

  // Catalog for songs not in the own library.
  const catalog = await catalogMap();
  const needTracks = Object.keys(cache.likes).filter(id => !state.rawTracks.has(id) && !catalog.has(`track:${id}`));
  const fetchedTracks = (await fetchByIds('catalog_tracks', needTracks)).map(r => ({ id: `track:${r.id}`, data: r.data }));
  await db.putMany('catalog', fetchedTracks);
  for (const r of fetchedTracks) catalog.set(r.id, r.data);
  const artistIds = new Set();
  for (const id of Object.keys(cache.likes)) {
    const t = state.rawTracks.get(id) || catalog.get(`track:${id}`);
    for (const a of [...(t?.artists || []), ...(t?.albumArtists || [])]) artistIds.add(a.id);
  }
  const needArtists = [...artistIds].filter(id => {
    const local = state.rawArtists.get(id) || catalog.get(`artist:${id}`);
    return !local || !local.genresFetchedAt;
  });
  await db.putMany('catalog', (await fetchByIds('catalog_artists', needArtists)).map(r => ({ id: `artist:${r.id}`, data: r.data })));

  await db.put('friend', cache);
  return cache;
}

// Rebuilds the friend's raw library from the cache: their likes with
// metadata from the own library or the catalog.
async function catalogMap() {
  return new Map((await db.all('catalog')).map(r => [r.id, r.data]));
}

export async function friendRaw(cache, state) {
  const catalog = await catalogMap();
  const tracks = new Map();
  for (const [id, like] of Object.entries(cache.likes)) {
    const base = state.rawTracks.get(id) || catalog.get(`track:${id}`);
    if (base) tracks.set(id, { ...catalogTrack(base), addedAt: like.addedAt, updatedAt: like.updatedAt });
  }
  const artists = new Map();
  for (const t of tracks.values()) for (const a of [...t.artists, ...t.albumArtists]) {
    if (artists.has(a.id)) continue;
    const own = state.rawArtists.get(a.id);
    const cat = catalog.get(`artist:${a.id}`);
    const pick = [own, cat].filter(Boolean).sort((x, y) => (y.genresFetchedAt || 0) - (x.genresFetchedAt || 0))[0];
    artists.set(a.id, { genres: [], ...(pick ? catalogArtist(pick) : {}), id: a.id, name: a.name });
  }
  const ratings = new Map();
  const elo = new Map();
  let overrides = { splitAlbums: [] };
  for (const r of Object.values(cache.records)) {
    if (r.kind === 'rating') ratings.set(r.data.id, r.data);
    else if (r.kind === 'elo') elo.set(r.data.id, r.data);
    else if (r.kind === 'override') overrides = r.data;
  }
  return { tracks, artists, ratings, elo, overrides };
}

// Genres already fetched by anyone (shared catalog), to spare Spotify quota.
export async function knownGenres(artistIds) {
  const rows = await fetchByIds('catalog_artists', artistIds);
  return rows.filter(r => r.data?.genresFetchedAt).map(r => r.data);
}

// ---------- Shared brackets ----------
export async function sharedBrackets() {
  const { data, error } = await sb.from('shared_brackets').select('*').order('synced_at', { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

export async function createSharedBracket(data) {
  const { data: row, error } = await sb.from('shared_brackets').insert({ data, updated_at: now() }).select().single();
  if (error) throw error;
  return row;
}

export async function deleteSharedBracket(id) {
  const { error } = await sb.from('shared_brackets').delete().eq('id', id);
  if (error) throw error;
}

export async function bracketVotesAndResults(bracketId) {
  const [v, r] = await Promise.all([
    sb.from('shared_votes').select('*').eq('bracket_id', bracketId),
    sb.from('shared_results').select('*').eq('bracket_id', bracketId),
  ]);
  if (v.error) throw v.error;
  if (r.error) throw r.error;
  return { votes: v.data, results: r.data };
}

export async function vote(bracketId, matchKey, userId, winner) {
  const { error } = await sb.from('shared_votes').upsert({ bracket_id: bracketId, match_key: matchKey, user_id: userId, winner, updated_at: now() }, { onConflict: 'bracket_id,match_key,user_id' });
  if (error) throw error;
}

// First writer wins, so both clients end up with the same result.
export async function recordResult(bracketId, matchKey, winner, decidedBy) {
  const { error } = await sb.from('shared_results').upsert({ bracket_id: bracketId, match_key: matchKey, winner, decided_by: decidedBy }, { onConflict: 'bracket_id,match_key', ignoreDuplicates: true });
  if (error) throw error;
}
