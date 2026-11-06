// Elo-style duel engine (scope section 2.3).
// Tracks and albums: Elo is seeded from the current rating and maps back to an
// implied rating. Differences become suggestions the user confirms or rejects.
// Artists: plain Elo ranking, seeded at 1500, never touches artist scores.

import { db, now } from './db.js';
import { clampRating, ratingKey } from './scoring.js';

const BASE = 1500;
const POINTS_PER_RATING = 80; // 1 rating point = 80 Elo points
const MIN_GAMES_UNRATED = 3;  // unrated items need a few duels before a suggestion
const SUGGEST_GAP = 0.75;     // rating points between Elo-implied and current rating

export const seedElo = (rating) => (rating == null ? BASE : BASE + (rating - 5.5) * POINTS_PER_RATING);
export const impliedRating = (elo) => clampRating(5.5 + (elo - BASE) / POINTS_PER_RATING);
const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
const kFactor = (games) => (games < 5 ? 48 : 32);

export function createElo(state, scoring) {
  function get(type, refId) {
    const id = ratingKey(type, refId);
    const current = type === 'artist' ? null : scoring.rating(type, refId);
    let rec = state.elo.get(id);
    if (!rec) {
      rec = { id, type, refId, elo: seedElo(current), games: 0, wins: 0, losses: 0, seededFrom: current, createdAt: now(), updatedAt: now() };
    } else if (type !== 'artist' && current !== rec.seededFrom) {
      // The user changed the rating directly: re-anchor Elo to it.
      rec = { ...rec, elo: seedElo(current), seededFrom: current, updatedAt: now() };
    }
    return rec;
  }

  async function save(rec) {
    state.elo.set(rec.id, rec);
    await db.put('elo', rec);
  }

  async function refreshSuggestion(rec) {
    if (rec.type === 'artist') return null;
    const current = scoring.rating(rec.type, rec.refId);
    const raw = 5.5 + (rec.elo - BASE) / POINTS_PER_RATING;
    const to = impliedRating(rec.elo);
    const id = rec.id;
    // Rated items need a clear gap (0.75 points, never reachable by one duel);
    // unrated items need a few duels first.
    const enough = current != null ? Math.abs(raw - current) >= SUGGEST_GAP : rec.games >= MIN_GAMES_UNRATED;
    if (!enough || to === current) {
      if (state.suggestions.has(id)) { state.suggestions.delete(id); await db.delete('suggestions', id); }
      return null;
    }
    const prev = state.suggestions.get(id);
    const sug = {
      id, type: rec.type, refId: rec.refId, from: current, to,
      record: `${rec.wins}W ${rec.losses}L`,
      createdAt: prev ? prev.createdAt : now(), updatedAt: now(),
    };
    state.suggestions.set(id, sug);
    await db.put('suggestions', sug);
    return sug;
  }

  // Records one duel. Returns the Elo deltas for display.
  async function duel(type, winnerId, loserId) {
    const w = get(type, winnerId);
    const l = get(type, loserId);
    const ew = expected(w.elo, l.elo);
    const dw = kFactor(w.games) * (1 - ew);
    const dl = kFactor(l.games) * (0 - (1 - ew));
    const t = now();
    const w2 = { ...w, elo: w.elo + dw, games: w.games + 1, wins: w.wins + 1, updatedAt: t };
    const l2 = { ...l, elo: l.elo + dl, games: l.games + 1, losses: l.losses + 1, updatedAt: t };
    await save(w2);
    await save(l2);
    await refreshSuggestion(w2);
    await refreshSuggestion(l2);
    return { winner: w2, loser: l2, dw, dl };
  }

  async function accept(sugId, setRating) {
    const sug = state.suggestions.get(sugId);
    if (!sug) return;
    await setRating(sug.type, sug.refId, sug.to);
    const rec = state.elo.get(sugId);
    if (rec) await save({ ...rec, seededFrom: sug.to, updatedAt: now() });
    state.suggestions.delete(sugId);
    await db.delete('suggestions', sugId);
  }

  async function reject(sugId) {
    const sug = state.suggestions.get(sugId);
    if (!sug) return;
    // The user keeps their rating: re-anchor Elo so the same suggestion does not return at once.
    const rec = state.elo.get(sugId);
    if (rec) await save({ ...rec, elo: seedElo(sug.from), seededFrom: sug.from, updatedAt: now() });
    state.suggestions.delete(sugId);
    await db.delete('suggestions', sugId);
  }

  const eloOf = (type, refId) => get(type, refId);

  return { duel, accept, reject, eloOf };
}
