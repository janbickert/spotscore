// Spotify Web API: Authorization Code flow with PKCE (no backend, no secret),
// rate-limit aware fetch, incremental library sync and playback control.

import { db, now } from './db.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = ['user-library-read', 'user-read-playback-state', 'user-modify-playback-state'];

export const redirectUri = () => location.origin + location.pathname;

// ---------- PKCE helpers ----------
function randomString(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}
async function challengeFrom(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login(clientId) {
  const verifier = randomString(64);
  const stateParam = randomString(16);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', stateParam);
  await db.setMeta('clientId', clientId);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFrom(verifier),
    scope: SCOPES.join(' '),
    state: stateParam,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

// Called on startup. Returns true if a login redirect was handled.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  if (error) throw new Error(`Spotify login cancelled: ${error}`);
  if (params.get('state') !== sessionStorage.getItem('pkce_state')) throw new Error('Login state mismatch, please try again.');
  const clientId = await db.getMeta('clientId');
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: sessionStorage.getItem('pkce_verifier'),
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  await storeToken(await res.json());
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  return true;
}

async function storeToken(json) {
  const prev = (await db.getMeta('token')) || {};
  await db.setMeta('token', {
    access: json.access_token,
    refresh: json.refresh_token || prev.refresh,
    expiresAt: now() + (json.expires_in - 60) * 1000,
    // Refresh tokens expire six months after authorization (scope section 4).
    authorizedAt: json.refresh_token && !prev.refresh ? now() : (prev.authorizedAt || now()),
  });
}

async function accessToken() {
  const token = await db.getMeta('token');
  if (!token) throw new Error('Not connected to Spotify');
  if (now() < token.expiresAt) return token.access;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: await db.getMeta('clientId') });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) {
    await db.setMeta('token', null);
    throw new Error('Spotify session expired, please log in again. Your ratings are kept.');
  }
  await storeToken(await res.json());
  return (await db.getMeta('token')).access;
}

export async function isConnected() {
  return !!(await db.getMeta('token'));
}
export async function logout() {
  await db.setMeta('token', null);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Rate-limit aware request.
// 429 with reason QUOTA_EXCEEDED: the app's quota is used up, retrying only burns
// more of it, so this throws at once (err.quota = true).
// Other 429s: wait and retry with growing pauses. Browsers cannot read the
// Retry-After header cross-origin, so the pause is estimated (5 s, 15 s, 45 s).
export async function api(path, { method = 'GET', body, onWait } = {}, attempt = 0) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const info = await res.json().catch(() => null);
    if (info?.error?.reason === 'QUOTA_EXCEEDED' || attempt >= 3) {
      const err = new Error('Spotify request limit reached');
      err.status = 429;
      err.quota = true;
      throw err;
    }
    const wait = (Number(res.headers.get('Retry-After')) || 5 * 3 ** attempt) * 1000;
    onWait?.(wait);
    await sleep(wait);
    return api(path, { method, body, onWait }, attempt + 1);
  }
  if (res.status >= 500 && attempt < 3) {
    await sleep(1000 * 2 ** attempt);
    return api(path, { method, body, onWait }, attempt + 1);
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  // Player commands may answer 200 with a plain-text body instead of JSON.
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------- Library sync ----------
// Liked songs come newest first. Incremental sync pages until it meets a track
// already stored with the same addedAt. Artists are fetched one by one
// (batch endpoints were removed), only those without cached genres.
export async function syncLibrary(state, { full = false, onProgress = () => {} } = {}) {
  const known = new Map([...state.tracks.values()].map(t => [t.id, t.addedAt]));
  const seen = new Set();
  const newTracks = [];
  let url = '/me/tracks?limit=50';
  let total = 0;
  let stop = false;

  while (url && !stop) {
    const page = await api(url, { onWait: ms => onProgress({ phase: 'tracks', waiting: ms }) });
    total = page.total;
    for (const item of page.items) {
      const t = item.track;
      if (!t || !t.id) continue;
      seen.add(t.id);
      if (!full && known.get(t.id) === item.added_at) { stop = true; break; }
      newTracks.push(mapTrack(t, item.added_at));
    }
    onProgress({ phase: 'tracks', done: seen.size, total });
    url = page.next;
  }

  const t0 = now();
  const tracks = new Map(state.tracks);
  for (const t of newTracks) tracks.set(t.id, { ...(tracks.get(t.id) || {}), ...t, updatedAt: t0, createdAt: tracks.get(t.id)?.createdAt || t0 });
  // A full sync also detects unliked songs; ratings of removed tracks stay stored.
  if (full) for (const id of [...tracks.keys()]) if (!seen.has(id)) tracks.delete(id);

  const { albums, artists } = deriveAlbumsAndArtists(tracks, state);
  await db.clear('tracks'); await db.putMany('tracks', [...tracks.values()]);
  await db.clear('albums'); await db.putMany('albums', [...albums.values()]);
  await db.putMany('artists', [...artists.values()]);
  state.tracks = tracks; state.albums = albums; state.artists = artists;
  await db.setMeta('lastSync', now());
  return { added: newTracks.length, total: tracks.size };
}

// ---------- Artist genres ----------
// One request per artist (batch endpoint removed). Runs as a slow background
// trickle, artists with the most liked songs first, and pauses when Spotify
// reports the quota as used up. Every fetched artist is saved at once, so
// nothing is lost when it stops.
const GENRE_PACE_MS = 1500;          // about 40 requests per minute
const QUOTA_PAUSE_MS = 60 * 60 * 1000; // first pause after a quota hit, doubles up to 24 h

export async function genreStatus(state) {
  const all = [...state.artists.values()];
  const done = all.filter(a => a.genresFetchedAt).length;
  const pausedUntil = (await db.getMeta('genrePausedUntil')) || 0;
  return { done, total: all.length, pausedUntil: pausedUntil > now() ? pausedUntil : 0 };
}

let genreRun = null;
export function syncGenres(state, { onProgress = () => {}, force = false } = {}) {
  if (genreRun) return genreRun;
  genreRun = (async () => {
    const pausedUntil = (await db.getMeta('genrePausedUntil')) || 0;
    if (!force && pausedUntil > now()) return { paused: true, pausedUntil };
    const missing = [...state.artists.values()]
      .filter(a => !a.genresFetchedAt)
      .sort((a, b) => b.trackIds.length - a.trackIds.length);
    const total = state.artists.size;
    let done = total - missing.length;
    for (const a of missing) {
      try {
        const info = await api(`/artists/${a.id}`, { onWait: ms => onProgress({ phase: 'artists', done, total, waiting: ms }) });
        const current = state.artists.get(a.id) || a;
        const updated = { ...current, genres: info.genres || [], image: info.images?.[info.images.length - 1]?.url || current.image, genresFetchedAt: now(), updatedAt: now() };
        state.artists.set(a.id, updated);
        await db.put('artists', updated);
        await db.setMeta('genrePauseStep', 0);
      } catch (e) {
        if (e.quota) {
          const step = (await db.getMeta('genrePauseStep')) || 0;
          const until = now() + Math.min(QUOTA_PAUSE_MS * 2 ** step, 24 * QUOTA_PAUSE_MS);
          await db.setMeta('genrePauseStep', step + 1);
          await db.setMeta('genrePausedUntil', until);
          onProgress({ phase: 'artists', done, total, pausedUntil: until });
          return { paused: true, pausedUntil: until, done, total };
        }
        if (e.status !== 404) throw e;
      }
      done++;
      onProgress({ phase: 'artists', done, total });
      await sleep(GENRE_PACE_MS);
    }
    await db.setMeta('genrePausedUntil', 0);
    return { paused: false, done, total };
  })().finally(() => { genreRun = null; });
  return genreRun;
}

function mapTrack(t, addedAt) {
  const img = t.album?.images || [];
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    durationMs: t.duration_ms,
    trackNumber: t.track_number,
    addedAt,
    albumId: t.album.id,
    albumName: t.album.name,
    albumImage: img[1]?.url || img[0]?.url || null,
    albumImageSmall: img[img.length - 1]?.url || null,
    albumArtists: t.album.artists.map(a => ({ id: a.id, name: a.name })),
    albumReleaseDate: t.album.release_date,
    albumUri: t.album.uri,
    artists: t.artists.map(a => ({ id: a.id, name: a.name })),
  };
}

// Albums = all albums containing at least one liked song.
// Artists = all artists of tracks and albums, keeping cached genres.
export function deriveAlbumsAndArtists(tracks, state) {
  const albums = new Map();
  const artists = new Map();
  const t0 = now();
  const touchArtist = (a) => {
    if (!artists.has(a.id)) {
      const prev = state.artists.get(a.id);
      artists.set(a.id, { genres: [], genresFetchedAt: null, image: null, createdAt: t0, ...(prev || {}), id: a.id, name: a.name, albumIds: [], trackIds: [], updatedAt: t0 });
    }
    return artists.get(a.id);
  };
  for (const t of tracks.values()) {
    if (!albums.has(t.albumId)) {
      const prev = state.albums.get(t.albumId);
      albums.set(t.albumId, {
        createdAt: prev?.createdAt || t0, id: t.albumId, uri: t.albumUri, name: t.albumName, image: t.albumImage,
        imageSmall: t.albumImageSmall, artists: t.albumArtists, releaseDate: t.albumReleaseDate, trackIds: [], updatedAt: t0,
      });
      for (const a of t.albumArtists) { const ar = touchArtist(a); if (!ar.albumIds.includes(t.albumId)) ar.albumIds.push(t.albumId); }
    }
    albums.get(t.albumId).trackIds.push(t.id);
    for (const a of t.artists) touchArtist(a).trackIds.push(t.id);
  }
  for (const al of albums.values()) al.trackIds.sort((a, b) => (tracks.get(a).trackNumber || 0) - (tracks.get(b).trackNumber || 0));
  return { albums, artists };
}

// ---------- Playback (needs Premium and Spotify open as the active device) ----------
async function activeDeviceHint() {
  const devices = await api('/me/player/devices');
  if (!devices?.devices?.length) throw new Error('No Spotify device found. Open the Spotify app on your phone first.');
  return devices.devices.find(d => d.is_active) || devices.devices[0];
}

export const playback = {
  // A song is always started inside its album (context + offset). Tested
  // 2026-11-06: a bare { uris: [...] } request returns 204 but Spotify loads
  // nothing and the current playback just ends; the album context works and
  // also lets playback continue with the next track.
  async playTrack(uri, albumUri) {
    const dev = await activeDeviceHint();
    const body = albumUri ? { context_uri: albumUri, offset: { uri } } : { uris: [uri] };
    await api(`/me/player/play?device_id=${dev.id}`, { method: 'PUT', body });
  },
  async playAlbum(albumUri, trackUri) {
    const dev = await activeDeviceHint();
    await api(`/me/player/play?device_id=${dev.id}`, { method: 'PUT', body: { context_uri: albumUri, ...(trackUri ? { offset: { uri: trackUri } } : {}) } });
  },
  resume: () => api('/me/player/play', { method: 'PUT' }),
  pause: () => api('/me/player/pause', { method: 'PUT' }),
  next: () => api('/me/player/next', { method: 'POST' }),
  state: () => api('/me/player'),
};
