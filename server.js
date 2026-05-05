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

// Agent 1 proxy — no web search, no artist injection
app.post('/api/analyse', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }
    try {
        const systemBlocks = [{ type: 'text', text: req.body.system || '', cache_control: { type: 'ephemeral' } }];
        console.log('[analyse] calling Anthropic — system chars:', (req.body.system || '').length, 'messages:', req.body.messages?.length);
        const text = await callAnthropicAgent(systemBlocks, req.body.messages, req.body.max_tokens || 1500, false);
        console.log('[analyse] ✓ response length:', text.length);
        res.json({ content: text });
    } catch (err) {
        console.error('[analyse] ✗ error:', err.message, '\n', err.stack);
        res.status(502).json({ error: { message: err.message } });
    }
});

// Recommendation pipeline — Agent 2 (preferences) → Agent 3 (scout) → Agent 4 (synthesise)
app.post('/api/recommend', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({ error: { message: "We have hit today's limit. Check back tomorrow!" } });
    }

    const { vibe = {}, preferences = {}, lfmSimilar = [] } = req.body;
    const hasFreeText = Boolean(preferences.freeText && preferences.freeText.trim());

    try {
        // ── Agent 2: Preference Interpreter ─────────────────────────────
        const a2System = `You are a music taste interpreter. Convert these preference scores (1–5, 3=neutral) and optional description into a compact sonic preference profile. Return ONLY valid JSON: {"groove_preference":"string","texture_preference":"string","harmony_preference":"string","structure_preference":"string","discovery_preference":"string","free_text_keywords":[],"overall_vibe_direction":"string"}`;
        const a2User   = JSON.stringify({
            beat_feel:        preferences.beat_feel,
            sound_texture:    preferences.sound_texture,
            emotion_hypnosis: preferences.emotion_hypnosis,
            track_journey:    preferences.track_journey,
            discovery_style:  preferences.discovery_style,
            freeText:         preferences.freeText || '',
        });
        console.log('[recommend] Agent 2 starting — user input:', a2User);
        const a2Text    = await callAnthropicAgent(
            [{ type: 'text', text: a2System, cache_control: { type: 'ephemeral' } }],
            [{ role: 'user', content: a2User }],
            500, false
        );
        console.log('[recommend] Agent 2 RAW:\n', a2Text);
        const prefProfile = parseAgentJSON(a2Text) || {};
        console.log('[recommend] Agent 2 parsed:', JSON.stringify(prefProfile));

        // ── Agent 3: Artist Scout (web search + CSV injection) ───────────
        const bucketKey   = subgenresToBucketKey(vibe.subgenres || []);
        const artistText  = artistTextByBucket[bucketKey] || '';
        const artistCount = Math.min((artistsByBucket[bucketKey] || []).length, 80);
        const a3BaseText  = `You are a House music scout. Given these detected subgenres, preference profile, and niche artist reference, find 15–20 candidate tracks. Use web search to find current and recent releases. Include underground and emerging artists — do not default to famous names only. Return ONLY valid JSON array: [{"artist":"","track":"","subgenre":"","why_it_fits":""}]`;
        const a3SystemBlocks = artistText
            ? [
                { type: 'text', text: a3BaseText },
                { type: 'text', text: `\n\nNICHE ARTIST REFERENCE — ${bucketKey.replace(/_/g, ' ')} (${artistCount} curated artists):\nAlso consider these niche specialists:\n${artistText}`, cache_control: { type: 'ephemeral' } },
              ]
            : [{ type: 'text', text: a3BaseText, cache_control: { type: 'ephemeral' } }];

        const lfmLines = [];
        if (lfmSimilar.length) {
            lfmLines.push('Last.fm similar artists:');
            lfmSimilar.forEach(s => lfmLines.push(`  ${s.artist} → ${(s.similar || []).slice(0, 5).join(', ')}`));
        }
        const a3User = `Detected subgenres: ${(vibe.subgenres || []).join(', ')}
Vibe: ${vibe.vibeDNA || ''}
Preference direction: ${prefProfile.overall_vibe_direction || ''}${lfmLines.length ? '\n\n' + lfmLines.join('\n') : ''}`;

        console.log('[recommend] Agent 3 starting — bucket:', bucketKey, 'artists injected:', artistCount, '\nuser prompt:\n', a3User);
        const a3Text = await callAnthropicAgent(a3SystemBlocks, [{ role: 'user', content: a3User }], 2000, true);
        console.log('[recommend] Agent 3 RAW:\n', a3Text);
        let candidates = parseAgentJSON(a3Text);
        if (!Array.isArray(candidates) && candidates && typeof candidates === 'object') {
            console.log('[recommend] Agent 3 unwrapping object — keys:', Object.keys(candidates));
            const unwrapped = Object.values(candidates).find(v => Array.isArray(v));
            if (unwrapped) candidates = unwrapped;
        }
        if (!Array.isArray(candidates)) candidates = [];
        console.log('[recommend] Agent 3 parsed — candidates:', candidates.length);

        // ── Agent 4: Recommendation Synthesiser ─────────────────────────
        const weightsLine = hasFreeText
            ? 'Weight A (vibe DNA): 40% · Weight B (preference profile): 30% · Weight C (free text): 30%'
            : 'Weight A (vibe DNA): 57% · Weight B (preference profile): 43%';
        const dimSummary   = (vibe.dimensions || []).map(d => `${d.id}: ${d.value}`).join('\n');
        const instrSummary = (vibe.instrumentProfile || [])
            .filter(i => i.prominence && i.prominence !== 'None')
            .map(i => `${i.name}: ${i.prominence}`)
            .join(', ');

        const a4System = `You are a music recommendation engine. Score each candidate track against the weights below and select the 6–8 highest-scoring tracks. CRITICAL: Only recommend tracks you are highly confident exist as real released songs — if unsure of a title, use that artist's most well-known confirmed track. Return ONLY valid JSON array: [{"title":"","artist":"","subgenre":"","sceneEra":"","instrumentMatch":"","weightMatch":"","why":"two sentences: first connects dominant dimension matches, second explains preference fit","dimensionMatches":[]}]`;
        const a4User = `SCORING WEIGHTS: ${weightsLine}

WEIGHT A — VIBE DNA:
${vibe.vibeDNA || ''}
Subgenres: ${(vibe.subgenres || []).join(', ')}
Energy: ${vibe.energyLevel || ''} · BPM: ${vibe.bpmRange || ''}
Dimensions:
${dimSummary}
Instrumentation: ${instrSummary || 'not available'}

WEIGHT B — PREFERENCE PROFILE:
${JSON.stringify(prefProfile)}
${hasFreeText ? `\nWEIGHT C — FREE TEXT: "${preferences.freeText}"` : ''}
CANDIDATES:
${JSON.stringify(candidates)}`;

        console.log('[recommend] Agent 4 starting — candidates:', candidates.length);
        const a4Text = await callAnthropicAgent(
            [{ type: 'text', text: a4System, cache_control: { type: 'ephemeral' } }],
            [{ role: 'user', content: a4User }],
            2000, false
        );
        console.log('[recommend] Agent 4 RAW:\n', a4Text);
        let recommendations = parseAgentJSON(a4Text);
        if (!Array.isArray(recommendations) && recommendations && typeof recommendations === 'object') {
            console.log('[recommend] Agent 4 unwrapping object — keys:', Object.keys(recommendations));
            const unwrapped = Object.values(recommendations).find(v => Array.isArray(v));
            if (unwrapped) recommendations = unwrapped;
        }
        if (!Array.isArray(recommendations)) recommendations = [];
        console.log('[recommend] Agent 4 parsed — recommendations:', recommendations.length);

        res.json({ preferenceProfile: prefProfile, recommendations });
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
