// Demo library with fictional artists, so the prototype can be tried
// without a Spotify developer app. Shapes match the synced records.

import { deriveAlbumsAndArtists } from './spotify.js';

const GENRES = ['indie rock', 'dream pop', 'synthwave', 'neo soul', 'jazz fusion', 'post-punk', 'lo-fi hip hop', 'german indie', 'ambient', 'alt country', 'electropop', 'shoegaze'];
const A1 = ['Velvet', 'Paper', 'Neon', 'Hollow', 'Golden', 'Static', 'Midnight', 'Copper', 'Silent', 'Lunar', 'Wild', 'Glass', 'Northern', 'Faded', 'Electric', 'Crimson'];
const A2 = ['Harbor', 'Moths', 'Satellites', 'Orchard', 'Tides', 'Parade', 'Machines', 'Lanterns', 'Foxes', 'Archive', 'Weather', 'Rivers', 'Signals', 'Gardens', 'Echo', 'Season'];
const W = ['Summer', 'Static', 'Blue', 'Drive', 'Ghost', 'Light', 'Morning', 'Heart', 'Window', 'Fever', 'Road', 'Ocean', 'Glow', 'Paper', 'Dream', 'Fire', 'City', 'Silver', 'Shadow', 'Dance', 'Rain', 'Night', 'Signal', 'Gold', 'Stone', 'Mirror', 'Velvet', 'Coast', 'Tunnel', 'Bloom'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function buildDemo() {
  const r = rng(42);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const id = (p, n) => `${p}${n.toString(36).padStart(6, '0')}`;
  const title = (n) => Array.from({ length: n }, () => pick(W)).join(' ');

  const tracks = new Map();
  const genreByArtist = new Map();
  let tn = 0;
  const usedNames = new Set();
  const day = 86400000;
  const start = Date.UTC(2019, 0, 1);

  for (let ai = 0; ai < 28; ai++) {
    let name;
    do { name = `${r() < 0.4 ? 'The ' : ''}${pick(A1)} ${pick(A2)}`; } while (usedNames.has(name));
    usedNames.add(name);
    const artist = { id: id('ar', ai), name };
    const g = [pick(GENRES)];
    if (r() < 0.6) g.push(pick(GENRES.filter(x => x !== g[0])));
    genreByArtist.set(artist.id, g);
    const albumCount = 1 + Math.floor(r() * 3);
    for (let bi = 0; bi < albumCount; bi++) {
      const albumId = id('al', ai * 10 + bi);
      const albumName = title(1 + Math.floor(r() * 2));
      const year = 2008 + Math.floor(r() * 18);
      const liked = 2 + Math.floor(r() * 7);
      const guest = r() < 0.25 ? { id: id('ar', Math.floor(r() * 28)), name: null } : null;
      for (let ti = 0; ti < liked; ti++) {
        const tid = id('tr', tn++);
        const artists = [artist];
        if (guest && ti === 0 && guest.id !== artist.id) artists.push(guest);
        tracks.set(tid, {
          id: tid, uri: `spotify:track:demo${tid}`, name: title(1 + Math.floor(r() * 3)),
          durationMs: 150000 + Math.floor(r() * 150000), trackNumber: ti + 1 + Math.floor(r() * 2) * ti,
          addedAt: new Date(start + Math.floor(r() * 2400) * day).toISOString(),
          albumId, albumName, albumImage: null, albumImageSmall: null,
          albumArtists: [artist], albumReleaseDate: `${year}-01-01`, albumUri: `spotify:album:demo${albumId}`,
          artists, createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
    }
  }
  // Resolve guest artist names now that every artist exists.
  const names = new Map();
  for (const t of tracks.values()) for (const a of t.albumArtists) names.set(a.id, a.name);
  for (const t of tracks.values()) t.artists = t.artists.filter(a => names.has(a.id)).map(a => ({ id: a.id, name: names.get(a.id) }));

  const empty = { artists: new Map(), albums: new Map() };
  const { albums, artists } = deriveAlbumsAndArtists(tracks, empty);
  for (const a of artists.values()) { a.genres = genreByArtist.get(a.id) || []; a.genresFetchedAt = Date.now(); }

  // Pre-rate part of the library so scores and rankings have something to show.
  const ratings = [];
  const t0 = Date.now();
  const quality = new Map([...artists.keys()].map(k => [k, 4 + r() * 5]));
  for (const t of tracks.values()) {
    if (r() < 0.45) {
      const base = quality.get(t.albumArtists[0].id);
      const v = Math.min(10, Math.max(1, Math.round((base + (r() - 0.5) * 3) * 2) / 2));
      ratings.push({ id: `track:${t.id}`, type: 'track', refId: t.id, value: v, createdAt: t0, updatedAt: t0 });
    }
  }
  for (const al of albums.values()) {
    if (r() < 0.35) {
      const base = quality.get(al.artists[0].id);
      const v = Math.min(10, Math.max(1, Math.round((base + (r() - 0.5) * 2) * 2) / 2));
      ratings.push({ id: `album:${al.id}`, type: 'album', refId: al.id, value: v, createdAt: t0, updatedAt: t0 });
    }
  }
  return { tracks, albums, artists, ratings };
}
