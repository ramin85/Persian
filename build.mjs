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
  concurrency: Number(process.env.CONCURRENCY || 6),
  delayMs: Number(process.env.DELAY_MS || 100),
  // Stop fetching NEW pages after this many minutes, publish what we have, and
  // keep the cache so the next run continues where this one stopped.
  budgetMin: Number(process.env.BUDGET_MIN || 40),
  maxPages: Number(process.env.MAX_PAGES || 40), // per category
  maxItems: Number(process.env.MAX_ITEMS || 0), // 0 = unlimited (use a small number for test runs)
  streamHints: process.env.STREAM_HINTS !== '0', // adds notWebReady + Referer hint to streams
  referer: 'https://mobile.namakade.com/',
  tmdbKey: process.env.TMDB_API_KEY || '', // v3 API key or v4 read-access token
  tmdbConcurrency: Number(process.env.TMDB_CONCURRENCY || 4),
  imdbIds: process.env.ALSO_SERVE_IMDB_IDS === '1', // also serve streams under IMDb ids (tt...)
  overridesFile: process.env.OVERRIDES_FILE || 'overrides.json',
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
let deadline = Infinity; // set in main()
const log = (...a) => console.log(...a);

// ---------- HTTP ----------
async function get(url, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000), // never hang on a stalled connection
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

async function pool(items, n, fn, label = '') {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
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
        if (label && ++done % 100 === 0) log(`  ${label}: ${done}/${items.length}`);
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
  let homeHtml;
  try {
    homeHtml = await get(homeUrl);
  } catch (e) {
    throw new Error(
      `${e.message}\n  Namakade did not answer. On GitHub Actions this usually means the site blocks GitHub's servers (see README, "Blocked runner").`,
    );
  }
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
    if (Date.now() > deadline) return null; // out of time: the next run continues from the cache
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
  }, 'movies');
  return res.filter(Boolean);
}

async function resolveSeries(list, cache) {
  log(`\nResolving ${list.length} series...`);
  const res = await pool(list, 2, async (it) => {
    if (Date.now() > deadline && !cache.seriesSeen?.[it.url]) return null;
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
      if (Date.now() > deadline) return null;
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
    if (!episodes.length) {
      if (Date.now() > deadline) return null;
      throw new Error(`no playable episodes: ${it.url}`);
    }
    cache.seriesSeen = cache.seriesSeen || {};
    cache.seriesSeen[it.url] = 1;
    return { ...it, title: it.title || pageTitle(html), poster: metaImage(html) || it.thumb, episodes };
  }, 'series');
  return res.filter(Boolean);
}

// ---------- TMDB matching ----------
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const DAY = 864e5;
const CACHE_V = 1;

async function tmdb(pathname, params = {}, attempt = 0) {
  const u = new URL(TMDB_API + pathname);
  const headers = { accept: 'application/json' };
  if (CFG.tmdbKey.startsWith('eyJ')) headers.authorization = `Bearer ${CFG.tmdbKey}`;
  else u.searchParams.set('api_key', CFG.tmdbKey);
  u.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const r = await fetch(u.href, { headers, signal: AbortSignal.timeout(25000) });
  if (r.status === 404) return null;
  if (r.status === 429 && attempt < 4) {
    await sleep(1500 * (attempt + 1));
    return tmdb(pathname, params, attempt + 1);
  }
  if (!r.ok) {
    const e = new Error(`TMDB ${r.status} ${pathname}`); // never log the URL: it may contain the key
    e.status = r.status;
    throw e;
  }
  return r.json();
}

const normT = (s) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()
    .replace(/^the /, '');
const tokenSet = (s) => new Set(normT(s).split(' ').filter(Boolean));

export function similarity(a, b) {
  const na = normT(a);
  const nb = normT(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokenSet(a);
  const B = tokenSet(b);
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size);
}

const fileBase = (u) => {
  try {
    return safeDecode(new URL(u).pathname.split('/').pop()).replace(/\.[a-z0-9]{2,4}$/i, '');
  } catch {
    return '';
  }
};

// Namakade's own titles are Persian transliterations, but image/video file names
// often hold the real English title (and year), e.g. "Total.Recall.1990_thumb.jpg".
export function titleCandidates(it) {
  const out = [];
  const add = (q, year = null) => {
    q = q.replace(/\s+/g, ' ').trim();
    if (q.length > 1 && !out.some((o) => o.q.toLowerCase() === q.toLowerCase() && o.year === year)) {
      out.push({ q, year });
    }
  };
  for (const f of [it.poster, it.thumb, it.stream, it.episodes?.[0]?.stream]) {
    if (!f) continue;
    let b = fileBase(f)
      .replace(/_(?:big|small)?thumb$/i, '')
      .replace(/_E\d+$/i, '');
    let year = null;
    const ym = b.match(/^(.+?)[._\s-]*((?:19|20)\d{2})$/);
    if (ym) {
      b = ym[1];
      year = Number(ym[2]);
    }
    if (!/[._\s-]/.test(b)) b = b.replace(/([a-z])([A-Z])/g, '$1 $2');
    add(b.replace(/[._]+/g, ' '), year);
  }
  add(it.title || '');
  return out;
}

async function searchTmdb(kind, cand) {
  const type = kind === 'movie' ? 'movie' : 'tv';
  const base = { query: cand.q, include_adult: 'false' };
  const yp = cand.year ? (kind === 'movie' ? { year: cand.year } : { first_air_date_year: cand.year }) : {};
  let results = (await tmdb(`/search/${type}`, { ...base, ...yp }))?.results || [];
  if (!results.length && cand.year) results = (await tmdb(`/search/${type}`, base))?.results || [];
  return results
    .slice(0, 6)
    .map((r) => {
      const names = [r.title, r.original_title, r.name, r.original_name].filter(Boolean);
      const y = Number((r.release_date || r.first_air_date || '').slice(0, 4)) || null;
      const yearOk = cand.year && y ? Math.abs(y - cand.year) <= 1 : null;
      let score = Math.max(0, ...names.map((n) => similarity(cand.q, n)));
      if (yearOk === false) score -= 0.4;
      return { r, score, yearOk, pop: r.popularity || 0 };
    })
    .sort((a, b) => b.score - a.score || b.pop - a.pop);
}

async function directorMatches(id, directorStr) {
  const credits = await tmdb(`/movie/${id}/credits`);
  const dirs = (credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name);
  const wanted = directorStr.split(/\s*(?:,|&|\.|\band\b|،|\bو\b)\s*/i).filter(Boolean);
  return wanted.some((w) => dirs.some((d) => similarity(w, d) >= 0.8));
}

// Conservative on purpose: a wrong match is worse than no match.
//  A) title ~ match AND release year agrees (year comes from the file name)
//  B) movies: title is a loose match AND the listed director is a TMDB director
//  C) very distinctive long title (3+ words) with a near-exact match
export async function matchTitle(kind, it) {
  for (const cand of titleCandidates(it)) {
    const scored = await searchTmdb(kind, cand);
    const top = scored[0];
    if (!top) continue;
    const hit = (s, how) => ({ id: s.r.id, score: Math.round(s.score * 100) / 100, how });
    if (top.yearOk === true && top.score >= 0.85) return hit(top, 'title+year');
    if (kind === 'movie' && it.director) {
      for (const s of scored.filter((x) => x.score >= 0.5).slice(0, 3)) {
        if (await directorMatches(s.r.id, it.director)) return hit(s, 'title+director');
      }
    }
    if (top.score >= 0.95 && tokenSet(cand.q).size >= 3 && top.yearOk !== false) return hit(top, 'title');
  }
  return null;
}

async function fetchDetails(kind, id) {
  const d = await tmdb(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}`, { append_to_response: 'credits,external_ids' });
  if (!d) return null;
  const year = Number((d.release_date || d.first_air_date || '').slice(0, 4)) || null;
  const mins = kind === 'movie' ? d.runtime : d.episode_run_time?.[0];
  return {
    tmdbId: d.id,
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    title: d.title || d.name,
    overview: d.overview || '',
    year,
    poster: d.poster_path ? `${TMDB_IMG}/w500${d.poster_path}` : '',
    background: d.backdrop_path ? `${TMDB_IMG}/w1280${d.backdrop_path}` : '',
    genres: (d.genres || []).map((g) => g.name),
    runtime: mins ? `${mins} min` : '',
    cast: (d.credits?.cast || []).slice(0, 8).map((c) => c.name),
    director: kind === 'movie' ? (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name) : [],
  };
}

async function fetchSeason(tvId, n) {
  const s = await tmdb(`/tv/${tvId}/season/${n}`);
  const out = {};
  for (const e of s?.episodes || []) {
    out[e.episode_number] = {
      title: e.name || '',
      overview: e.overview || '',
      thumb: e.still_path ? `${TMDB_IMG}/w300${e.still_path}` : '',
      released: e.air_date ? new Date(`${e.air_date}T00:00:00Z`).toISOString() : '',
    };
  }
  return out;
}

async function loadOverrides() {
  try {
    return JSON.parse(await readFile(CFG.overridesFile, 'utf8'));
  } catch {
    return {};
  }
}

async function resolveTmdb(kind, it, ov, hasOv, ovs, prev) {
  const stamp = { v: CACHE_V, t: Date.now(), ov: ovs };
  let match;
  if (hasOv && (ov === null || ov === false)) match = null; // explicitly disabled
  else if (hasOv && Number.isInteger(ov)) match = { id: ov, score: 1, how: 'override' };
  else match = prev?.match && prev.match.how !== 'override' ? prev.match : await matchTitle(kind, it);
  if (!match) return { ...stamp, match: null };
  const details = await fetchDetails(kind, match.id);
  if (!details) return { ...stamp, match: null };
  let eps;
  if (kind === 'series') {
    eps = {};
    for (const n of new Set(it.episodes.map((e) => e.season))) eps[n] = await fetchSeason(match.id, n);
  }
  return { ...stamp, match, details, eps };
}

export async function enrich(movies, series, cache) {
  const report = { matched: [], unmatched: [] };
  if (!CFG.tmdbKey) {
    log('\nTMDB_API_KEY not set: skipping TMDB matching.');
    return report;
  }
  log('\nMatching titles to TMDB...');
  const overrides = await loadOverrides();
  cache.tmdb ||= {};
  let disabled = false;

  const run = (kind, list) =>
    pool(list, CFG.tmdbConcurrency, async (it) => {
      if (disabled) return;
      const ck = `${kind}:${it.key}`;
      const hasOv = ck in overrides;
      const ov = hasOv ? overrides[ck] : undefined;
      const ovs = hasOv ? JSON.stringify(ov) : '';
      let entry = cache.tmdb[ck];
      const ttl = (entry?.match ? (kind === 'movie' ? 30 : 2) : 7) * DAY;
      const newSeason = kind === 'series' && entry?.match && it.episodes.some((e) => !(e.season in (entry.eps || {})));
      if (!entry || entry.v !== CACHE_V || entry.ov !== ovs || Date.now() - entry.t > ttl || newSeason) {
        try {
          entry = await resolveTmdb(kind, it, ov, hasOv, ovs, entry);
        } catch (e) {
          if (e.status === 401) disabled = true;
          throw e;
        }
        cache.tmdb[ck] = entry;
      }
      if (entry.match) {
        it.tmdb = entry.details;
        it.tmdbEps = entry.eps;
        report.matched.push({
          key: ck,
          title: it.title,
          tmdbId: entry.details.tmdbId,
          tmdbTitle: entry.details.title,
          year: entry.details.year,
          how: entry.match.how,
          score: entry.match.score,
        });
      } else report.unmatched.push({ key: ck, title: it.title });
    });

  await run('movie', movies);
  await run('series', series);
  log(
    `  matched ${report.matched.length}, unmatched ${report.unmatched.length}` +
      (disabled ? ' (TMDB key was rejected: check TMDB_API_KEY)' : ''),
  );
  if (report.unmatched.length) {
    log('  unmatched: ' + report.unmatched.slice(0, 25).map((u) => u.title).join(', ') + (report.unmatched.length > 25 ? ', ...' : ''));
  }
  return report;
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

export async function writeAddon(movies, series, report = { matched: [], unmatched: [] }) {
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
    name: it.tmdb?.title || it.title,
    poster: it.tmdb?.poster || it.poster || it.thumb || undefined,
    genres: it.tmdb?.genres?.length ? it.tmdb.genres : genresOf(it),
  });

  // Optional: also serve streams under IMDb ids so they show up on regular titles.
  const imdbStreams = new Map();
  const addImdb = (key, stream) => {
    if (!CFG.imdbIds || !key) return;
    const arr = imdbStreams.get(key) || [];
    if (!arr.some((s) => s.url === stream.url)) arr.push(stream);
    imdbStreams.set(key, arr);
  };

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
    const t = m.tmdb;
    const poster = t?.poster || m.poster || m.thumb || undefined;
    await put(`meta/movie/${m.id}.json`, {
      meta: {
        id: m.id,
        type: 'movie',
        name: t?.title || m.title,
        poster,
        background: t?.background || poster,
        genres: t?.genres?.length ? t.genres : genresOf(m),
        director: t?.director?.length ? t.director : m.director ? [m.director] : undefined,
        cast: t?.cast?.length ? t.cast : undefined,
        description: t?.overview || (m.director ? `Director: ${m.director}` : undefined),
        releaseInfo: t?.year ? String(t.year) : undefined,
        year: t?.year ? String(t.year) : undefined,
        runtime: t?.runtime || undefined,
        imdb_id: t?.imdbId || undefined,
        moviedb_id: t?.tmdbId || undefined,
      },
    });
    const ms = streamObj(m.stream);
    await put(`stream/movie/${m.id}.json`, { streams: [ms] });
    addImdb(t?.imdbId ? `movie/${t.imdbId}` : null, ms);
  }

  for (const s of series) {
    const t = s.tmdb;
    const videos = s.episodes.map((e, i) => {
      e.vid = `${s.id}-s${e.season}e${e.episode}`;
      const x = s.tmdbEps?.[e.season]?.[e.episode];
      e.tmdbHit = !!x;
      return {
        id: e.vid,
        title: x?.title || `Episode ${e.episode}`,
        overview: x?.overview || undefined,
        season: e.season,
        episode: e.episode,
        released: x?.released || new Date(Date.UTC(2000, 0, 1 + i)).toISOString(), // placeholder keeps order
        thumbnail: x?.thumb || e.thumb || undefined,
      };
    });
    const poster = t?.poster || s.poster || s.thumb || undefined;
    await put(`meta/series/${s.id}.json`, {
      meta: {
        id: s.id,
        type: 'series',
        name: t?.title || s.title,
        poster,
        background: t?.background || poster,
        genres: t?.genres?.length ? t.genres : genresOf(s),
        cast: t?.cast?.length ? t.cast : undefined,
        description: t?.overview || undefined,
        releaseInfo: t?.year ? String(t.year) : undefined,
        year: t?.year ? String(t.year) : undefined,
        runtime: t?.runtime || undefined,
        imdb_id: t?.imdbId || undefined,
        moviedb_id: t?.tmdbId || undefined,
        videos,
      },
    });
    for (const e of s.episodes) {
      const stream = streamObj(e.stream);
      const body = { streams: [stream] };
      await put(`stream/series/${e.vid}.json`, body);
      // Some clients request "<seriesId>:<season>:<episode>" instead of the video id.
      await put(`stream/series/${s.id}:${e.season}:${e.episode}.json`, body);
      // IMDb-id streams only where TMDB confirms that season/episode exists.
      if (e.tmdbHit) addImdb(t?.imdbId ? `series/${t.imdbId}:${e.season}:${e.episode}` : null, stream);
    }
  }

  for (const [key, streams] of imdbStreams) await put(`stream/${key}.json`, { streams });

  const manifest = {
    id: CFG.addonId,
    version: CFG.version,
    name: CFG.addonName,
    description:
      'Movies and TV series from Namakade (Negahestan), regenerated automatically.' +
      (CFG.tmdbKey ? ' This product uses the TMDB API but is not endorsed or certified by TMDB.' : ''),
    resources: CFG.imdbIds
      ? ['catalog', 'meta', { name: 'stream', types: ['movie', 'series'], idPrefixes: ['nk-', 'tt'] }]
      : ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['nk-'],
    catalogs,
    behaviorHints: { configurable: false },
  };
  await put('manifest.json', manifest);
  await put('.nojekyll', '');
  await put(
    'index.html',
    `<!doctype html><meta charset="utf-8"><title>Namakade addon</title><body style="font-family:sans-serif;max-width:40rem;margin:2rem auto"><h1>Namakade addon</h1><p>Add <code>manifest.json</code> from this site to Nuvio.</p><p><a href="manifest.json">manifest.json</a></p>${
      CFG.tmdbKey ? '<p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>' : ''
    }`,
  );
  await put('match-report.json', report);
  return manifest;
}

export async function main() {
  deadline = Date.now() + CFG.budgetMin * 60000;
  const cache = await loadCache();
  const [movieList, seriesList] = [
    await gather('movie', CFG.movieHome),
    await gather('series', CFG.seriesHome),
  ];
  const movies = await resolveMovies(movieList, cache);
  const series = await resolveSeries(seriesList, cache);
  await saveCache(cache); // save progress before the slower TMDB step
  if (Date.now() > deadline) {
    log(`\nTime budget (${CFG.budgetMin} min) reached: published what was ready. The next run continues from the cache.`);
  }
  const report = await enrich(movies, series, cache);
  await saveCache(cache);
  const manifest = await writeAddon(movies, series, report);
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
