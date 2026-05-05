const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── CSV: parse at startup into bucket groups ──────────────────────────────
function parseCSVLine(line) {
    const row = [];
    let inQuote = false, field = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQuote = !inQuote; }
        else if (c === ',' && !inQuote) { row.push(field); field = ''; }
        else { field += c; }
    }
    row.push(field);
    return row;
}

const BUCKET_KEYWORDS = [
    ['afrotech_amapiano', ['south african', 'amapiano', 'afro-club', 'afro tech / amapiano']],
    ['uk_garage',         ['uk garage', 'bassline', 'uk / garage', 'uk house / garage']],
    ['latin',             ['latin', 'brazilian', 'iberian', 'tribal / brazilian']],
    ['chicago_acid',      ['chicago', 'acid', 'jackin', 'ghetto house']],
    ['afro',              ['afro / organic', 'organic / global']],
    ['disco',             ['disco', 'nu-disco', 'balearic', 'french touch']],
    ['melodic',           ['melodic', 'progressive']],
    ['tech_house',        ['tech house', 'minimal', 'deep tech', 'rominimal']],
    ['deep_soulful',      ['deep / soulful', 'classic / deep', 'gospel', 'detroit']],
    ['lo_fi',             ['lo-fi', 'leftfield', 'outsider', 'experimental']],
    ['chart_leaders',     ['current chart', 'user-callout', 'must include', 'user-priority']],
];

function normalizeBucket(rawBucket) {
    const b = rawBucket.toLowerCase();
    for (const [key, keywords] of BUCKET_KEYWORDS) {
        if (keywords.some(kw => b.includes(kw))) return key;
    }
    return null;
}

function subgenresToBucketKey(subgenres = []) {
    const s = subgenres.join(' ').toLowerCase();
    if (/amapiano|south african|gqom|afro.?tech/.test(s)) return 'afrotech_amapiano';
    if (/uk garage|bassline|uk house/.test(s))             return 'uk_garage';
    if (/latin|brazilian|iberian/.test(s))                 return 'latin';
    if (/chicago|acid house|jackin|ghetto/.test(s))        return 'chicago_acid';
    if (/afro house|afro melodic|tribal|organic house/.test(s)) return 'afro';
    if (/disco|nu.?disco|balearic|french house/.test(s))   return 'disco';
    if (/melodic|progressive|organic/.test(s))             return 'melodic';
    if (/tech house|minimal|deep tech|rominimal/.test(s))  return 'tech_house';
    if (/deep house|soulful|vocal house|gospel|detroit/.test(s)) return 'deep_soulful';
    if (/lo.?fi|leftfield|outsider/.test(s))               return 'lo_fi';
    return 'chart_leaders';
}

const artistsByBucket = {};

try {
    const csvText = fs.readFileSync(
        path.join(__dirname, 'context', 'house_artist_roster_v3_merged_longtail.csv'),
        'latin1'
    );
    const lines = csvText.split('\n');
    const headers = parseCSVLine(lines[0]);
    const nameIdx     = headers.indexOf('artist_name');
    const bucketIdx   = headers.indexOf('primary_bucket');
    const priorityIdx = headers.indexOf('seed_priority');

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        const name     = row[nameIdx]?.trim();
        const bucket   = row[bucketIdx]?.trim();
        const priority = parseInt(row[priorityIdx] || '5', 10);
        if (!name || !bucket || priority > 2) continue;
        const key = normalizeBucket(bucket);
        if (!key) continue;
        if (!artistsByBucket[key]) artistsByBucket[key] = [];
        artistsByBucket[key].push(name);
    }

    const summary = Object.entries(artistsByBucket).map(([k, v]) => `${k}:${v.length}`).join(', ');
    console.log('[startup] CSV loaded —', summary);
} catch (err) {
    console.error('[startup] CSV load failed:', err.message);
}

const artistTextByBucket = {};
for (const [key, artists] of Object.entries(artistsByBucket)) {
    artistTextByBucket[key] = artists.slice(0, 80).join(', ');
}

// Agent 11: pure JS CSV matcher — zero tokens
function getNicheArtists(subgenres) {
    const bucketKey = subgenresToBucketKey(subgenres || []);
    return (artistsByBucket[bucketKey] || []).slice(0, 30);
}

// ── Resilience constants ──────────────────────────────────────────────────
const MIN_CANDIDATES     = 15;
const TARGET_CANDIDATES  = 50;
const PIPELINE_BUDGET_MS = 45000;
const STEP_DEADLINES     = { preference: 3000, lastfmTags: 3000, deterministicScore: 100, llmEnrich: 20000 };

// Refinement 5: 1-hour in-memory LRU cache for Last.fm responses
const lfmCache = new Map();
const CACHE_TTL = 3600000;
async function cachedFetch(key, fetchFn) {
    const hit = lfmCache.get(key);
    if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;
    const data = await fetchFn();
    lfmCache.set(key, { data, time: Date.now() });
    return data;
}

// Refinement 9: Retry with exponential backoff + jitter
async function retryWithJitter(fn, maxAttempts = 2) {
    for (let i = 0; i < maxAttempts; i++) {
        try { return await fn(); }
        catch (err) {
            if (i === maxAttempts - 1) throw err;
            const d = (Math.pow(2, i) * 500) + Math.random() * 500;
            await new Promise(r => setTimeout(r, d));
        }
    }
}

// Refinement 7: Structured step logging
function logStep(step, data) {
    console.log(JSON.stringify({
        step,
        timestamp:        Date.now(),
        duration_ms:      data.duration,
        success:          data.success,
        candidates_count: data.candidates,
        fallback_used:    data.fallback || false,
        error:            data.error || null,
    }));
}

// Refinement 1: Deterministic scorer — zero external dependencies, always returns results
function scoreCandidatesDeterministic(candidates, vibeDNA, preferences, freeTextKeywords) {
    return candidates.map(c => {
        let score = 0;
        if (vibeDNA.dominant_subgenres?.includes(c.subgenre)) score += 40;
        if (vibeDNA.dimensions?.find(d => d.detail?.toLowerCase().includes(c.subgenre?.toLowerCase()))) score += 10;
        if (preferences.groove_want  && c.tags?.some(t => t.includes(preferences.groove_want)))  score += 10;
        if (preferences.texture_want && c.tags?.some(t => t.includes(preferences.texture_want))) score += 10;
        if (preferences.harmony_want && c.tags?.some(t => t.includes(preferences.harmony_want))) score += 10;
        if (freeTextKeywords?.length) {
            freeTextKeywords.forEach(k => {
                if (c.title?.toLowerCase().includes(k.toLowerCase()))             score += 5;
                if (c.tags?.some(t => t.toLowerCase().includes(k.toLowerCase()))) score += 5;
            });
        }
        if (c.source === 'csv_niche')      score += 8;
        if (c.source === 'lastfm_similar') score += 5;
        // Multi-source bonus: cross-source validation boosts confidence
        if (c.also_in?.length) score += c.also_in.length * 5;
        return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// Refinement 2: Template "why" generator for deterministic fallback path
function generateTemplateWhy(track, vibeDNA) {
    const sub     = vibeDNA.dominant_subgenres?.[0] || 'house';
    const dimName = vibeDNA.dimensions?.[0]?.name   || 'Tempo DNA';
    return `Matches your ${sub} preference with ${track.subgenre || 'house'} energy. Strong fit on ${dimName}.`;
}

function formatDeterministicRec(c, vibe) {
    const q = encodeURIComponent(`${c.artist} ${c.title || ''}`).replace(/%20/g, '+');
    return {
        title:       c.title  || c.artist,
        artist:      c.artist,
        subgenre:    c.subgenre || vibe.dominant_subgenres?.[0] || 'house',
        scene:       `${c.subgenre || 'House'} scene`,
        instruments: ['drums', 'bass', 'synth'],
        why:         generateTemplateWhy(c, vibe),
        youtube_url: `https://music.youtube.com/search?q=${q}`,
        spotify_url: `https://open.spotify.com/search/${encodeURIComponent(`${c.artist} ${c.title || ''}`)}/tracks`,
        lastfm_url:  `https://www.last.fm/music/${encodeURIComponent(c.artist)}/_/${encodeURIComponent(c.title || '')}`,
        weightMatch: 'deterministic vibe match',
    };
}

// Refinement 6: Source diversity caps — max 4 per source fed into scorer
function diversifyCandidates(candidates) {
    const bySource = { lastfm_tags: [], lastfm_similar: [], musicbrainz: [], discogs: [], csv_niche: [] };
    candidates.forEach(c => { if (bySource[c.source]) bySource[c.source].push(c); });
    return [
        ...bySource.lastfm_tags.slice(0, 4),
        ...bySource.lastfm_similar.slice(0, 4),
        ...bySource.musicbrainz.slice(0, 4),
        ...bySource.discogs.slice(0, 4),
        ...bySource.csv_niche.slice(0, 4),
    ];
}

// Deduplication — normalize artist+title key, merge multi-source appearances
function dedupeCandidates(candidates) {
    const seen = new Map();
    candidates.forEach(c => {
        const key = `${c.artist.toLowerCase().trim()}|${c.title.toLowerCase().trim()}`;
        if (!seen.has(key)) {
            seen.set(key, { ...c });
        } else {
            const existing = seen.get(key);
            if (!existing.also_in) existing.also_in = [];
            existing.also_in.push(c.source);
        }
    });
    return Array.from(seen.values());
}

// Candidate type validation — rejects artist-only and placeholder entries
function isValidTrackCandidate(c) {
    if (!c || typeof c !== 'object') return false;
    if (!c.artist || typeof c.artist !== 'string' || !c.artist.trim()) return false;
    if (!c.title  || typeof c.title  !== 'string' || !c.title.trim())  return false;
    if (c.title.trim().toLowerCase() === c.artist.trim().toLowerCase()) return false;
    const placeholders = ['unknown', 'untitled', 'n/a', 'null', 'undefined', 'tba', 'various'];
    if (placeholders.includes(c.title.trim().toLowerCase())) return false;
    if (c.title.trim().length < 2) return false;
    return true;
}

// Split raw candidates into validated tracks and artist-only hints
function sortCandidates(rawCandidates) {
    const trackCandidates = [];
    const artistHints     = [];
    rawCandidates.forEach(c => {
        if (isValidTrackCandidate(c)) {
            trackCandidates.push(c);
        } else if (c.artist && typeof c.artist === 'string' && c.artist.trim()) {
            artistHints.push({ artist: c.artist.trim(), source: c.source, subgenre: c.subgenre });
        }
        // else: silently drop garbage
    });
    return { trackCandidates, artistHints };
}

// Enrich artist hints into real track candidates via Last.fm artist.getTopTracks
async function enrichArtistHints(artistHints, deadline = 4000) {
    const startTime = Date.now();
    const enriched  = [];
    for (const hint of artistHints.slice(0, 12)) {
        if (Date.now() - startTime > deadline) break;
        try {
            const url  = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks&artist=${encodeURIComponent(hint.artist)}&limit=2&api_key=${process.env.LASTFM_API_KEY}&format=json`;
            const json = await Promise.race([
                fetch(url).then(r => r.json()),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
            ]);
            const tracks = json?.toptracks?.track || [];
            if (tracks.length > 0) {
                enriched.push({
                    artist:   hint.artist,
                    title:    tracks[0].name,
                    subgenre: hint.subgenre,
                    source:   hint.source,
                    tags:     [],
                    metadata: { listeners: parseInt(tracks[0].listeners, 10) || 0 },
                });
            }
        } catch { /* timeout or API error — drop this hint, continue */ }
    }
    console.log(JSON.stringify({
        step:                  'artist_enrichment',
        hints_received:        artistHints.length,
        successfully_enriched: enriched.length,
        duration_ms:           Date.now() - startTime,
    }));
    return enriched;
}

// Final output validator — filters incomplete/malformed recs before sending to browser
function validateFinalRecommendations(recs) {
    if (!Array.isArray(recs)) return [];
    const valid = recs.filter(r => {
        if (!isValidTrackCandidate(r))                         return false;
        if (!r.youtube_url || !r.spotify_url || !r.lastfm_url) return false;
        if (!r.why || r.why.length < 20)                       return false;
        return true;
    });
    if (valid.length < recs.length) {
        console.log(`[validateFinal] dropped ${recs.length - valid.length} invalid recs — ${valid.length} remain`);
    }
    return valid;
}

// Parallel discovery orchestration — all sources run simultaneously
async function runDiscovery(subgenres, lfmSimilar) {
    const subgenreList = (subgenres || []).slice(0, 3).filter(Boolean);
    const subTag0 = subgenreList[0] || 'house';

    // Last.fm similar artists — instant, no API call needed
    const similarArtistNames = [...new Set((lfmSimilar || []).flatMap(x => x.similar || []))];
    const similarCandidates  = similarArtistNames.map(a => ({
        artist: a, title: '', subgenre: subTag0, source: 'lastfm_similar', tags: [], metadata: {},
    }));

    // CSV niche — pure JS, instant
    const nicheCandidates = getNicheArtists(subgenres).map(a => ({
        artist: a, title: '', subgenre: subTag0, source: 'csv_niche', tags: [], metadata: {},
    }));

    const results = await Promise.allSettled([
        // [0] Last.fm tag tracks
        withTimeout(
            (async () => {
                const chunks = await Promise.all(
                    subgenreList.slice(0, 2).map(tag =>
                        Promise.race([
                            cachedFetch(`tag:${tag}`, () => retryWithJitter(() => fetchLastFmTagTracks(tag))),
                            new Promise(resolve => setTimeout(() => resolve([]), STEP_DEADLINES.lastfmTags)),
                        ])
                    )
                );
                return chunks.flat();
            })(),
            3000
        ),
        // [1] Last.fm similar (pre-computed, instant)
        Promise.resolve(similarCandidates),
        // [2] MusicBrainz
        withTimeout(searchMusicBrainz(subgenreList), 3500),
        // [3] Discogs
        withTimeout(searchDiscogs(subgenreList), 3000),
        // [4] CSV niche (instant)
        Promise.resolve(nicheCandidates),
    ]);

    const rawCandidates = [];
    const sourceCounts  = { lastfm_tags: 0, lastfm_similar: 0, musicbrainz: 0, discogs: 0, csv_niche: 0 };
    const sourceNames   = ['lastfm_tags', 'lastfm_similar', 'musicbrainz', 'discogs', 'csv_niche'];

    results.forEach((r, i) => {
        const name = sourceNames[i];
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            rawCandidates.push(...r.value);
            sourceCounts[name] = r.value.length;
        } else if (r.status === 'rejected') {
            console.log(`[discovery] ${name} failed:`, r.reason?.message || r.reason);
        }
    });

    // Split into valid tracks and artist-only hints
    const { trackCandidates, artistHints } = sortCandidates(rawCandidates);
    console.log(JSON.stringify({
        step:          'discovery_complete',
        source_counts: sourceCounts,
        raw_total:     rawCandidates.length,
        valid_tracks:  trackCandidates.length,
        artist_hints:  artistHints.length,
    }));

    // Enrich artist hints into real track candidates (4s budget, up to 12)
    const enrichedTracks = await enrichArtistHints(artistHints);
    const candidates = [...trackCandidates, ...enrichedTracks];
    console.log(`[discovery] final pool: ${candidates.length} (${trackCandidates.length} direct + ${enrichedTracks.length} enriched)`);

    return { candidates, sourceCounts };
}

// Discovery 1: Last.fm tag top tracks — no Anthropic call, ~500ms per tag
async function fetchLastFmTagTracks(tag) {
    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&limit=20&api_key=${process.env.LASTFM_API_KEY}&format=json`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.tracks?.track || [])
            .map(t => ({
                artist:   t.artist?.name || '',
                title:    t.name || '',
                subgenre: tag,
                source:   'lastfm_tags',
                tags:     [],
                metadata: {},
            }))
            .filter(t => t.artist && t.title);
    } catch { return []; }
}

// Discovery: MusicBrainz recording search — 1 req/sec IP limit, staggered
async function searchMusicBrainz(subgenres) {
    const userAgent = `HouseMusicResonanceEngine/1.0 (${process.env.USER_AGENT_CONTACT || 'yash.skj@gmail.com'})`;
    const results = [];
    const tags = (subgenres || []).slice(0, 3).filter(Boolean);
    for (let i = 0; i < tags.length; i++) {
        if (i > 0) await delay(1100);
        const tag = tags[i];
        try {
            const tracks = await withTimeout(
                cachedFetch(`mb:${tag}`, async () => {
                    const url = `https://musicbrainz.org/ws/2/recording?query=tag:%22${encodeURIComponent(tag)}%22&limit=15&fmt=json`;
                    const r = await fetch(url, { headers: { 'User-Agent': userAgent } });
                    if (r.status === 503 || !r.ok) return [];
                    const json = await r.json();
                    return (json.recordings || []).map(rec => ({
                        artist:   rec['artist-credit']?.[0]?.artist?.name || '',
                        title:    rec.title || '',
                        subgenre: tag,
                        source:   'musicbrainz',
                        tags:     (rec.tags || []).map(t => t.name),
                        metadata: { mbid: rec.id },
                    })).filter(c => c.artist && c.title);
                }),
                2500
            );
            results.push(...tracks);
        } catch { /* silently skip — timeout or error */ }
    }
    return results.slice(0, 30);
}

// Discovery: Discogs database search — optional, requires DISCOGS_TOKEN env var
let discogsBlockedUntil = 0;

async function searchDiscogs(subgenres) {
    if (!process.env.DISCOGS_TOKEN) return [];
    if (Date.now() < discogsBlockedUntil) return [];
    const userAgent = `HouseMusicResonanceEngine/1.0 +${process.env.USER_AGENT_CONTACT || 'yash.skj@gmail.com'}`;
    const results = [];
    const tags = (subgenres || []).slice(0, 3).filter(Boolean);
    for (const tag of tags) {
        if (Date.now() < discogsBlockedUntil) break;
        try {
            const tracks = await withTimeout(
                cachedFetch(`discogs:${tag}`, async () => {
                    const url = `https://api.discogs.com/database/search?genre=Electronic&style=${encodeURIComponent(tag)}&type=release&per_page=15&token=${process.env.DISCOGS_TOKEN}`;
                    const r = await fetch(url, { headers: { 'User-Agent': userAgent } });
                    if (r.status === 429) { discogsBlockedUntil = Date.now() + 60000; return []; }
                    if (!r.ok) return [];
                    const remaining = parseInt(r.headers.get('X-Discogs-Ratelimit-Remaining') || '100', 10);
                    if (remaining < 5) discogsBlockedUntil = Date.now() + 60000;
                    const json = await r.json();
                    return (json.results || []).flatMap(rel => {
                        const parts = (rel.title || '').split(' - ');
                        const artist = parts.length >= 2 ? parts[0].trim() : rel.title;
                        const title  = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : '';
                        if (!artist) return [];
                        return [{
                            artist, title, subgenre: tag, source: 'discogs',
                            tags:     rel.style || [],
                            metadata: { label: rel.label?.[0] || '', year: parseInt(rel.year, 10) || undefined, country: rel.country || '' },
                        }];
                    }).filter(c => c.artist);
                }),
                2000
            );
            results.push(...tracks);
        } catch { /* silently skip */ }
    }
    return results.slice(0, 30);
}

function unwrapArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
        const arr = Object.values(v).find(x => Array.isArray(x));
        if (arr) return arr;
    }
    return [];
}

// ── JSON repair & schema validation ──────────────────────────────────────
function repairJSON(text) {
    let s = text.trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const fb = s.indexOf('{') === -1 ? Infinity : s.indexOf('{');
    const fk = s.indexOf('[') === -1 ? Infinity : s.indexOf('[');
    const first = Math.min(fb, fk);
    if (first !== Infinity) s = s.substring(first);
    const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (last !== -1) s = s.substring(0, last + 1);
    s = s.replace(/,(\s*[}\]])/g, '$1');
    s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    return s;
}

function validateVibeSchema(obj) {
    const required = ['vibeName', 'vibeDNA', 'dimensions', 'dominant_subgenres', 'instrument_profile', 'clubScene'];
    const missing = required.filter(k => !obj[k]);
    if (missing.length) return { valid: false, error: `Missing fields: ${missing.join(', ')}` };
    if (!Array.isArray(obj.dimensions) || obj.dimensions.length < 5)
        return { valid: false, error: 'dimensions must be array of 5+' };
    if (!Array.isArray(obj.dominant_subgenres) || !obj.dominant_subgenres.length)
        return { valid: false, error: 'dominant_subgenres empty' };
    return { valid: true };
}

// ── Agent helpers ─────────────────────────────────────────────────────────
function parseAgentJSON(text) {
    // Try markdown fence first
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch {} }

    // Find the matching closing bracket for a given opening bracket position.
    // Using lastIndexOf fails on nested structures (e.g. a 10-element dimensions array
    // has many inner '}' chars — lastIndexOf picks one in the middle of a truncated response).
    function matchingEnd(str, start, open, close) {
        let depth = 0;
        for (let i = start; i < str.length; i++) {
            if (str[i] === open)  depth++;
            else if (str[i] === close) { if (--depth === 0) return i; }
        }
        return -1;
    }

    const firstBrace   = text.indexOf('{');
    const firstBracket = text.indexOf('[');

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const end = matchingEnd(text, firstBracket, '[', ']');
        if (end > firstBracket) { try { return JSON.parse(text.slice(firstBracket, end + 1)); } catch {} }
    }
    if (firstBrace !== -1) {
        const end = matchingEnd(text, firstBrace, '{', '}');
        if (end > firstBrace) { try { return JSON.parse(text.slice(firstBrace, end + 1)); } catch {} }
    }
    try { return JSON.parse(text); } catch {}
    return null;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms)),
    ]);
}

function sendSSE(res, data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { /* connection closed */ }
}

async function callAgentWithTimeout(systemPrompt, userMessage, maxTokens, useWebSearch, timeoutMs = 25000) {
    return Promise.race([
        callAgent(systemPrompt, userMessage, maxTokens, useWebSearch),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AGENT_TIMEOUT')), timeoutMs)),
    ]);
}

async function callAgent(systemPrompt, userMessage, maxTokens, useWebSearch = false, _retried = false) {
    const headers = {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31,web-search-2025-03-05',
    };
    const body = {
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: userMessage }],
    };
    if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const t0 = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(body),
    });

    if (res.status === 429 && !_retried) {
        console.log('[callAgent] 429 — waiting 15s');
        await delay(15000);
        return callAgent(systemPrompt, userMessage, maxTokens, useWebSearch, true);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        console.error('[callAgent] error:', res.status, JSON.stringify(data));
        throw new Error(`Agent error ${res.status}: ${JSON.stringify(data.error || {})}`);
    }

    if (data.usage) {
        const { input_tokens: i = 0, output_tokens: o = 0, cache_creation_input_tokens: cw = 0, cache_read_input_tokens: cr = 0 } = data.usage;
        console.log(`[callAgent] ${Date.now() - t0}ms in:${i} out:${o} cw:${cw} cr:${cr}`);
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('[callAgent] raw:', text.slice(0, 200));
    let parsed = parseAgentJSON(text);
    if (parsed === null) {
        console.log('[callAgent] initial parse failed — attempting repairJSON');
        parsed = parseAgentJSON(repairJSON(text));
    }
    if (parsed === null) throw new Error('Could not parse agent JSON response');
    return parsed;
}

// ── Daily limit ───────────────────────────────────────────────────────────
let dailyUsage = { date: '', count: 0 };

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function checkAndIncrement() {
    const today = getTodayStr();
    if (dailyUsage.date !== today) dailyUsage = { date: today, count: 0 };
    if (dailyUsage.count >= 200) return false;
    dailyUsage.count++;
    return true;
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/daily-limit', (req, res) => {
    const today = getTodayStr();
    if (dailyUsage.date !== today) dailyUsage = { date: today, count: 0 };
    res.json({ date: dailyUsage.date, count: dailyUsage.count, limit: 200 });
});

// ── /api/analyse — SSE: Agents 1-N (track decoders) + Agent 6 (vibe synthesiser) ──
app.post('/api/analyse', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const songs = Array.isArray(req.body.songs) ? req.body.songs : [];
    if (songs.length === 0) return res.status(400).json({ error: { message: 'No songs provided' } });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); } }, 8000);
    req.on('close', () => clearInterval(keepalive));

    const trackSystem = `House music expert. Analyse this track. Return ONLY JSON: {bpm_range, subgenre, groove, energy, vocals, instruments, production_era, mood, geographic_origin, artist, title}. Return ONLY valid JSON. No markdown fences. No explanation. Start response with {`;

    const trackAnalyses = [];

    try {
        // Agents 1-N: sequential track decoders with 1500ms gaps
        for (let i = 0; i < songs.length; i++) {
            const song = songs[i];
            const userMsg = `${song.artist} - ${song.title}${song.lfmTags?.length ? ` [tags: ${song.lfmTags.slice(0, 3).join(', ')}]` : ''}`;

            sendSSE(res, { step: `track-${i}`, status: 'active', label: `Decoding: ${song.artist} — ${song.title}` });
            const t0 = Date.now();
            console.log(`[analyse] Agent ${i + 1} (Track Decoder): ${song.artist} - ${song.title}`);

            const analysis = await callAgentWithTimeout(trackSystem, userMsg, 250, false, 25000);
            const elapsed = Date.now() - t0;
            console.log(`[analyse] Agent ${i + 1} done in ${elapsed}ms`);

            trackAnalyses.push(analysis);
            sendSSE(res, { step: `track-${i}`, status: 'done', label: `Decoded: ${song.artist} — ${song.title}`, elapsed });

            if (i < songs.length - 1) await delay(1500);
        }

        // Agent 6: Vibe Synthesiser
        await delay(2000);
        sendSSE(res, { step: 'vibe', status: 'active', label: 'Synthesising your vibe DNA...' });
        const t6 = Date.now();
        console.log('[analyse] Agent 6 (Vibe Synthesiser) starting');

        const vibeSystem = `Music taste profiler. Synthesise these House track analyses. Return ONLY JSON: {vibeName, vibeDNA, dimensions (array of exactly 10 objects each with name, value, detail), dominant_subgenres (array of 3 strings), instrument_profile (array of objects with instrument and prominence), clubScene}. Dimension names must be: Tempo DNA, Harmonic Palette, Textural Layers, Emotional Arc, Vocal Character, Production Era, Geographic DNA, Scene Position, Listener Profile, Dancefloor Function. Return ONLY valid JSON. No markdown fences. No explanation. Start response with {

Output format requirements (strict):
- Return ONLY a single JSON object. No prose. No markdown fences. No explanation.
- Start your response with { and end with }
- All string values must use double quotes
- No trailing commas
- All field names must match the schema exactly

Example of valid output:
{"vibeName":"Sunset Boulevard Cruiser","vibeDNA":"Two sentences here.","dimensions":[{"name":"Tempo DNA","value":"122 BPM","detail":"Steady mid-tempo groove"}],"dominant_subgenres":["Deep House","Afro House"],"instrument_profile":[{"instrument":"Rhodes","prominence":"high"}],"clubScene":"Late-night rooftop sessions"}`;

        let vibeProfile;
        const vibeUserMsg = JSON.stringify(trackAnalyses);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                console.log('[analyse] Agent 6 schema retry — waiting 1500ms');
                await delay(1500);
            }
            const profile = await callAgentWithTimeout(vibeSystem, vibeUserMsg, 1500, false, 25000);
            const check = validateVibeSchema(profile);
            console.log(`[analyse] Agent 6 attempt ${attempt + 1}: schema ${check.valid ? 'valid' : 'INVALID — ' + check.error}`);
            if (check.valid) { vibeProfile = profile; break; }
            if (attempt === 1) throw new Error(`Agent 6 schema validation failed: ${check.error}`);
        }
        const elapsed6 = Date.now() - t6;
        console.log(`[analyse] Agent 6 done in ${elapsed6}ms | vibeName: ${vibeProfile.vibeName}`);

        sendSSE(res, { step: 'vibe', status: 'done', label: 'Vibe DNA synthesised', elapsed: elapsed6 });
        sendSSE(res, { type: 'final', result: vibeProfile });
        clearInterval(keepalive);
        res.end();

    } catch (err) {
        console.error('[analyse] error:', err.message, '\n', err.stack);
        sendSSE(res, { type: 'error', message: err.message });
        clearInterval(keepalive);
        res.end();
    }
});

// ── /api/recommend — SSE: Agent 7 + parallel discovery + LLM enrichment ──
app.post('/api/recommend', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const { vibe = {}, preferences = {} } = req.body;
    const hasFreeText = Boolean(preferences.freeText && preferences.freeText.trim());
    const subgenres = vibe.dominant_subgenres || vibe.subgenres || [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); } }, 8000);
    req.on('close', () => clearInterval(keepalive));

    const lfmSimilar = Array.isArray(req.body.lfmSimilar) ? req.body.lfmSimilar : [];
    const pipelineStart = Date.now();

    const jobState = { vibe, preferences: null, candidates: [], scoredCandidates: [], finalRecommendations: [] };
    const confidence = { level: 'high', reasons: [] };

    try {
        // Agent 7: Preference Interpreter — with per-step deadline
        sendSSE(res, { step: 'prefs', status: 'active', label: 'Mapping your preferences...' });
        const t7 = Date.now();
        let prefProfile = { groove_want: '', texture_want: '', harmony_want: '', keywords: [] };
        try {
            const a7System = `Convert House music preference scores (1-5) and free text into a sonic profile. Return ONLY JSON: {groove_want, texture_want, harmony_want, structure_want, discovery_want, keywords (array of strings), moment}. Return ONLY valid JSON. No markdown fences. No explanation. Start response with {`;
            prefProfile = await Promise.race([
                callAgentWithTimeout(a7System, JSON.stringify({
                    beat_feel:        preferences.beat_feel,
                    sound_texture:    preferences.sound_texture,
                    emotion_hypnosis: preferences.emotion_hypnosis,
                    track_journey:    preferences.track_journey,
                    discovery_style:  preferences.discovery_style,
                    freeText:         preferences.freeText || '',
                }), 250, false, 25000),
                new Promise((_, reject) => setTimeout(() => reject(new Error('prefs_timeout')), STEP_DEADLINES.preference)),
            ]);
        } catch (err) {
            console.log('[recommend] prefs fallback — continuing:', err.message);
        }
        jobState.preferences = prefProfile;
        const d7 = Date.now() - t7;
        logStep('preference', { duration: d7, success: Boolean(prefProfile.groove_want), candidates: 0, fallback: !prefProfile.groove_want });
        sendSSE(res, { step: 'prefs', status: 'done', label: 'Preferences mapped', elapsed: d7 });

        // Parallel discovery — all sources run simultaneously
        const hasDiscogs = Boolean(process.env.DISCOGS_TOKEN);
        sendSSE(res, { step: 'lastfm_tags',    status: 'active', label: 'Searching Last.fm tags...' });
        sendSSE(res, { step: 'lastfm_similar', status: 'active', label: 'Finding similar tracks...' });
        sendSSE(res, { step: 'musicbrainz',    status: 'active', label: 'Searching MusicBrainz...' });
        sendSSE(res, { step: 'discogs',        status: 'active', label: hasDiscogs ? 'Searching Discogs...' : 'Discogs (not configured)' });
        sendSSE(res, { step: 'niche',          status: 'active', label: 'Checking niche database...' });

        const tDisc = Date.now();
        const { candidates: rawCandidates, sourceCounts } = await runDiscovery(subgenres, lfmSimilar);
        const dDisc = Date.now() - tDisc;

        sendSSE(res, { step: 'lastfm_tags',    status: 'done',   label: `${sourceCounts.lastfm_tags} Last.fm tracks`,       elapsed: dDisc });
        sendSSE(res, { step: 'lastfm_similar', status: 'done',   label: `${sourceCounts.lastfm_similar} similar artists`,    elapsed: 0 });
        sendSSE(res, { step: 'musicbrainz',    status: sourceCounts.musicbrainz > 0 ? 'done' : 'warn',
                                               label: `${sourceCounts.musicbrainz} MusicBrainz tracks`,                     elapsed: dDisc });
        sendSSE(res, { step: 'discogs',        status: hasDiscogs ? (sourceCounts.discogs > 0 ? 'done' : 'warn') : 'warn',
                                               label: hasDiscogs ? `${sourceCounts.discogs} Discogs releases` : 'Discogs skipped', elapsed: dDisc });
        sendSSE(res, { step: 'niche',          status: 'done',   label: `${sourceCounts.csv_niche} niche artists`,           elapsed: 0 });

        // Quorum check
        const apiCandidates = sourceCounts.lastfm_tags + sourceCounts.musicbrainz + sourceCounts.discogs;
        if (apiCandidates === 0) {
            confidence.level = 'low';
            confidence.reasons.push('discovery_apis_unavailable');
        } else if (rawCandidates.length < TARGET_CANDIDATES) {
            confidence.level = 'medium';
            confidence.reasons.push('limited_candidates');
        }

        // Broaden if needed
        let allCandidates = rawCandidates;
        if (rawCandidates.length < MIN_CANDIDATES) {
            try {
                const fallback = await withTimeout(
                    cachedFetch('tag:house', () => retryWithJitter(() => fetchLastFmTagTracks('house'))),
                    3000
                );
                allCandidates = [...rawCandidates, ...fallback];
                console.log('[recommend] broadened with house tag:', fallback.length, 'extra tracks');
            } catch {}
        }

        // Scoring step — dedup, diversify, then deterministic score
        sendSSE(res, { step: 'score', status: 'active', label: 'Scoring candidates...' });
        const tScore = Date.now();

        const dedupedCandidates = dedupeCandidates(allCandidates);
        jobState.candidates = diversifyCandidates(dedupedCandidates);
        console.log('[recommend] total:', allCandidates.length, '| deduped:', dedupedCandidates.length, '| diversified:', jobState.candidates.length, '| confidence:', confidence.level);

        const freeTextKeywords = hasFreeText
            ? preferences.freeText.trim().split(/\s+/).filter(k => k.length > 3)
            : [];
        jobState.scoredCandidates = scoreCandidatesDeterministic(jobState.candidates, vibe, prefProfile, freeTextKeywords);
        const dScore = Date.now() - tScore;
        logStep('deterministicScore', { duration: dScore, success: true, candidates: jobState.scoredCandidates.length });
        sendSSE(res, { step: 'score', status: 'done', label: `${jobState.scoredCandidates.length} candidates scored`, elapsed: dScore });

        // Pipeline budget check
        const skipLLM = (Date.now() - pipelineStart) > 40000;

        // LLM enrichment — optional, graceful fallback to deterministic
        sendSSE(res, { step: 'build', status: 'active', label: 'Building your playlist...' });
        const t13 = Date.now();
        let recommendations;
        let llmSuccess = false;

        if (skipLLM) {
            console.log('[recommend] LLM skipped — pipeline budget exceeded');
            recommendations = jobState.scoredCandidates.map(c => formatDeterministicRec(c, vibe));
        } else {
            const weightsLine = hasFreeText
                ? '40% match to vibe DNA, 30% match to preference profile, 30% match to free text'
                : '57% match to vibe DNA, 43% match to preference profile';
            const aFinalSystem = `You are a House music recommendation engine. From these candidate tracks, select exactly 8 best matches using these weights: ${weightsLine}. Prioritise sonic fit over fame. Return ONLY JSON array of exactly 8 tracks: [{title, artist, subgenre, scene (one line), instruments (array of 3), why (2 sentences referencing specific vibe dimensions), youtube_url (https://music.youtube.com/search?q=Artist+Title with spaces as +), spotify_url (https://open.spotify.com/search/Artist%20Title/tracks), lastfm_url (https://www.last.fm/music/Artist/_/Title), weightMatch (vibe/preference/freetext)}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
            const aFinalUser = [
                `CANDIDATE TRACKS (top 8 pre-scored):\n${JSON.stringify(jobState.scoredCandidates)}`,
                `VIBE DNA:\n${JSON.stringify(vibe)}`,
                `PREFERENCE PROFILE:\n${JSON.stringify(prefProfile)}`,
                hasFreeText ? `FREE TEXT: "${preferences.freeText}"` : '',
            ].filter(Boolean).join('\n\n');

            try {
                const recsRaw = await Promise.race([
                    callAgentWithTimeout(aFinalSystem, aFinalUser, 2500, false, 25000),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('llm_timeout')), STEP_DEADLINES.llmEnrich)),
                ]);
                const enriched = unwrapArray(recsRaw);
                if (enriched.length) { recommendations = enriched; llmSuccess = true; }
                else throw new Error('empty_llm_result');
            } catch (err) {
                console.log('[recommend] LLM enrichment failed, using deterministic:', err.message);
                recommendations = jobState.scoredCandidates.map(c => formatDeterministicRec(c, vibe));
            }
        }

        if (!llmSuccess) {
            confidence.reasons.push('using_template_rationale');
            if (confidence.level === 'high') confidence.level = 'medium';
        }

        const d13 = Date.now() - t13;
        logStep('llmEnrich', { duration: d13, success: llmSuccess, candidates: recommendations.length, fallback: !llmSuccess });

        // Source contribution logging
        const csvCount = recommendations.filter(r => r.source === 'csv_niche').length;
        console.log(JSON.stringify({
            step: 'final_recommendations',
            recommendations_by_source: {
                lastfm_tags:    recommendations.filter(r => r.source === 'lastfm_tags').length,
                lastfm_similar: recommendations.filter(r => r.source === 'lastfm_similar').length,
                musicbrainz:    recommendations.filter(r => r.source === 'musicbrainz').length,
                discogs:        recommendations.filter(r => r.source === 'discogs').length,
                csv_niche:      csvCount,
            },
            csv_dependency_pct: Math.round((csvCount / Math.max(recommendations.length, 1)) * 100),
        }));
        console.log(`[recommend] done in ${Date.now() - pipelineStart}ms | tracks: ${recommendations.length} | confidence: ${JSON.stringify(confidence)}`);

        jobState.finalRecommendations = recommendations;

        // Final validation — filter out any recs missing required fields
        const finalOutput = validateFinalRecommendations(recommendations);
        if (finalOutput.length < 6) {
            console.log(`[recommend] WARNING: only ${finalOutput.length} valid recs after final validation (degraded mode)`);
        }

        sendSSE(res, { step: 'build', status: 'done', label: 'Playlist built', elapsed: d13 });
        sendSSE(res, { type: 'final', result: finalOutput.length > 0 ? finalOutput : recommendations });
        clearInterval(keepalive);
        res.end();

    } catch (err) {
        console.error('[recommend] error:', err.message, '\n', err.stack);
        if (jobState.scoredCandidates.length > 0) {
            const fallbackRecs = jobState.scoredCandidates.map(c => formatDeterministicRec(c, vibe));
            sendSSE(res, { step: 'build', status: 'warn', label: 'Using deterministic results' });
            sendSSE(res, { type: 'final', result: fallbackRecs });
        } else {
            sendSSE(res, { type: 'error', message: err.message });
        }
        clearInterval(keepalive);
        res.end();
    }
});

// ── Legacy Claude proxy ───────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const detectedSubgenres = Array.isArray(req.body.subgenres) ? req.body.subgenres : [];
    const baseSystemText = req.body.system || '';
    let systemBlocks;

    if (detectedSubgenres.length > 0) {
        const bucketKey  = subgenresToBucketKey(detectedSubgenres);
        const artistText = artistTextByBucket[bucketKey] || '';
        if (artistText) {
            const artistCount = Math.min((artistsByBucket[bucketKey] || []).length, 80);
            systemBlocks = [
                { type: 'text', text: baseSystemText },
                { type: 'text', text: `\n\nNICHE ARTIST REFERENCE — ${bucketKey.replace(/_/g, ' ')} (${artistCount} curated artists):\n${artistText}`, cache_control: { type: 'ephemeral' } },
            ];
        } else {
            systemBlocks = [{ type: 'text', text: baseSystemText, cache_control: { type: 'ephemeral' } }];
        }
    } else {
        systemBlocks = [{ type: 'text', text: baseSystemText, cache_control: { type: 'ephemeral' } }];
    }

    const upstreamBody = {
        model:      req.body.model || 'claude-sonnet-4-6',
        max_tokens: req.body.max_tokens || 2000,
        system:     systemBlocks,
        messages:   req.body.messages,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    };

    const anthropicHeaders = {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31,web-search-2025-03-05',
    };

    const callAnthropic = () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: anthropicHeaders, body: JSON.stringify(upstreamBody),
    });

    let upstream;
    try {
        upstream = await callAnthropic();
        if (upstream.status === 429) {
            console.log('[claude] rate limited — retrying in 10s');
            await new Promise(r => setTimeout(r, 10000));
            upstream = await callAnthropic();
        }
    } catch (err) {
        return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}` } });
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
        console.error('[claude] upstream error:', upstream.status, JSON.stringify(data));
        return res.status(upstream.status).json({ error: data.error || { message: `Upstream error ${upstream.status}` } });
    }

    const fullText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (data.usage) {
        const { input_tokens = 0, output_tokens = 0, cache_creation_input_tokens: cw = 0, cache_read_input_tokens: cr = 0 } = data.usage;
        console.log(`[claude] in:${input_tokens} out:${output_tokens} cw:${cw} cr:${cr}`);
    }
    res.json({ content: fullText });
});

// ── Last.fm proxy ─────────────────────────────────────────────────────────
app.get('/api/lastfm', async (req, res) => {
    const params = new URLSearchParams(req.query);
    params.set('api_key', process.env.LASTFM_API_KEY);
    params.set('format', 'json');

    let upstream;
    try {
        upstream = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }

    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
});

app.listen(PORT, () => console.log(`House Music Resonance Engine running on port ${PORT}`));
