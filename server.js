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

// Refinement 6: Source diversity caps — prevents any single source from swamping
function diversifyCandidates(candidates) {
    const bySource = { lastfm_tags: [], lastfm_similar: [], csv_niche: [] };
    candidates.forEach(c => { if (bySource[c.source]) bySource[c.source].push(c); });
    return [
        ...bySource.lastfm_tags.slice(0, 4),
        ...bySource.lastfm_similar.slice(0, 4),
        ...bySource.csv_niche.slice(0, 4),
    ];
}

// Discovery 1: Last.fm tag top tracks — no Anthropic call, ~500ms per tag
async function fetchLastFmTagTracks(tag) {
    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&limit=20&api_key=${process.env.LASTFM_API_KEY}&format=json`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.tracks?.track || [])
            .map(t => ({ artist: t.artist?.name || '', title: t.name || '', subgenre: tag, source: 'lastfm_tags' }))
            .filter(t => t.artist && t.title);
    } catch { return []; }
}

function unwrapArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
        const arr = Object.values(v).find(x => Array.isArray(x));
        if (arr) return arr;
    }
    return [];
}

// ── Agent helpers ─────────────────────────────────────────────────────────
function parseAgentJSON(text) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch {} }
    const firstBrace   = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const last = text.lastIndexOf(']');
        if (last > firstBracket) { try { return JSON.parse(text.slice(firstBracket, last + 1)); } catch {} }
    }
    if (firstBrace !== -1) {
        const last = text.lastIndexOf('}');
        if (last > firstBrace) { try { return JSON.parse(text.slice(firstBrace, last + 1)); } catch {} }
    }
    try { return JSON.parse(text); } catch {}
    return null;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
    const parsed = parseAgentJSON(text);
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

        const vibeSystem = `Music taste profiler. Synthesise these House track analyses. Return ONLY JSON: {vibeName, vibeDNA, dimensions (array of exactly 10 objects each with name, value, detail), dominant_subgenres (array of 3 strings), instrument_profile (array of objects with instrument and prominence), clubScene}. Dimension names must be: Tempo DNA, Harmonic Palette, Textural Layers, Emotional Arc, Vocal Character, Production Era, Geographic DNA, Scene Position, Listener Profile, Dancefloor Function. Return ONLY valid JSON. No markdown fences. No explanation. Start response with {`;

        const vibeProfile = await callAgentWithTimeout(vibeSystem, JSON.stringify(trackAnalyses), 1000, false, 25000);
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

// ── /api/recommend — SSE: Agents 7 + Discoveries 1-3 + LLM enrichment ───
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

    // Refinement 10: Partial result checkpoints
    const jobState = {
        vibe, preferences: null, candidates: [], scoredCandidates: [], finalRecommendations: [],
    };

    // Refinement 8: Confidence tracking (logged only, never shown to user)
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

        // Discovery 1: Last.fm tag tracks — cached, retried, per-tag deadline (Refinements 3, 5, 9)
        sendSSE(res, { step: 'lastfm_tags', status: 'active', label: 'Finding subgenre tracks...' });
        const t8 = Date.now();
        const tagsToSearch = subgenres.slice(0, 2).filter(Boolean);
        const tagCandidates = tagsToSearch.length
            ? (await Promise.all(
                tagsToSearch.map(tag =>
                    Promise.race([
                        cachedFetch(`tag:${tag}`, () => retryWithJitter(() => fetchLastFmTagTracks(tag))),
                        new Promise(resolve => setTimeout(() => resolve([]), STEP_DEADLINES.lastfmTags)),
                    ])
                )
              )).flat()
            : [];
        const d8 = Date.now() - t8;
        console.log('[recommend] Last.fm tag tracks:', tagCandidates.length, 'from tags:', tagsToSearch);
        logStep('lastfmTags', { duration: d8, success: tagCandidates.length > 0, candidates: tagCandidates.length });
        sendSSE(res, { step: 'lastfm_tags', status: 'done', label: `${tagCandidates.length} subgenre tracks found`, elapsed: d8 });

        // Discovery 2: Last.fm similar artists — instant, from analysis phase
        sendSSE(res, { step: 'lastfm_similar', status: 'active', label: 'Finding similar tracks...' });
        const similarArtistNames = [...new Set(lfmSimilar.flatMap(x => x.similar || []))];
        const similarCandidates = similarArtistNames.map(a => ({
            artist: a, title: '', subgenre: subgenres[0] || 'house', source: 'lastfm_similar',
        }));
        console.log('[recommend] similar artists:', similarArtistNames.length);
        sendSSE(res, { step: 'lastfm_similar', status: 'done', label: `${similarArtistNames.length} similar artists identified`, elapsed: 0 });

        // Discovery 3: CSV Niche Matcher — pure JS, instant
        sendSSE(res, { step: 'niche', status: 'active', label: 'Checking niche database...' });
        const nicheArtists = getNicheArtists(subgenres);
        const nicheCandidates = nicheArtists.map(a => ({
            artist: a, title: '', subgenre: subgenres[0] || 'house', source: 'csv_niche',
        }));
        console.log('[recommend] niche artists:', nicheArtists.length);
        sendSSE(res, { step: 'niche', status: 'done', label: `${nicheArtists.length} niche artists matched`, elapsed: 0 });

        // Refinement 3: Quorum check — assess candidate pool quality
        const allCandidates = [...tagCandidates, ...similarCandidates, ...nicheCandidates];
        if (tagCandidates.length === 0) {
            confidence.level = 'low';
            confidence.reasons.push('discovery_apis_unavailable');
        } else if (allCandidates.length < TARGET_CANDIDATES) {
            confidence.level = 'medium';
            confidence.reasons.push('limited_candidates');
        }

        // Broaden if below minimum threshold
        let broadenedCandidates = allCandidates;
        if (allCandidates.length < MIN_CANDIDATES) {
            try {
                const fallback = await Promise.race([
                    cachedFetch('tag:house', () => retryWithJitter(() => fetchLastFmTagTracks('house'))),
                    new Promise(resolve => setTimeout(() => resolve([]), 3000)),
                ]);
                broadenedCandidates = [...allCandidates, ...fallback];
                console.log('[recommend] broadened with house tag:', fallback.length, 'extra tracks');
            } catch {}
        }

        // Refinement 6: Diversity caps — prevent any single source swamping the top 8
        jobState.candidates = diversifyCandidates(broadenedCandidates);
        console.log('[recommend] total:', allCandidates.length, '| diversified:', jobState.candidates.length, '| confidence:', confidence.level);

        // Refinement 1: Deterministic scorer — ALWAYS produces 8 results, zero failure modes
        const freeTextKeywords = hasFreeText
            ? preferences.freeText.trim().split(/\s+/).filter(k => k.length > 3)
            : [];
        const tScore = Date.now();
        jobState.scoredCandidates = scoreCandidatesDeterministic(jobState.candidates, vibe, prefProfile, freeTextKeywords);
        logStep('deterministicScore', { duration: Date.now() - tScore, success: true, candidates: jobState.scoredCandidates.length });

        // Refinement 4: Check pipeline budget — skip LLM enrichment if too close to limit
        const skipLLM = (Date.now() - pipelineStart) > 40000;

        // Refinement 2: LLM enrichment — enriches deterministic top 8, graceful fallback
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
                `ALL SIMILAR ARTISTS:\n${similarArtistNames.join(', ') || 'none'}`,
                `NICHE CURATED ARTISTS:\n${nicheArtists.join(', ')}`,
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
                console.log('[recommend] LLM enrichment failed, using deterministic fallback:', err.message);
                recommendations = jobState.scoredCandidates.map(c => formatDeterministicRec(c, vibe));
            }
        }

        // Update confidence if LLM path was not used
        if (!llmSuccess) {
            confidence.reasons.push('using_template_rationale');
            if (confidence.level === 'high') confidence.level = 'medium';
        }

        const d13 = Date.now() - t13;
        logStep('llmEnrich', { duration: d13, success: llmSuccess, candidates: recommendations.length, fallback: !llmSuccess });
        console.log(`[recommend] done in ${Date.now() - pipelineStart}ms | tracks: ${recommendations.length} | confidence: ${JSON.stringify(confidence)}`);

        jobState.finalRecommendations = recommendations;
        sendSSE(res, { step: 'build', status: 'done', label: 'Playlist built', elapsed: d13 });
        sendSSE(res, { type: 'final', result: recommendations });
        clearInterval(keepalive);
        res.end();

    } catch (err) {
        // Refinement 10: Return partial results if deterministic scorer already ran
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
