const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// In-memory daily usage tracker (resets automatically each new UTC day)
let dailyUsage = { date: '', count: 0 };

function getTodayStr() {
    return new Date().toISOString().slice(0, 10);
}

function checkAndIncrement() {
    const today = getTodayStr();
    if (dailyUsage.date !== today) dailyUsage = { date: today, count: 0 };
    if (dailyUsage.count >= 200) return false;
    dailyUsage.count++;
    return true;
}

// Serve index.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Daily limit status
app.get('/api/daily-limit', (req, res) => {
    const today = getTodayStr();
    if (dailyUsage.date !== today) dailyUsage = { date: today, count: 0 };
    res.json({ date: dailyUsage.date, count: dailyUsage.count, limit: 200 });
});

// Claude proxy — awaits full response and returns JSON, web search enabled
app.post('/api/claude', async (req, res) => {
    if (!checkAndIncrement()) {
        return res.status(429).json({
            error: { message: "We have hit today's limit. Check back tomorrow!" }
        });
    }

    const upstreamBody = {
        model: req.body.model || 'claude-sonnet-4-6',
        max_tokens: req.body.max_tokens || 2000,
        system: req.body.system,
        messages: req.body.messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    };

    let upstream;
    try {
        upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'web-search-2025-03-05',
            },
            body: JSON.stringify(upstreamBody),
        });
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

    const fullText = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

    console.log('[claude] response length:', fullText.length, '| stop_reason:', data.stop_reason);
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

app.listen(PORT, () => {
    console.log(`House Music Resonance Engine running on port ${PORT}`);
});
