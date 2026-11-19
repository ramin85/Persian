#!/usr/bin/env node
// Namakade -> static Stremio/Nuvio addon generator.
// Scrapes mobile.namakade.com (movies + series) and writes a folder of static
// JSON files (manifest, catalogs, meta, streams) that GitHub Pages can serve.
// No npm dependencies: needs Node 18+ (built-in fetch).

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CFG = {
  movieHome: 'https://mobile.namakade.com/movies',
  seriesHome: 'https://mobile.namakade.com/serial',
  outDir: process.env.OUT_DIR || 'dist',
  cacheFile: process.env.CACHE_FILE || '.cache/details.json',
  concurrency: Number(process.env.CONCURRENCY || 4),
  delayMs: Number(process.env.DELAY_MS || 200),
  maxPages: Number(process.env.MAX_PAGES || 40), // per category
  maxItems: Number(process.env.MAX_ITEMS || 0), // 0 = unlimited (use a small number for test runs)
  streamHints: process.env.STREAM_HINTS !== '0', // adds notWebReady + Referer hint to streams
  referer: 'https://mobile.namakade.com/',
  addonId: 'community.namakade.static',
  addonName: 'Namakade',
  version: process.env.ADDON_VERSION || '1.0.0',
  // The category pages use "Loading More Videos" (infinite scroll). The real AJAX
  // endpoint is not visible in the static HTML, so this is a best guess. If your
  // logs say "no pagination detected", open DevTools > Network on a category page,
  // scroll down, and copy the request pattern here.
  pageUrl: (url, p) => url + (url.includes('?') ? '&' : '?') + 'page=' + p,
};

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- HTTP ----------
async function get(url, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*' },
        redirect: 'follow',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    }
  }
  throw new Error(`${url}: ${lastErr?.message}`);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          console.warn('  ! ' + e.message);
          out[idx] = null;
        }
        await sleep(CFG.delayMs);
      }
    }),
  );
  return out;
}

// ---------- tiny HTML helpers ----------
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const textOf = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function absUrl(href, base) {
  try {
    return new URL(decode(href), base).href;
  } catch {
    return null;
  }
}

function* anchors(html, base) {
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = absUrl(m[1], base);
    if (href) yield { href, inner: m[2] };
  }
}

function firstImg(inner, base) {
  for (const tag of inner.match(/<img\b[^>]*>/gi) || []) {
    const m =
      tag.match(/\bdata-(?:src|original)\s*=\s*["']([^"']+)["']/i) ||
      tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m || m[1].startsWith('data:') || /PlayScreen|logo/i.test(m[1])) continue;
    return absUrl(m[1], base);
  }
  return '';
}

function metaImage(html) {
  const m =
    html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i);
  const u = m && decode(m[1]);
  return u && /media\.negahestan\.com/i.test(u) ? u : '';
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decode(m[1]).replace(/\s*\|\s*Negahestan\.com\s*$/i, '').trim() : '';
}

function pickStream(html) {
  const src = html.replace(/\\\//g, '/');
  const all = [...src.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>\\]*)?/gi)].map((m) =>
    decode(m[0]),
  );
  return (
    all.find((u) => /negahestan\.com\/ipnx\/media\/(?:movies|series)\//i.test(u)) || all[0] || null
  );
}

const niceName = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

// ---------- URL classification ----------
const matchMovie = (u) => {
  const m = u.pathname.match(/^\/(?:iran-\d+-movies|best-\d+-movies|movies)\/([^/]+)\/([^/]+)\/?$/i);
  return m ? safeDecode(m[2]) : null;
};
const matchSeries = (u) => {
  const m = u.pathname.match(/^\/series(?:es)?\/([^/]+)\/?$/i);
  return m && m[1].toLowerCase() !== 'category' ? safeDecode(m[1]) : null;
};
const matchEpisode = (u) => {
  const m = u.pathname.match(/^\/series(?:es)?\/([^/]+)\/episodes\/([^/]+)\/?$/i);
  return m ? { series: safeDecode(m[1]), ep: safeDecode(m[2]) } : null;
};

// ---------- parsers (exported for tests) ----------
export function parseListing(html, pageUrl, kind) {
  const items = new Map();
  for (const a of anchors(html, pageUrl)) {
    const u = new URL(a.href);
    const key = kind === 'movie' ? matchMovie(u) : matchSeries(u);
    if (!key) continue;
    const it = items.get(key) || { kind, key, url: u.href, title: '', genre: '', director: '', thumb: '' };
    const img = firstImg(a.inner, pageUrl);
    if (img && !it.thumb) it.thumb = img;
    const t = textOf(a.inner);
    if (t && !/^watch now$/i.test(t)) {
      const m =
        kind === 'movie'
          ? t.match(/^(.*?)\s+Director:\s*(.*?)\s*Genre:\s*(.*?)\s*Watch Now$/i)
          : t.match(/^(.*?)\s+Episode:\s*\d+\s+Genre:\s*(.*?)\s*Watch Now$/i);
      if (m) {
        it.title = it.title || m[1].trim();
        if (kind === 'movie') {
          it.director = it.director || m[2].trim();
          it.genre = it.genre || m[3].trim();
        } else it.genre = it.genre || m[2].trim();
      } else if (!it.title) it.title = t.replace(/\s*Watch Now$/i, '').trim();
    }
    items.set(key, it);
  }
  return items;
}

export function parseCategories(html, pageUrl, kind) {
  const cats = new Map();
  for (const a of anchors(html, pageUrl)) {
    const u = new URL(a.href);
    const m =
      kind === 'movie'
        ? u.pathname.match(/^\/iran-\d+-movies\/([^/]+)\/?$/i)
        : u.pathname.match(/^\/series\/category\/([^/]+)\/?$/i);
    if (!m) continue;
    const name = niceName(safeDecode(m[1].replace(/\+/g, ' ')));
    if (name && !cats.has(name)) cats.set(name, u.href);
  }
  return cats;
}

export function parseEpisodes(html, pageUrl) {
  const eps = new Map();
  const hint = pageUrl.match(/season[=/-]?(\d+)/i);
  for (const a of anchors(html, pageUrl)) {
    const u = new URL(a.href);
    const e = matchEpisode(u);
    if (!e) continue;
    const it = eps.get(e.ep) || { url: u.href, slug: e.ep, thumb: '', hintSeason: hint ? Number(hint[1]) : null };
    const img = firstImg(a.inner, pageUrl);
    if (img && !it.thumb) it.thumb = img;
    eps.set(e.ep, it);
  }
  return eps;
}

function seasonLinks(html, pageUrl, seriesSlug) {
  const out = new Set();
  const hrefs = [
    ...[...anchors(html, pageUrl)].map((a) => a.href),
    ...[...html.matchAll(/<option\b[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi)].map((m) => absUrl(m[1], pageUrl)),
  ];
  for (const h of hrefs) {
    if (!h || h === pageUrl || !/season/i.test(h)) continue;
    const u = new URL(h);
    if (safeDecode(u.pathname).toLowerCase().includes(seriesSlug.toLowerCase()) && !matchEpisode(u)) out.add(h);
  }
  return [...out];
}

export function parseEpisodePage(html, slug) {
  const t = textOf(html);
  const m = t.match(/Season\s+(\d+)\s*-\s*Episode\s+(\d+)/i);
  const trailing = slug.match(/(\d+)$/);
  return {
    stream: pickStream(html),
    season: m ? Number(m[1]) : null,
    episode: m ? Number(m[2]) : trailing ? Number(trailing[1]) : 1,
  };
}

// ---------- scraping ----------
async function crawlCategory(name, url, kind) {
  const all = new Map();
  for (let p = 1; p <= CFG.maxPages; p++) {
    const pageUrl = p === 1 ? url : CFG.pageUrl(url, p);
    let html;
    try {
      html = await get(pageUrl);
    } catch (e) {
      if (p === 1) throw e;
      break;
    }
    const items = parseListing(html, pageUrl, kind);
    let fresh = 0;
    for (const [k, v] of items) if (!all.has(k)) (all.set(k, v), fresh++);
    if (!fresh) break;
    await sleep(CFG.delayMs);
  }
  return all;
}

const loadCache = async () => {
  try {
    return JSON.parse(await readFile(CFG.cacheFile, 'utf8'));
  } catch {
    return { movies: {}, episodes: {} };
  }
};
const saveCache = async (c) => {
  await mkdir(path.dirname(CFG.cacheFile), { recursive: true });
  await writeFile(CFG.cacheFile, JSON.stringify(c));
};

async function gather(kind, homeUrl) {
  log(`\n[${kind}] home: ${homeUrl}`);
  const homeHtml = await get(homeUrl);
  const items = parseListing(homeHtml, homeUrl, kind); // home first = "newest" ordering
  const cats = parseCategories(homeHtml, homeUrl, kind);
  log(`  home items: ${items.size}, categories: ${cats.size}`);

  for (const [name, url] of cats) {
    const found = await crawlCategory(name, url, kind);
    let pages = found.size;
    for (const [k, v] of found) {
      const cur = items.get(k) || v;
      cur.cats = [...new Set([...(cur.cats || []), name])];
      if (!cur.thumb && v.thumb) cur.thumb = v.thumb;
      if (!cur.title && v.title) cur.title = v.title;
      items.set(k, cur);
    }
    log(`  ${name}: ${pages} items`);
    if (pages > 0 && pages <= 60) {
      // A single page worth of items is a hint that pagination was not detected.
      log(`    (<=60 items; if the category is bigger, see the pageUrl note in build.mjs)`);
    }
  }
  let list = [...items.values()];
  if (CFG.maxItems) list = list.slice(0, CFG.maxItems);
  return list;
}

async function resolveMovies(list, cache) {
  log(`\nResolving ${list.length} movie pages...`);
  const res = await pool(list, CFG.concurrency, async (it) => {
    const hit = cache.movies[it.url];
    if (hit?.stream) return { ...it, ...hit };
    const html = await get(it.url);
    const stream = pickStream(html);
    if (!stream) throw new Error(`no stream found: ${it.url}`);
    const data = {
      stream,
      title: pageTitle(html) || it.title,
      poster: metaImage(html) || it.thumb,
    };
    cache.movies[it.url] = data;
    return { ...it, ...data };
  });
  return res.filter(Boolean);
}

async function resolveSeries(list, cache) {
  log(`\nResolving ${list.length} series...`);
  const res = await pool(list, 2, async (it) => {
    const html = await get(it.url);
    let eps = parseEpisodes(html, it.url);
    for (const su of seasonLinks(html, it.url, it.key)) {
      try {
        for (const [k, v] of parseEpisodes(await get(su), su)) if (!eps.has(k)) eps.set(k, v);
      } catch {}
    }
    const resolved = await pool([...eps.values()], CFG.concurrency, async (e) => {
      const hit = cache.episodes[e.url];
      if (hit?.stream) return { ...e, ...hit };
      const data = parseEpisodePage(await get(e.url), e.slug);
      if (!data.stream) throw new Error(`no stream found: ${e.url}`);
      cache.episodes[e.url] = data;
      return { ...e, ...data };
    });
    const seen = new Set();
    const episodes = resolved
      .filter(Boolean)
      .map((e) => ({ ...e, season: e.season ?? e.hintSeason ?? 1 }))
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .filter((e) => {
        const k = `${e.season}:${e.episode}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
    if (!episodes.length) throw new Error(`no playable episodes: ${it.url}`);
    return { ...it, title: it.title || pageTitle(html), poster: metaImage(html) || it.thumb, episodes };
  });
  return res.filter(Boolean);
}

// ---------- output ----------
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';

function assignIds(list, prefix) {
  const used = new Set();
  for (const it of list) {
    let base = `${prefix}-${slugify(it.key)}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    it.id = id;
  }
}

const genresOf = (it) =>
  it.cats?.length ? it.cats : it.genre ? it.genre.split(/[,،|]/).map((s) => s.trim()).filter(Boolean) : [];

const streamObj = (url) => ({
  name: 'Namakade',
  title: 'Direct',
  url,
  ...(CFG.streamHints
    ? { behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: CFG.referer } } } }
    : {}),
});

export async function writeAddon(movies, series) {
  const out = CFG.outDir;
  await rm(out, { recursive: true, force: true });
  const put = async (rel, obj) => {
    const f = path.join(out, rel);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  };

  assignIds(movies, 'nk-m');
  assignIds(series, 'nk-s');

  const preview = (it, type) => ({
    id: it.id,
    type,
    name: it.title,
    poster: it.poster || it.thumb || undefined,
    genres: genresOf(it),
  });

  const catalogs = [];
  for (const [type, list, catId, label] of [
    ['movie', movies, 'namakade-movies', 'Namakade Movies'],
    ['series', series, 'namakade-series', 'Namakade Series'],
  ]) {
    if (!list.length) continue;
    const metas = list.map((it) => preview(it, type));
    const genreSet = [...new Set(list.flatMap(genresOf))].sort();
    await put(`catalog/${type}/${catId}.json`, { metas });
    for (const g of genreSet) {
      await put(`catalog/${type}/${catId}/genre=${g}.json`, {
        metas: list.filter((it) => genresOf(it).includes(g)).map((it) => preview(it, type)),
      });
    }
    catalogs.push({
      type,
      id: catId,
      name: label,
      extra: [{ name: 'genre', options: genreSet, isRequired: false }],
    });
  }

  for (const m of movies) {
    await put(`meta/movie/${m.id}.json`, {
      meta: {
        id: m.id,
        type: 'movie',
        name: m.title,
        poster: m.poster || m.thumb || undefined,
        background: m.poster || m.thumb || undefined,
        genres: genresOf(m),
        director: m.director ? [m.director] : undefined,
        description: m.director ? `Director: ${m.director}` : undefined,
      },
    });
    await put(`stream/movie/${m.id}.json`, { streams: [streamObj(m.stream)] });
  }

  for (const s of series) {
    const videos = s.episodes.map((e, i) => {
      e.vid = `${s.id}-s${e.season}e${e.episode}`;
      return {
        id: e.vid,
        title: `Episode ${e.episode}`,
        season: e.season,
        episode: e.episode,
        released: new Date(Date.UTC(2000, 0, 1 + i)).toISOString(), // ordering placeholder
        thumbnail: e.thumb || undefined,
      };
    });
    await put(`meta/series/${s.id}.json`, {
      meta: {
        id: s.id,
        type: 'series',
        name: s.title,
        poster: s.poster || s.thumb || undefined,
        background: s.poster || s.thumb || undefined,
        genres: genresOf(s),
        videos,
      },
    });
    for (const e of s.episodes) {
      const body = { streams: [streamObj(e.stream)] };
      await put(`stream/series/${e.vid}.json`, body);
      // Some clients request "<seriesId>:<season>:<episode>" instead of the video id.
      await put(`stream/series/${s.id}:${e.season}:${e.episode}.json`, body);
    }
  }

  const manifest = {
    id: CFG.addonId,
    version: CFG.version,
    name: CFG.addonName,
    description: 'Movies and TV series from Namakade (Negahestan), regenerated automatically.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['nk-'],
    catalogs,
    behaviorHints: { configurable: false },
  };
  await put('manifest.json', manifest);
  await put('.nojekyll', '');
  await put(
    'index.html',
    `<!doctype html><meta charset="utf-8"><title>Namakade addon</title><body style="font-family:sans-serif;max-width:40rem;margin:2rem auto"><h1>Namakade addon</h1><p>Add <code>manifest.json</code> from this site to Nuvio.</p><p><a href="manifest.json">manifest.json</a></p>`,
  );
  return manifest;
}

export async function main() {
  const cache = await loadCache();
  const [movieList, seriesList] = [
    await gather('movie', CFG.movieHome),
    await gather('series', CFG.seriesHome),
  ];
  const movies = await resolveMovies(movieList, cache);
  const series = await resolveSeries(seriesList, cache);
  await saveCache(cache);
  const manifest = await writeAddon(movies, series);
  log(
    `\nDone: ${movies.length}/${movieList.length} movies, ${series.length}/${seriesList.length} series -> ${CFG.outDir}/ (${manifest.catalogs.length} catalogs)`,
  );
  if (!movies.length && !series.length) {
    console.error('Nothing was scraped. The site may be blocking this network or its markup changed.');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
