// Score rules from the scope document, section 2.2.
// Track:  direct rating 1..10 in half steps.
// Album:  direct rating, plus the average of its rated tracks shown side by side.
// Artist: 50% average of direct album ratings + 50% average of track ratings.
//         If only one side exists, that side counts 100%.

export const MIN = 1;
export const MAX = 10;
export const STEP = 0.5;

export const ratingKey = (type, refId) => `${type}:${refId}`;

export function clampRating(v) {
  const r = Math.round(v / STEP) * STEP;
  return Math.min(MAX, Math.max(MIN, r));
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

export function createScoring(state) {
  // A merged album or song can carry ratings under any of its editions or
  // versions (for example rated before merging existed). The most recent
  // rating record wins; a newer cleared rating (null) wins too.
  const members = (type, id) => (type === 'track' ? state.trackMembers?.get(id)
    : type === 'album' ? state.albumMembers?.get(id) : null) || [id];
  const rating = (type, id) => {
    let best = null;
    for (const m of members(type, id)) {
      const r = state.ratings.get(ratingKey(type, m));
      if (r && (!best || (r.updatedAt || 0) > (best.updatedAt || 0))) best = r;
    }
    return best && best.value != null ? best.value : null;
  };

  const albumTrackAvg = (albumId) => {
    const album = state.albums.get(albumId);
    if (!album) return null;
    return avg(album.trackIds.map(t => rating('track', t)).filter(v => v != null));
  };

  const artistBreakdown = (artistId) => {
    const artist = state.artists.get(artistId);
    if (!artist) return { albumAvg: null, trackAvg: null, score: null, albumCount: 0, trackCount: 0 };
    const albumVals = artist.albumIds.map(a => rating('album', a)).filter(v => v != null);
    const trackVals = artist.trackIds.map(t => rating('track', t)).filter(v => v != null);
    const albumAvg = avg(albumVals);
    const trackAvg = avg(trackVals);
    let score = null;
    let weights = null;
    if (albumAvg != null && trackAvg != null) { score = 0.5 * albumAvg + 0.5 * trackAvg; weights = [50, 50]; }
    else if (albumAvg != null) { score = albumAvg; weights = [100, 0]; }
    else if (trackAvg != null) { score = trackAvg; weights = [0, 100]; }
    return { albumAvg, trackAvg, score, weights, albumCount: albumVals.length, trackCount: trackVals.length };
  };

  return {
    rating,
    trackScore: (id) => rating('track', id),
    albumScore: (id) => rating('album', id),
    albumTrackAvg,
    artistBreakdown,
    artistScore: (id) => artistBreakdown(id).score,
    scoreOf(type, id) {
      if (type === 'artist') return artistBreakdown(id).score;
      return rating(type, id);
    },
  };
}

export const fmt = (v) => (v == null ? '–' : Number.isInteger(v * 2) ? v.toFixed(1) : v.toFixed(2));
