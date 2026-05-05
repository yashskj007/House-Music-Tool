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

// Canonical bucket keys and the CSV bucket substrings that map to them
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
    return null; // skip legacy/crossover/mainstream buckets
}

// Maps a detected subgenre array to the best canonical bucket key
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

// Pre-generate plain-text artist strings for prompt caching
const artistTextByBucket = {};
for (const [key, artists] of Object.entries(artistsByBucket)) {
    artistTextByBucket[key] = artists.slice(0, 80).join(', ');
}

// Agent 9: pure JS CSV matcher — zero tokens
function getNicheArtists(subgenres) {
    const bucketKey = subgenresToBucketKey(subgenres || []);
    return (artistsByBucket[bucketKey] || []).slice(0, 40);
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

async function callAnthropicAgent(systemBlocks, messages, maxTokens, useWebSearch) {
    const betaHeader = useWebSearch
        ? 'prompt-caching-2024-07-31,web-search-2025-03-05'
        : 'prompt-caching-2024-07-31';
    const body = {
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     systemBlocks,
        messages,
        ...(useWebSearch ? { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } : {}),
    };
    const headers = {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    betaHeader,
    };
    let upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    if (upstream.status === 429) {
        console.log('[agent] rate limited — retrying in 10s');
        await new Promise(r => setTimeout(r, 10000));
        upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers, body: JSON.stringify(body),
        });
    }
    const data = await upstream.json().catch(() => ({}));
    console.log(`[agent] http:${upstream.status} stop_reason:${data.stop_reason} blocks:[${(data.content||[]).map(b=>b.type).join(',')}]`);
    if (!upstream.ok) {
        console.error('[agent] upstream error body:', JSON.stringify(data));
        throw new Error(`Agent error ${upstream.status}: ${JSON.stringify(data.error || {})}`);
    }
    if (data.usage) {
        const { input_tokens: i = 0, output_tokens: o = 0, cache_creation_input_tokens: cw = 0, cache_read_input_tokens: cr = 0 } = data.usage;
        console.log(`[agent] usage — in:${i} out:${o} cw:${cw} cr:${cr}`);
    }
    const rawText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    console.log('[agent] raw text length:', rawText.length, '| full text:\n', rawText);
    return rawText;
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

// Agents 1-5 (parallel track analysis) + Agent 6 (vibe synthesis)
app.post('/api/analyse', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const songs = Array.isArray(req.body.songs) ? req.body.songs : [];
    if (songs.length === 0) return res.status(400).json({ error: { message: 'No songs provided' } });

    // Shared system for Agents 1-5 — identical across parallel calls so cache hits
    const a15System = `You are a House music expert. Analyse these tracks and return ONLY a JSON array where each element has: bpm_range, subgenre, groove, energy, vocals, instruments (array), production_era, mood, geographic_origin, artist, title. Return ONLY the JSON array. No markdown. No explanation. Start your response with [`;
    const a15Blocks = [{ type: 'text', text: a15System, cache_control: { type: 'ephemeral' } }];

    // Distribute songs across 5 agents using round-robin
    const agentGroups = Array.from({ length: 5 }, () => []);
    songs.forEach((song, i) => agentGroups[i % 5].push(song));
    console.log('[analyse] songs:', songs.length, '| distribution:', agentGroups.map(g => g.length).join(','));

    try {
        // Agents 1-5 in parallel
        const agent15Results = await Promise.all(
            agentGroups.map(async (group, idx) => {
                if (group.length === 0) return [];
                const userMsg = group.map(s => {
                    let line = `${s.artist} - ${s.title}`;
                    if (s.lfmTags && s.lfmTags.length) line += ` [tags: ${s.lfmTags.slice(0, 3).join(', ')}]`;
                    return line;
                }).join('\n');
                const maxTok = 400 * group.length;
                console.log(`[analyse] Agent ${idx + 1} starting — songs:${group.length} maxTok:${maxTok}`);
                const text = await callAnthropicAgent(a15Blocks, [{ role: 'user', content: userMsg }], maxTok, false);
                console.log(`[analyse] Agent ${idx + 1} RAW:\n`, text);
                const parsed = parseAgentJSON(text);
                if (Array.isArray(parsed)) return parsed;
                if (parsed && typeof parsed === 'object') return [parsed];
                return [];
            })
        );

        const allAnalyses = agent15Results.flat();
        console.log('[analyse] total track analyses:', allAnalyses.length);

        // Agent 6 — Vibe DNA Synthesiser
        const a6System = `You are a music taste profiler. Given analyses of House tracks, synthesise the listener's taste profile. Return ONLY JSON with: vibeName (creative 3-word name), vibeDNA (2 sentence description of their taste), dimensions (array of 10 objects with name, value, detail covering: Tempo DNA, Harmonic Palette, Textural Layers, Emotional Arc, Vocal Character, Production Era, Geographic DNA, Scene Position, Listener Profile, Dancefloor Function), dominant_subgenres (array), instrument_profile (array of {instrument, prominence}), clubScene (string). Return ONLY the JSON object. No markdown. No explanation. Start your response with {`;
        console.log('[analyse] Agent 6 starting');
        const a6Text = await callAnthropicAgent(
            [{ type: 'text', text: a6System, cache_control: { type: 'ephemeral' } }],
            [{ role: 'user', content: JSON.stringify(allAnalyses) }],
            1500, false
        );
        console.log('[analyse] Agent 6 RAW:\n', a6Text);
        const vibeProfile = parseAgentJSON(a6Text) || {};
        console.log('[analyse] Agent 6 vibeName:', vibeProfile.vibeName, '| subgenres:', vibeProfile.dominant_subgenres);

        res.json({ vibe: vibeProfile });
    } catch (err) {
        console.error('[analyse] ✗ error:', err.message, '\n', err.stack);
        res.status(502).json({ error: { message: err.message } });
    }
});

// Agents 7 (prefs) + 8 (web scout) + 9 (CSV) in parallel → Agent 10 (synthesise)
app.post('/api/recommend', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const { vibe = {}, preferences = {} } = req.body;
    const hasFreeText = Boolean(preferences.freeText && preferences.freeText.trim());
    const subgenres = vibe.dominant_subgenres || vibe.subgenres || [];

    try {
        // Agent 7 — Preference Interpreter
        const a7System = `Convert these House music preference scores (1-5 scale, 3=neutral) and free text into a sonic profile. Return ONLY JSON with: groove_want (string), texture_want (string), harmony_want (string), structure_want (string), discovery_want (string), keywords (array of strings from free text), moment_context (string describing listening moment). Return ONLY the JSON object. No markdown. No explanation. Start your response with {`;
        const a7User = JSON.stringify({
            beat_feel:        preferences.beat_feel,
            sound_texture:    preferences.sound_texture,
            emotion_hypnosis: preferences.emotion_hypnosis,
            track_journey:    preferences.track_journey,
            discovery_style:  preferences.discovery_style,
            freeText:         preferences.freeText || '',
        });

        // Agent 8 — Web Scout
        const a8System = `You are a House music scout. Search for 15 real released tracks matching these subgenres and preferences. Use web search to find current releases from Beatport, Traxsource, and Resident Advisor. Include underground and emerging artists. Only recommend tracks you are highly confident exist as real releases. Return ONLY a JSON array of 15 objects: [{artist, title, subgenre, release_year, why_it_fits, confidence: "high" or "medium"}]. Return ONLY the JSON array. No markdown. No explanation. Start your response with [`;
        const a8User = `Dominant subgenres: ${subgenres.join(', ')}\nVibe: ${vibe.vibeDNA || ''}\nPreference notes: ${preferences.freeText || 'not specified'}`;

        console.log('[recommend] Agents 7+8+9 starting in parallel');

        const [prefProfile, webCandidates, nicheArtists] = await Promise.all([
            // Agent 7
            callAnthropicAgent(
                [{ type: 'text', text: a7System, cache_control: { type: 'ephemeral' } }],
                [{ role: 'user', content: a7User }],
                400, false
            ).then(text => {
                console.log('[recommend] Agent 7 RAW:\n', text);
                return parseAgentJSON(text) || {};
            }),
            // Agent 8
            callAnthropicAgent(
                [{ type: 'text', text: a8System, cache_control: { type: 'ephemeral' } }],
                [{ role: 'user', content: a8User }],
                2000, true
            ).then(text => {
                console.log('[recommend] Agent 8 RAW:\n', text);
                let c = parseAgentJSON(text);
                if (!Array.isArray(c) && c && typeof c === 'object') {
                    const unwrapped = Object.values(c).find(v => Array.isArray(v));
                    if (unwrapped) c = unwrapped;
                }
                return Array.isArray(c) ? c : [];
            }),
            // Agent 9 — pure JS, zero tokens
            Promise.resolve(getNicheArtists(subgenres)),
        ]);

        console.log('[recommend] Agent 7 moment_context:', prefProfile.moment_context);
        console.log('[recommend] Agent 8 candidates:', webCandidates.length);
        console.log('[recommend] Agent 9 niche artists:', nicheArtists.length);

        // Agent 10 — Recommendation Engine
        const weightsLine = hasFreeText
            ? '40% match to vibe DNA dimensions, 30% match to preference profile, 30% match to free text keywords'
            : '57% match to vibe DNA dimensions, 43% match to preference profile';
        const a10System = `You are a music recommendation engine. Score each candidate track against these weights: ${weightsLine}. Select exactly 8 highest scoring tracks. For niche artists provided, check if any fit better than web candidates and substitute if so. CRITICAL: Only recommend tracks you are highly confident exist as real released songs. Return ONLY a JSON array of exactly 8 objects: [{title, artist, subgenre, scene (one line), instruments (array), why (2 sentences mentioning specific dimensions matched), youtube_url (https://music.youtube.com/search?q=Artist+Title with spaces as +), spotify_url (https://open.spotify.com/search/Artist%20Title/tracks), lastfm_url (https://www.last.fm/music/Artist/_/Title), weightMatch (string explaining which weights drove this pick)}]. Return ONLY the JSON array. No markdown. No explanation. Start your response with [`;
        const a10User = `VIBE DNA:\n${JSON.stringify(vibe)}\n\nPREFERENCE PROFILE:\n${JSON.stringify(prefProfile)}${hasFreeText ? `\n\nFREE TEXT: "${preferences.freeText}"` : ''}\n\nWEB CANDIDATES (15 tracks from Beatport/Traxsource/RA):\n${JSON.stringify(webCandidates)}\n\nNICHE ARTISTS to consider substituting if better fit:\n${nicheArtists.join(', ')}`;

        console.log('[recommend] Agent 10 starting — web candidates:', webCandidates.length, 'niche:', nicheArtists.length);
        const a10Text = await callAnthropicAgent(
            [{ type: 'text', text: a10System, cache_control: { type: 'ephemeral' } }],
            [{ role: 'user', content: a10User }],
            2500, false
        );
        console.log('[recommend] Agent 10 RAW:\n', a10Text);
        let recommendations = parseAgentJSON(a10Text);
        if (!Array.isArray(recommendations) && recommendations && typeof recommendations === 'object') {
            console.log('[recommend] Agent 10 unwrapping — keys:', Object.keys(recommendations));
            const unwrapped = Object.values(recommendations).find(v => Array.isArray(v));
            if (unwrapped) recommendations = unwrapped;
        }
        if (!Array.isArray(recommendations)) recommendations = [];
        console.log('[recommend] Agent 10 done — recommendations:', recommendations.length);

        res.json({ recommendations });
    } catch (err) {
        console.error('[recommend] ✗ error:', err.message, '\n', err.stack);
        res.status(502).json({ error: { message: err.message } });
    }
});

// Claude proxy — non-streaming JSON, web search enabled, niche artists injected (legacy)
app.post('/api/claude', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({
            error: { message: "We have hit today's limit. Check back tomorrow!" }
        });
    }

    // Build system blocks array with prompt caching
    const detectedSubgenres = Array.isArray(req.body.subgenres) ? req.body.subgenres : [];
    const baseSystemText = req.body.system || '';
    let systemBlocks;

    if (detectedSubgenres.length > 0) {
        const bucketKey  = subgenresToBucketKey(detectedSubgenres);
        const artistText = artistTextByBucket[bucketKey] || '';
        if (artistText) {
            const artistCount = Math.min((artistsByBucket[bucketKey] || []).length, 80);
            const nicheBlock  =
                `\n\nNICHE ARTIST REFERENCE — ${bucketKey.replace(/_/g, ' ')} (${artistCount} curated artists):` +
                `\nWeb search is primary. Also consider these niche specialists:\n${artistText}`;
            systemBlocks = [
                { type: 'text', text: baseSystemText },
                { type: 'text', text: nicheBlock, cache_control: { type: 'ephemeral' } },
            ];
            console.log(`[claude] injected ${artistCount} artists for bucket "${bucketKey}" (cached)`);
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
        method: 'POST',
        headers: anthropicHeaders,
        body: JSON.stringify(upstreamBody),
    });

    let upstream;
    try {
        upstream = await callAnthropic();
        // Retry once on rate limit
        if (upstream.status === 429) {
            console.log('[claude] rate limited (429) — retrying in 10s');
            await new Promise(r => setTimeout(r, 10000));
            upstream = await callAnthropic();
        }
    } catch (err) {
        return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}` } });
    }

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
        console.error('[claude] upstream error:', upstream.status, JSON.stringify(data));
        return res.status(upstream.status).json({
            error: data.error || { message: `Upstream error ${upstream.status}` }
        });
    }

    const blocks = data.content || [];
    const blockSummary = blocks.map(b => b.type).join(', ');
    console.log('[claude] stop_reason:', data.stop_reason, '| blocks:', blockSummary);

    const fullText = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

    if (data.usage) {
        const { input_tokens = 0, output_tokens = 0, cache_creation_input_tokens: cacheWrite = 0, cache_read_input_tokens: cacheRead = 0 } = data.usage;
        console.log(`[claude] usage — input:${input_tokens} output:${output_tokens} cache_write:${cacheWrite} cache_read:${cacheRead}`);
    }

    const totalInputChars = JSON.stringify(upstreamBody.system || '').length + JSON.stringify(upstreamBody.messages).length;
    console.log('[claude] total input chars sent to Anthropic:', totalInputChars);
    console.log('[claude] sending content length:', fullText.length, '| preview:', fullText.slice(0, 120));
    res.json({ content: fullText });
});

// Last.fm proxy
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
