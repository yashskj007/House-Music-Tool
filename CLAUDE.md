# House Music Resonance Engine — Master Project Context
> This file is the single source of truth for Claude Code. Read this at the start of every session before touching any code.

---

## Project Identity
- **Name:** House Music Resonance Engine
- **Repo:** https://github.com/yashskj007/House-Music-Tool
- **Live URL:** https://yashskj007.github.io/House-Music-Tool/ (GitHub Pages — pre-Netlify)
- **Local path:** C:\Users\yash_\vibe-code-tool\index.html
- **Stack:** Single file HTML + CSS + JS + Netlify serverless functions. No framework. No build step.
- **Hosting:** Netlify (migrated from GitHub Pages)
- **APIs used:** Anthropic Claude API (claude-sonnet-4-6), Last.fm API — both via Netlify functions
- **Env vars (set in Netlify dashboard):** `ANTHROPIC_API_KEY`, `LASTFM_API_KEY`
- **Daily request limit:** 200 Claude calls/day tracked in localStorage (`daily_req` key)

---

## Design System (NON-NEGOTIABLE)
- **Background:** #0A0A0F only
- **Accent 1:** #C9A84C (muted gold) — for borders, highlights, left accents
- **Accent 2:** #FFFFFF (white) — for primary text
- **No other colours.** No purple, teal, gradients, glassmorphism
- **Typography:** Uppercase + letter-spacing for labels, generous line-height for body
- **Cards:** Thin 1px borders, no background blocks
- **Feel:** McKinsey premium analytics dashboard — restrained, precise, elegant

---

## Architecture — What Is Built

### Railway Architecture (current)
- `server.js` — Express.js server; serves `index.html` at `/`; POST `/api/claude` proxies to Anthropic API with web search enabled (`web_search_20250305` tool + beta header) and SSE-streams response back; GET `/api/lastfm` proxies Last.fm API; GET `/api/daily-limit` returns in-memory daily usage count; enforces 200 req/day server-side
- `package.json` — dependencies: express, node-fetch@2, cors; start script: `node server.js`
- `ANTHROPIC_API_KEY` and `LASTFM_API_KEY` set as Railway environment variables
- API key input fields removed from UI — keys live server-side only

### Netlify Architecture (legacy — kept for reference)
- `netlify/functions/claude.js` — ESM streaming proxy; web search disabled (free-plan timeout incompatible)
- `netlify/functions/lastfm.js` — Last.fm proxy
- `netlify.toml` — esbuild config

### Input Layer
- Anthropic API key field (password, saved to localStorage)
- Last.fm API key field (saved to localStorage)
- Textarea: 5 songs in "Artist - Song Title" format

### Analysis Layer (fires on "Analyse My Vibe")
1. Last.fm API calls per song: track.getInfo, track.getSimilar, artist.getInfo
2. Claude API call with all Last.fm data + 10-dimension analysis prompt
3. Output: 10-dimension scorecard + Vibe DNA summary paragraph

### 10 Analysis Dimensions
1. Tempo & Rhythm DNA
2. Harmonic Palette
3. Textural Layers
4. Emotional Arc
5. Vocal Character
6. Production Era & Design
7. Geographic & Cultural DNA
8. Cultural & Scene Positioning
9. Listener Profile (enriched with Last.fm data)
10. Dancefloor Function
11. Instrumentation (NEW — see below)

### Preference Layer (5 sliders + free text, fires on "Find My Resonance")
1. **Groove Architecture** — Locked/driving (1) → Swung/syncopated/percussive (7)
2. **Production Texture** — Warm/raw/organic/analog (1) → Clean/bright/polished/surgical (7)
3. **Harmonic Depth** — Hypnotic/minimal/repetitive (1) → Melodic/harmonic/emotionally lifted (7)
4. **Structural Payoff** — Steady groove throughout (1) → Strong build/breakdown/release arc (7)
5. **Discovery Mode** — Trusted artist/label/scene (1) → Unfamiliar but sonically right (7)
- Each slider normalised to [-1, +1] and passed as Weight B to recommendation prompt
- **"Describe Your Moment"** free text field (optional) — when filled, activates Weight C (30%)

### Weighted Scoring System
- **Weight A** — 10-Dimension Analysis: 57% (no free text) / 40% (with free text)
- **Weight B** — 5 Slider Calibration: 43% (no free text) / 30% (with free text)
- **Weight C** — Free Text Description: 0% (absent) / 30% (when user types something)
- Claude scores each candidate across all active weights; each song card shows a `weightMatch` explanation

### Recommendation Layer — Single Call Architecture
**Single call** (web search enabled):
- Web search tool enabled; draws holistically from ARTIST_UNIVERSE + Last.fm signals + live web search
- 120s timeout, 3,000 max tokens
- Returns 6–8 weighted recommendations; best sonic match wins regardless of source
- All cards identical — no source labels or Fresh Discovery labels
- Cycling loader: "Analysing your vibe DNA…" → "Searching the music universe…" → "Calibrating recommendations…" → "Almost there…" (8s per message)
- Timeout error: "Taking longer than expected. Please try again."

**Song card fields:** title · artist · subgenre tag · scene/era · instruments · weightMatch · why · YouTube + Spotify + Last.fm links

---

## Artist Universe (fully built)
All three prompt upgrades are complete. The recommendation prompt draws from a structured artist universe of **1,771 priority artists** (seed_priority 1 or 2) extracted from `context/house_artist_roster_v3_merged_longtail.csv` (3,037 total artists).

The priority universe is pre-processed into `context/artist-reference.md` and embedded directly in the `ARTIST_UNIVERSE` JS constant in `index.html`. Buckets:

| Bucket | Artists |
|--------|---------|
| Priority Must-Include | 6 |
| Current Chart Leaders | 117 |
| Afro / Organic / Global House | 279 |
| Tech House / Minimal / Deep Tech | 385 |
| Melodic / Progressive House | 324 |
| Classic / Deep / Soulful House | 237 |
| Classic / Ibiza / European House & Tech | 71 |
| Disco / Nu-Disco / Balearic House | 122 |
| UK Garage / Bassline / UK House | 117 |
| Latin / Brazilian / Iberian House | 88 |
| South African House / Afro Tech / Amapiano | 24 |
| Lo-Fi / Leftfield / Underground House | 1 |

To regenerate `artist-reference.md` after CSV changes, run the extraction script in the session log.

---

## Context Files (in /context folder)
- `context/house_artist_roster_v3_merged_longtail.csv` — 3,037 House artists with subgenre buckets and seed_priority scores (1–5)
- `context/artist-reference.md` — **Pre-processed reference**: priority 1+2 artists grouped by bucket. Used as the `ARTIST_UNIVERSE` constant in `index.html`.
- `context/Questions for the House music listeners.docx` — 5 preference question designs with model feed instructions
- `context/Vibe Code Recommender Schema for Music Preference.docx` — Full music feature analysis framework
- `context/artist_universe_raw.txt` — Raw 1,771 priority artists as comma-separated text for embedding in prompts

---

## Standing Instructions
> These rules apply at the end of **every** Claude Code session, without exception.

1. **Update the Session Log** — Before committing, add a row to the Session Log table describing what was built or changed this session.
2. **Record new design decisions** — If any new design choices were made (colours, layout, component patterns), add them to the Design System section.
3. **Register new files** — If any new files were created, add them to the Context Files table with a one-line description.
4. **Mark completed features** — If any planned features were finished, mark them as done wherever they are tracked in this file.
5. **Always commit CLAUDE.md** — Include CLAUDE.md in every `git push`, even if the only change is the Session Log row.

---

## Git Workflow
After every Claude Code session:
```
git add .
git commit -m "description"
git push
```
Site updates at live URL within 60 seconds.

---

## Session Log
| Date | What was done |
|------|--------------|
| Day 1 | Initial HTML app built — song input, API call, basic analysis |
| Day 2 | Last.fm integration + 10-dimension analysis + Vibe DNA summary |
| Day 3 | Premium UI redesign — dark #0A0A0F, gold #C9A84C, consulting aesthetic |
| Day 4 | Prompt 2: 12-instrument profile table + 5 calibrated sliders (1–7) |
| Day 5 | Prompt 3: 44-subgenre taxonomy + tiered artist universe + enhanced song cards |
| Day 6 | CSV extraction: 1,771 priority artists → artist-reference.md → ARTIST_UNIVERSE constant in index.html |
| Day 7 | Triple-source recommendations built: CSV artist universe + Last.fm similar artists + Claude web search; findSongs uses 2+2+2 blend; web search tool enabled with anthropic-beta header |
| Day 8 | Fix: parseJSON now strips markdown fences + prefers outermost object (fixes dimension dashes bug); callAPI gets AbortController with configurable timeout (120s for findSongs); slider descriptions added; 2+2+2 quota removed in favour of best-fit selection rule |
| Day 9 | Two-stage findSongs: fast call (30s, no web search) → escalates to web search (180s) only on timeout; compact artist list strips section headers at runtime for smaller fast prompt; "Searching music universe…" → "Expanding with live web search…" status messages; ARTIST_UNIVERSE footer removed |
| Day 10 | UPGRADE 1: Free text "Describe Your Moment" textarea added before Find My Resonance button. UPGRADE 2: Weighted recommendation engine — 40/30/30 (with free text) or 57/43 (without); weightMatch field per song card. UPGRADE 3: Single call always-web-search with 180s timeout, max 2 web searches, 4-message cycling loader every 8s, specific timeout error message |
| Day 11 | Two-call architecture: CALL 1 (no web search, 60s timeout) returns 6 songs immediately; CALL 2 (background, web search, 120s) appends 1-2 "Fresh Discovery" cards with divider. Failures in CALL 2 are silent. |
| Day 12 | Replaced 5 sliders with 5 labeled option questions (5 cards each, 1–5 value). Questions: Beat Feel, Sound Texture, Emotion vs Hypnosis, Track Journey, Discovery Style. Button hidden until all 5 answered with progress indicator. Norm formula updated to (v-3)/2 for [-1,+1] range. Weight B prompt updated with new dimension keys. |
| Day 13 | FIX 2: YouTube links → music.youtube.com/search, Spotify → /tracks tab, added Last.fm direct song page button. FIX 3: Anti-hallucination CRITICAL block added to CALL 1 and CALL 2 prompts; "Verify on streaming platforms" disclaimer added to every song card. |
| Day 14 | Replaced two-call architecture with single call: web search enabled, 120s timeout, 3,000 max tokens, 6–8 results, all sources holistic, no source labels on cards, "Taking longer than expected. Please try again." on timeout. |
| Day 15 | Netlify migration: created netlify/functions/claude.js and lastfm.js proxies, netlify.toml config. Removed API key input fields from UI. All API calls route through /.netlify/functions/. 200 req/day limit via localStorage. |
| Day 16 | Fix 504: claude.js rewritten as ESM streaming function — pipes Anthropic SSE via TransformStream to browser, path /api/claude. callAPI in index.html updated to read SSE stream (text_delta events). Web search removed (incompatible with free plan). max_tokens 2000. |
| Day 17 | Debug blank results: added console.log in claude.js and callAPI/parseJSON, SSE error-event handling, buffer flush after stream end, JSON content-type fallback in callAPI, null guards in renderResults/renderDimensions. |
| Day 18 | Fix parseJSON: capturing-group regex extracts inner content from ```json...``` fences cleanly; fallback strip/raw/brace/array strategies unchanged. Added console.log in analyseVibe after parseJSON to confirm renderResults/renderDimensions receive valid parsed object. |
| Day 19 | Fix parseJSON bracket-scanner: guarded lastIndexOf('[') fallback so it only runs when array precedes any object in the text — prevents recommendations sub-array being returned as vibe object when analyseVibe JSON is truncated (was causing Array(3) \| vibeName: undefined). Fix findSongs/renderSongs field name mismatch: renamed s.prefMatches → s.dimensionMatches to match the prompt's dimensionMatches field. |
| Day 20 | Railway backend: created server.js (Express, node-fetch@2, cors) + package.json. Routes: POST /api/claude (SSE stream, web search enabled), GET /api/lastfm, GET /api/daily-limit (in-memory 200/day server-side limit). Updated index.html Last.fm calls from /.netlify/functions/lastfm → /api/lastfm. Updated CLAUDE.md architecture section. |
| Day 21 | Fix "Unexpected response format": server.js /api/claude switched from SSE streaming to non-streaming — awaits full Anthropic response, extracts text content blocks, returns res.json({content: fullText}). callAPI in index.html simplified to res.json() + data.content. Web search tool kept enabled. |
| Day 22 | Fix token limit: removed ARTIST_UNIVERSE constant from index.html (252 lines). server.js now loads CSV at startup, parses into bucket groups, maps detected subgenres to best bucket, injects up to 100 niche artists into system prompt per request. Web search stays primary; CSV artists are a niche fallback with explicit instruction. callAPI gains extraBody param; findSongs passes subgenres. |
| Day 23 | Verified ARTIST_UNIVERSE gone from index.html and CSV injection working in server.js. Added 429 rate-limit retry: server waits 10s and retries the Anthropic call once before returning error to client. |
| Day 24 | Fix "Unexpected response format": format confirmed consistent ({content: string} both sides). Root cause: web search causes Claude to wrap array in object (e.g. {"recommendations":[...]}). Fix: findSongs unwraps object-wrapped arrays before type check. server.js: added detailed logging of Anthropic block types and outgoing payload. |
| Day 25 | Prompt size reduction to fix 30k token rate limit. analyseVibe prompt trimmed to ~2,700 chars (system + user + dynamic): shorter system, compact JSON template, shorter instrument names, removed playcount from lfmContext, shorter lfmContext header. findSongs: subgenres list trimmed, similar artists capped at 5 per artist in lfmBlock. server.js: artist injection reduced to 80 matched-subgenre-only artists (removed chart leaders padding). Added console.log of prompt char counts in both functions and server-side total input chars log. |
| Day 26 | Prompt caching: server.js pre-generates artistTextByBucket plain-text strings at startup. /api/claude now sends system as array of content blocks — base system + artist niche block each with cache_control:{type:"ephemeral"}. Beta header updated to include prompt-caching-2024-07-31. Added usage logging (input_tokens, output_tokens, cache_write, cache_read). Fixed totalInputChars log to JSON.stringify array. Note: caching activates only when system blocks exceed 2048 tokens (Sonnet 4.6 minimum); watch for cache_write>0 in logs. |
| Day 27 | 4-agent pipeline: server.js adds parseAgentJSON + callAnthropicAgent helpers, POST /api/analyse (Agent 1 proxy, no web search), POST /api/recommend (orchestrates Agents 2+3+4 sequentially). Agent 2: preference interpreter (500 tokens, no web search). Agent 3: artist scout (2000 tokens, web search + CSV injection). Agent 4: recommendation synthesiser (2000 tokens, scores candidates from Agent 3). index.html: callAPI gains endpoint param; analyseVibe routes to /api/analyse; findSongs replaced with direct fetch to /api/recommend sending structured {vibe, preferences, lfmSimilar}. Loading messages updated: "Reading your preferences…" → "Scouting artists…" → "Building your playlist…". |
| Day 28 | 10-agent pipeline: /api/analyse now runs Agents 1-5 in parallel (round-robin song distribution, 400 tok/song each, shared cached system prompt) then Agent 6 (vibe synthesiser, 1500 tok). /api/recommend runs Agents 7 (preference interpreter, 400 tok) + Agent 8 (web scout Beatport/Traxsource/RA, 2000 tok, web search) + Agent 9 (pure JS CSV matcher, 0 tokens, top 40 artists) in parallel, then Agent 10 (recommendation engine, 2500 tok, 8 tracks). getNicheArtists() helper added. index.html: label updated to 5-10 tracks; validation changed to min 5 max 10; analyseVibe rewritten as direct fetch sending songs array with lfmTags; cycling loader shows "Decoding Track N…" per track then "Synthesising your DNA…"; renderResults simplified (dominant_subgenres, clubScene only); renderDimensions handles d.name lookup; DIMENSION_META gains name field; renderSongs handles instruments array, scene field, direct youtube_url/spotify_url/lastfm_url, removes disclaimer; findSongs drops lfmSimilar from request. |
| Day 29 | Prompt caching fix: Agent 10 system prompt was not caching because dynamic weightsLine was embedded via template literal, producing two system variants. Fixed by making a10System fully static (generic "scoring weights specified below" language) and moving weightsLine into a10User as "SCORING WEIGHTS: ..." prefix — now the system is identical on every request and will cache after first call. |
| Day 30 | Split-agent waterfall pipeline: replaced parallel Promise.all architecture with sequential SSE-streaming waterfall. server.js: new callAgent() helper (string prompts → parsed JSON, 15s 429 retry), new delay(), unwrapArray(). /api/analyse now SSE-streams: Agents 1-N (sequential track decoders, 1500ms gaps, 250 tok each) + Agent 6 (vibe synthesiser, 1000 tok, 2000ms gap). /api/recommend now SSE-streams: Agent 7 (prefs, 250 tok) → Agent 8 (Beatport scout, web search, 600 tok, 2s gap) → Agent 9 (Traxsource, web search, 600 tok, 5s gap) → Agent 10 (RA, web search, 600 tok, 5s gap) → Agent 11 (pure JS CSV, 0 tok) → Agent 12 (pre-scorer, 800 tok, 2s gap) → Agent 13 (final builder, 1800 tok, 2s gap). index.html: vertical pipeline timeline (tl-step CSS: pending/active/done/error states with gold checkmark on done); initTimeline() + appendTimelineSteps() + updateTimelineStep() + readSSE() helpers; analyseVibe() reads SSE stream and updates timeline in real time; findSongs() appends 7 recommend steps to existing timeline. Peak rate: ~5000 tok/min (web scout gaps prevent rate limit). |
