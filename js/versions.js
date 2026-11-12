// Editions and versions: treats remastered, deluxe, expanded, regional and
// other editions of the same album as ONE album, and the same song liked in
// several versions as ONE song. Raw records from Spotify stay untouched in
// IndexedDB; the merged view is rebuilt in memory on every load and sync.
//
// Rules (agreed 2026-11-12, based on an analysis of the real library):
// - Same album: same main artist + same title once edition notes are ignored.
// - Same song: same main artist + same normalised title + length within 10 s.
// - Notes marking a genuinely different recording stay part of the title.
// - The edition with the most liked songs (then the oldest) represents the
//   group; its real Spotify title is shown (Spotify forbids altering metadata).
// - "Not the same album" splits an edition off again (stored override).

const EDITION = /(remaster|deluxe|expanded|anniversary|bonus|edition|reissue|collector|legacy|mono|stereo|original album mix|version)/i;
const DIFFERENT = /(taylor|live|concert|acoustic|demo|instrumental|remix|radio edit|single version)/i;
const SAME_SONG_MS = 10000;
// A "mix" is a different recording, except album/mono/stereo mixes.
const isDifferent = (s) => DIFFERENT.test(s) || (/\bmix\b/i.test(s) && !/(album|mono|stereo)\s+mix/i.test(s));

// "Nevermind (Remastered)" and "Nevermind (Deluxe Edition)" both → "nevermind".
export function normTitle(title) {
  let t = String(title || '');
  const strip = (m, inner) => (EDITION.test(inner) && !isDifferent(inner) ? '' : m);
  for (;;) {
    const prev = t;
    t = t.replace(/\s*[([]([^)\]]*)[)\]]\s*$/, strip).replace(/\s+-\s+([^-]*)$/, strip);
    if (t === prev) break;
  }
  return t.toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ').trim();
}

const mainArtist = (x) => x.artists?.[0]?.id || '';
const songKey = (artistId, name) => `${artistId}|${normTitle(name)}`;

// Builds the merged view. overrides.splitAlbums: album ids that stay separate.
export function buildVersions(rawTracks, rawAlbums, rawArtists, overrides = {}) {
  const split = new Set(overrides.splitAlbums || []);

  // ---- Albums ----
  const albumGroups = new Map();
  for (const a of rawAlbums.values()) {
    const key = split.has(a.id) ? `id:${a.id}` : `${mainArtist(a)}|${normTitle(a.name)}`;
    if (!albumGroups.has(key)) albumGroups.set(key, []);
    albumGroups.get(key).push(a);
  }
  const albumAlias = new Map();   // raw album id → canonical album id
  const albumMembers = new Map(); // canonical album id → raw album ids
  for (const group of albumGroups.values()) {
    group.sort((x, y) => (y.trackIds.length - x.trackIds.length)
      || (x.releaseDate || '9999').localeCompare(y.releaseDate || '9999') || x.id.localeCompare(y.id));
    const canon = group[0].id;
    albumMembers.set(canon, group.map(a => a.id));
    for (const a of group) albumAlias.set(a.id, canon);
  }

  // ---- Tracks ----
  const songGroups = new Map();
  for (const t of rawTracks.values()) {
    const key = songKey(mainArtist(t), t.name);
    if (!songGroups.has(key)) songGroups.set(key, []);
    songGroups.get(key).push(t);
  }
  const trackAlias = new Map();
  const trackMembers = new Map();
  const matchIndex = new Map(); // song key → [{ id: canonical, durationMs }]
  for (const [key, group] of songGroups) {
    // Split by length: versions more than 10 s apart are different recordings.
    group.sort((x, y) => x.durationMs - y.durationMs);
    const clusters = [];
    for (const t of group) {
      const c = clusters.at(-1);
      if (c && t.durationMs - c[0].durationMs <= SAME_SONG_MS) c.push(t);
      else clusters.push([t]);
    }
    for (const c of clusters) {
      // Prefer the version on the album that represents its group, then the oldest like.
      c.sort((x, y) => (albumAlias.get(y.albumId) === y.albumId) - (albumAlias.get(x.albumId) === x.albumId)
        || x.addedAt.localeCompare(y.addedAt));
      const canon = c[0];
      trackMembers.set(canon.id, c.map(t => t.id));
      for (const t of c) trackAlias.set(t.id, canon.id);
      if (!matchIndex.has(key)) matchIndex.set(key, []);
      matchIndex.get(key).push({ id: canon.id, durationMs: canon.durationMs });
    }
  }

  // ---- Merged records ----
  const tracks = new Map();
  for (const [canonId, ids] of trackMembers) {
    const raw = rawTracks.get(canonId);
    const versions = ids.map(id => rawTracks.get(id));
    tracks.set(canonId, {
      ...raw,
      albumId: albumAlias.get(raw.albumId) || raw.albumId,
      addedAt: versions.map(v => v.addedAt).sort().at(-1), // most recent like
      versions: ids,
    });
  }
  const albums = new Map();
  for (const [canonId, ids] of albumMembers) {
    const raw = rawAlbums.get(canonId);
    const trackIds = [...new Set(ids.flatMap(id => rawAlbums.get(id).trackIds).map(t => trackAlias.get(t)).filter(Boolean))]
      .sort((x, y) => (rawTracks.get(x)?.trackNumber || 0) - (rawTracks.get(y)?.trackNumber || 0));
    albums.set(canonId, { ...raw, trackIds, editions: ids });
  }
  const artists = new Map();
  for (const a of rawArtists.values()) artists.set(a.id, { ...a, trackIds: [], albumIds: [] });
  for (const t of tracks.values()) for (const ar of t.artists) artists.get(ar.id)?.trackIds.push(t.id);
  for (const al of albums.values()) for (const ar of al.artists) artists.get(ar.id)?.albumIds.push(al.id);

  // Finds the library song for something playing on Spotify, also when
  // Spotify plays a different version than the one that was liked.
  const resolvePlaying = (item) => {
    if (!item) return null;
    if (trackAlias.has(item.id)) return trackAlias.get(item.id);
    const cands = matchIndex.get(songKey(item.artistId, item.name)) || [];
    const best = cands.map(c => ({ ...c, d: Math.abs(c.durationMs - (item.durationMs || 0)) })).sort((x, y) => x.d - y.d)[0];
    return best && best.d <= SAME_SONG_MS ? best.id : null;
  };

  return { tracks, albums, artists, trackAlias, albumAlias, trackMembers, albumMembers, resolvePlaying };
}
