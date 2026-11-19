# Namakade addon for Nuvio

Static Stremio-protocol addon that lists movies and TV series from
mobile.namakade.com. A GitHub Action scrapes the site daily, generates the
whole addon as static JSON, and publishes it on GitHub Pages. No server needed.

## Install

1. Create a GitHub repo (e.g. `namakade-nuvio`) and push these files:
   `build.mjs`, `.gitignore`, `README.md`, `.github/workflows/build.yml`
2. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**
3. **Actions** tab > "Build and deploy Namakade addon" > **Run workflow**
4. When it finishes, your manifest is at:
   `https://<your-user>.github.io/<repo>/manifest.json`
5. In Nuvio: Addons > Add addon > paste that manifest URL.

## Local test run

```bash
MAX_ITEMS=10 node build.mjs     # small test (Node 18+)
node build.mjs                  # full run, output in ./dist
```

## Settings (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_ITEMS` | 0 (all) | Limit items per type for test runs |
| `MAX_PAGES` | 40 | Max pages per category |
| `CONCURRENCY` / `DELAY_MS` | 4 / 200 | Be gentle with the site |
| `STREAM_HINTS` | on | Set `0` to drop `notWebReady`/Referer hints if a stream won't play |

## Things to verify on the first real run

- **Pagination.** Category pages use "Loading More Videos" (infinite scroll).
  The real request isn't visible in the static HTML, so `CFG.pageUrl` in
  `build.mjs` is a guess (`?page=N`). If the log shows categories stuck at one
  page of items, open the site in a browser, open DevTools > Network, scroll a
  category, and copy the request pattern into `CFG.pageUrl`.
- **Multiple seasons.** The scraper follows any link/option on a series page
  that mentions "season". If a multi-season show only shows season 1, check how
  the season switcher loads and adjust `seasonLinks()`.
- **Blocked runner.** If the site refuses GitHub's servers, the build exits with
  "Nothing was scraped". Then run `node build.mjs` on your own machine and
  deploy `dist/` instead (e.g. push it to a `gh-pages` branch).
- **Playback.** Streams are direct `.mp4` links on media.negahestan.com. If the
  CDN needs a Referer or is geo-restricted, playback depends on your device.

## Limits of a static addon

No search (it needs a live server) and no live updates between daily builds.
Titles are Namakade's own transliterated names, so Nuvio won't match them to
TMDB/IMDb metadata.
