# Wallgarden Sync (embedded)

The little state-sync API that lets the dashboard's curation (likes/ratings,
watchlist queue, playlists, watch history) be the same in every browser instead
of being trapped in each browser's `localStorage`.

**This is NOT a separate service/container.** `main.py` runs *inside* the
`youtube-wallgarden` container, next to nginx, started by `supervisord` (see the
repo `Dockerfile` + `supervisord.conf`). nginx proxies `/sync/` to it on
`127.0.0.1:8017`. There is one image, one compose service, one `deploy.sh`.

- **Storage:** the shared MongoDB on the NAS (`MONGO_URI` from the deploy env),
  database `wallgarden` (isolated), collection `state`, one global document.
- **Model:** ratings/queue/playlist entries are timestamped decisions; merge is
  per-item last-write-wins, so likes, unlikes, dislikes, and removals all
  propagate. See `main.py` for the details.

## API (served under `/sync/` by the dashboard's nginx)

- `GET /health`
- `GET /sync/{profile}` — `{ fields, updatedAt }` (the `{profile}` segment is
  ignored; there is one global monolithic document).
- `PUT|POST /sync/{profile}` — body `{ fields: {...} }`, merged in.

## Tests

```bash
python test_merge.py       # standalone, no pytest needed
# or: pytest test_merge.py
```
