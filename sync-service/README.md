# Wallgarden Sync Service

Tiny per-profile state store that lets the YouTube Wallgarden dashboard share
its curation across browsers. The dashboard is otherwise a static site whose
data lives in `localStorage` — which is **per-browser**, so a like made in
Chrome never reaches Vivaldi. This service gives every *profile* one
server-side home so the same profile sees the same data everywhere.

- **Port:** `8017`
- **Storage:** MongoDB, database `wallgarden` (isolated), collection `profiles`
  (one doc per profile, `_id` = profile name).
- **Synced fields:** `video_ratings`, `liked_videos`, `queue`, `playlists`,
  `watched`. The ontology graph stays browser-local (each browser rebuilds it
  from merged ratings).

## API

- `GET /health` — Mongo ping.
- `GET /sync/{profile}` — `{ profile, fields, updatedAt }`.
- `PUT /sync/{profile}` — body `{ fields: {...} }`; **smart-merges** (additive
  union) into the stored doc and returns the merged result.

Merges are additive: concurrent likes from two browsers combine and never
clobber each other. The trade-off is that explicit *removals* (un-like, delete
from queue) don't propagate across browsers in this version — adds win.

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in MONGO_URI
MONGO_URI=... uvicorn main:app --port 8017
```

## Deploy

```bash
bash deploy.sh
```

Builds the image and ships it to the NAS via `../../deploy-kit/lib.sh`
(`MONGO_URI` / `WALLGARDEN_MONGO_DB` come from the deploy-staged `.env`). The
dashboard's nginx proxies `/sync/` here.
