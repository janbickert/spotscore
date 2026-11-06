---
title: SpotScore, Prototype
author: Jan Bickert
date: 2026-11-06
---

# SpotScore

Single-user PWA to rate Spotify liked songs and albums (1 to 10, half steps), derive artist scores, and compare items in head-to-heads and brackets. Built from `spotify-rating-pwa-scope.md`.

Vanilla JavaScript, no build step, no dependencies. All data lives in IndexedDB on the device.

## Try it locally

```bash
python -m http.server 5173 --bind 127.0.0.1
```

Open http://127.0.0.1:5173 and choose **Try with a demo library** (about 300 fictional tracks, partly pre-rated). Playback is simulated in demo mode.

## Setup guide (build plan step 1)

### 1. Register the Spotify developer app

1. Go to https://developer.spotify.com/dashboard and log in with the Premium account that will use the app.
2. **Create app**. Name: SpotScore. API: tick **Web API**.
3. Add redirect URIs (must match exactly, including the trailing slash):
   - `http://127.0.0.1:5173/` for local testing (Spotify does not accept `localhost`, use the loopback IP)
   - `https://<your-github-user>.github.io/<repo>/` for the hosted version
4. Copy the **Client ID**. No client secret is needed (PKCE).
5. Under **User Management**, add your own Spotify account email (Development Mode allows up to five users).

### 2. Host on GitHub Pages

1. Create a repository, for example `spotscore`, and push this folder (without `.claude/`).
2. Repository **Settings → Pages → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/spotscore/` on the phone.

### 3. Connect and install

1. In the app open **Settings**, paste the Client ID, check that the shown redirect URI is registered, tap **Connect Spotify**.
2. After login the first sync starts automatically. Liked songs load in pages of 50 (4,809 songs took under a minute). Genres are then fetched one artist at a time (the batch endpoint is gone) as a slow background trickle of about 40 requests per minute, artists with the most liked songs first.
3. Development Mode apps have a request quota. When Spotify answers `429` with reason `QUOTA_EXCEEDED`, genre loading pauses for 1 hour, then 2, 4 and so on up to 24 hours, and resumes automatically while the app is open. Settings shows progress and the resume time. In the first live test the quota ran out after about 600 artist requests sent at 8 per second.
4. In Chrome on Android: menu → **Install app** (or the Install button in Settings).

## What the prototype covers

| Scope item | Status |
|---|---|
| Library: liked tracks, derived albums and artists with genres | Done. Incremental sync stops at the first known like; **Full resync** also removes unliked songs |
| Track and album ratings, 1 to 10 in half steps | Done. Tap a number, tap again for the half step |
| Album: direct rating and track average side by side | Done |
| Artist score: 50% album average + 50% track average, fallback 100% | Done, with breakdown on the artist page |
| Head-to-head, random or genre pool | Done. Pairs are picked with close Elo for informative duels |
| Brackets 8, 16, 32, 64 | Done. Resumable, stored in IndexedDB |
| Elo suggestions for tracks and albums, confirm or reject each | Done. Suggestion when the Elo-implied rating differs by 0.75 points or more (unrated items: after 3 duels) |
| Artist duels: separate ranking, no effect on artist score | Done (Rankings → Artist duels) |
| Playback: play, pause, skip on the phone via Web API | Done. Needs Premium and an active Spotify device |
| JSON export and import | Done. Import merges by `updatedAt`, newer wins |
| PWA: manifest, service worker, install | Done. Network first, offline fallback to cache |
| Prepared for cloud sync | Stable IDs (`track:<spotifyId>`), `createdAt` / `updatedAt` on every record, cleared ratings kept as tombstones |

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css` | Shell and styles, "Malachite" design (handoff 3a in `docs/design_handoff_spotscore_malachite/`). Colours are tokens on `:root` |
| `js/app.js` | State, router, all screens |
| `js/ui.js` | Design components: number pills, wedge rating slider, swipe-to-rate rows, podium |
| `icons/spotify/` | Official Spotify full logo (white RGB, unmodified, from the Design & Branding Guidelines) and its icon, used for attribution |

## Spotify Design & Branding Guidelines

Checked against developer.spotify.com/documentation/design on 2026-11-06:

- Attribution: the official Spotify logo (white, at least 70 px wide, with clear space) appears on every screen that shows Spotify content; the playing bar uses the Spotify icon. Not shown for the fictional demo library.
- Linking: track, album and artist pages link back with "Listen on Spotify".
- Artwork: unaltered, uncropped, no overlays, corners rounded 4 px (8 px on large screens).
- App logo: SpotScore's own bar mark, not green and not a circle (the guidelines reserve Spotify Green, the circle and the waves).
- Green in the UI (`--accent: #1ed760`) is not restricted by the guidelines; it is one token in `css/app.css` if it should change.
- Open recommendation: the guidelines suggest play/pause only and the platform's default font. SpotScore keeps skip (part of the scope) and Figtree (from the design).
| `js/db.js` | IndexedDB wrapper |
| `js/scoring.js` | Rating and artist score rules |
| `js/elo.js` | Elo duels and rating suggestions |
| `js/spotify.js` | PKCE login, rate-limit aware API calls, sync, playback |
| `js/demo.js` | Fictional demo library |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |

## Known limits of the prototype

- Tested live: login, liked songs sync (4,809 tracks, 3,535 albums, 2,567 artists), quota handling. Playback not yet tested live.
- The exact length of Spotify's quota window is not documented. The 1-hour first pause is a guess to tune.
- Artists without loaded genres are left out of genre pools and filters until their genres arrive.
- Brackets support power-of-two sizes only (8, 16, 32, 64), no byes.
- Elo constants (80 Elo points per rating point, K 48 then 32) are first guesses and should be tuned with real use.
