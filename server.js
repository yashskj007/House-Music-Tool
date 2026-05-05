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

// Claude proxy — non-streaming JSON, web search enabled, niche artists injected
app.post('/api/claude', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({
            error: { message: "We have hit today's limit. Check back tomorrow!" }
        });
    }

    // Inject niche artist reference into system prompt when subgenres are provided
    const detectedSubgenres = Array.isArray(req.body.subgenres) ? req.body.subgenres : [];
    let systemPrompt = req.body.system || '';

    if (detectedSubgenres.length > 0) {
        const bucketKey  = subgenresToBucketKey(detectedSubgenres);
        const niche      = (artistsByBucket[bucketKey] || []).slice(0, 80);

        if (niche.length > 0) {
            systemPrompt +=
                `\n\nNICHE ARTIST REFERENCE — ${bucketKey.replace(/_/g, ' ')} (${niche.length} curated artists):` +
                `\nWeb search is primary. Also consider these niche specialists:` +
                `\n${niche.join(', ')}`;
            console.log(`[claude] injected ${niche.length} artists for bucket "${bucketKey}"`);
        }
    }

    const upstreamBody = {
        model:      req.body.model || 'claude-sonnet-4-6',
        max_tokens: req.body.max_tokens || 2000,
        system:     systemPrompt,
        messages:   req.body.messages,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    };

    const anthropicHeaders = {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'web-search-2025-03-05',
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

    const totalInputChars = (upstreamBody.system || '').length + JSON.stringify(upstreamBody.messages).length;
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
