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

// ── /api/recommend — SSE: Agents 7-13 ────────────────────────────────────
app.post('/api/recommend', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const { vibe = {}, preferences = {} } = req.body;
    const hasFreeText = Boolean(preferences.freeText && preferences.freeText.trim());
    const subgenres = vibe.dominant_subgenres || vibe.subgenres || [];
    const dominantSubgenre = subgenres.slice(0, 2).join(', ') || 'house';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); } }, 8000);
    req.on('close', () => clearInterval(keepalive));

    try {
        // Agent 7: Preference Interpreter
        sendSSE(res, { step: 'prefs', status: 'active', label: 'Mapping your preferences...' });
        const t7 = Date.now();
        const a7System = `Convert House music preference scores (1-5) and free text into a sonic profile. Return ONLY JSON: {groove_want, texture_want, harmony_want, structure_want, discovery_want, keywords (array of strings), moment}. Return ONLY valid JSON. No markdown fences. No explanation. Start response with {`;
        const prefProfile = await callAgentWithTimeout(a7System, JSON.stringify({
            beat_feel:        preferences.beat_feel,
            sound_texture:    preferences.sound_texture,
            emotion_hypnosis: preferences.emotion_hypnosis,
            track_journey:    preferences.track_journey,
            discovery_style:  preferences.discovery_style,
            freeText:         preferences.freeText || '',
        }), 250, false, 25000);
        sendSSE(res, { step: 'prefs', status: 'done', label: 'Preferences mapped', elapsed: Date.now() - t7 });

        // Agent 8: Beatport Scout — graceful failure, pipeline continues
        await delay(2000);
        sendSSE(res, { step: 'beatport', status: 'active', label: 'Scouting Beatport...' });
        const t8 = Date.now();
        const a8System = `Search Beatport for 5 real released House tracks matching this subgenre. Only tracks you are highly confident exist. Return ONLY JSON array: [{artist, title, subgenre, release_year, confidence}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
        let beatportCandidates = [];
        try {
            beatportCandidates = unwrapArray(await callAgentWithTimeout(a8System, `Dominant subgenre: ${dominantSubgenre}\nVibe: ${vibe.vibeDNA || ''}`, 600, true, 55000));
            sendSSE(res, { step: 'beatport', status: 'done', label: `Beatport scouted (${beatportCandidates.length} tracks)`, elapsed: Date.now() - t8 });
        } catch (err) {
            console.warn('[recommend] Agent 8 (Beatport) failed:', err.message);
            sendSSE(res, { step: 'beatport', status: 'warn', label: 'Beatport scout slow — continuing with other sources', elapsed: Date.now() - t8 });
        }

        // Agent 9: Traxsource Scout — graceful failure
        await delay(5000);
        sendSSE(res, { step: 'traxsource', status: 'active', label: 'Scouting Traxsource...' });
        const t9 = Date.now();
        const a9System = `Search Traxsource for 5 real released House tracks matching this subgenre. Include underground artists. Only tracks you are highly confident exist. Return ONLY JSON array: [{artist, title, subgenre, release_year, confidence}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
        let traxsourceCandidates = [];
        try {
            traxsourceCandidates = unwrapArray(await callAgentWithTimeout(a9System, `Dominant subgenre: ${dominantSubgenre}\nVibe DNA: ${vibe.vibeDNA || ''}`, 600, true, 55000));
            sendSSE(res, { step: 'traxsource', status: 'done', label: `Traxsource scouted (${traxsourceCandidates.length} tracks)`, elapsed: Date.now() - t9 });
        } catch (err) {
            console.warn('[recommend] Agent 9 (Traxsource) failed:', err.message);
            sendSSE(res, { step: 'traxsource', status: 'warn', label: 'Traxsource scout slow — continuing with other sources', elapsed: Date.now() - t9 });
        }

        // Agent 10: Resident Advisor Scout — graceful failure
        await delay(5000);
        sendSSE(res, { step: 'ra', status: 'active', label: 'Scouting Resident Advisor...' });
        const t10 = Date.now();
        const a10System = `Search Resident Advisor for 5 real released House tracks matching this taste profile. Include emerging artists. Only tracks you are highly confident exist. Return ONLY JSON array: [{artist, title, subgenre, release_year, confidence}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
        let raCandidates = [];
        try {
            raCandidates = unwrapArray(await callAgentWithTimeout(a10System, `Vibe DNA: ${vibe.vibeDNA || ''}\nPreference: ${JSON.stringify(prefProfile)}`, 600, true, 55000));
            sendSSE(res, { step: 'ra', status: 'done', label: `Resident Advisor scouted (${raCandidates.length} tracks)`, elapsed: Date.now() - t10 });
        } catch (err) {
            console.warn('[recommend] Agent 10 (RA) failed:', err.message);
            sendSSE(res, { step: 'ra', status: 'warn', label: 'RA scout slow — continuing with other sources', elapsed: Date.now() - t10 });
        }

        // Agent 11: CSV Niche Matcher — pure JS, zero tokens
        sendSSE(res, { step: 'niche', status: 'active', label: 'Checking niche artist database...' });
        const nicheArtists = getNicheArtists(subgenres);
        const totalCandidates = beatportCandidates.length + traxsourceCandidates.length + raCandidates.length;
        console.log('[recommend] niche artists:', nicheArtists.length, '| web candidates:', totalCandidates);
        sendSSE(res, { step: 'niche', status: 'done', label: `${nicheArtists.length} niche artists matched`, elapsed: 0 });

        const allCandidates = [...beatportCandidates, ...traxsourceCandidates, ...raCandidates];

        // Agent 12: Pre-Scorer
        await delay(2000);
        sendSSE(res, { step: 'score', status: 'active', label: 'Scoring candidates...' });
        const t12 = Date.now();
        const weightsLine = hasFreeText
            ? '40% vibe match, 30% preference match, 30% free text match'
            : '57% vibe match, 43% preference match';
        const a12System = `Score these candidate tracks against this vibe DNA and preference profile. Weights: ${weightsLine}. Also check if any niche artists provided would fit better — if so add them. Return ONLY top 10 scored candidates as JSON array: [{artist, title, subgenre, score_out_of_10, why_it_fits}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
        const a12User = `VIBE DNA: ${JSON.stringify(vibe)}\nPREFERENCE PROFILE: ${JSON.stringify(prefProfile)}${hasFreeText ? `\nFREE TEXT: "${preferences.freeText}"` : ''}\nCANDIDATES (${allCandidates.length}): ${JSON.stringify(allCandidates)}\nNICHE ARTISTS: ${nicheArtists.join(', ')}`;
        const scoredRaw = await callAgentWithTimeout(a12System, a12User, 800, false, 25000);
        const scoredCandidates = unwrapArray(scoredRaw);
        sendSSE(res, { step: 'score', status: 'done', label: `${scoredCandidates.length} candidates scored`, elapsed: Date.now() - t12 });

        // Agent 13: Final Recommendation Builder
        await delay(2000);
        sendSSE(res, { step: 'build', status: 'active', label: 'Building your playlist...' });
        const t13 = Date.now();
        const a13System = `You are the final recommendation engine. From these pre-scored candidates select exactly 8 best matches. For each write a compelling card. Return ONLY JSON array of exactly 8 objects: [{title, artist, subgenre, scene (one line), instruments (array of 3), why (2 sentences referencing specific vibe dimensions), youtube_url (https://music.youtube.com/search?q=Artist+Title with spaces as +), spotify_url (https://open.spotify.com/search/Artist%20Title/tracks), lastfm_url (https://www.last.fm/music/Artist/_/Title), weightMatch (string: which weights drove this — vibe/preference/freetext)}]. Return ONLY valid JSON. No markdown fences. No explanation. Start response with [`;
        const a13User = `SCORED CANDIDATES: ${JSON.stringify(scoredCandidates)}\nVIBE DNA: ${JSON.stringify(vibe)}\nPREFERENCE PROFILE: ${JSON.stringify(prefProfile)}`;
        const recsRaw = await callAgentWithTimeout(a13System, a13User, 1800, false, 25000);
        const recommendations = unwrapArray(recsRaw);
        const elapsed13 = Date.now() - t13;
        console.log(`[recommend] Agent 13 done in ${elapsed13}ms | tracks: ${recommendations.length}`);
        sendSSE(res, { step: 'build', status: 'done', label: 'Playlist built', elapsed: elapsed13 });
        sendSSE(res, { type: 'final', result: recommendations });
        clearInterval(keepalive);
        res.end();

    } catch (err) {
        console.error('[recommend] error:', err.message, '\n', err.stack);
        sendSSE(res, { type: 'error', message: err.message });
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
