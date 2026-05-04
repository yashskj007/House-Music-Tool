# House Music Resonance Engine — Master Project Context
> This file is the single source of truth for Claude Code. Read this at the start of every session before touching any code.

---

## Project Identity
- **Name:** House Music Resonance Engine
- **Repo:** https://github.com/yashskj007/House-Music-Tool
- **Live URL:** https://yashskj007.github.io/House-Music-Tool/
- **Local path:** C:\Users\yash_\vibe-code-tool\index.html
- **Stack:** Single file HTML + CSS + JS. No framework. No build step.
- **APIs used:** Anthropic Claude API (claude-sonnet-4-20250514), Last.fm API
- **Last.fm API key:** 9c2d6e5ab0f2299576d23f9187c3e948

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

### Recommendation Layer — Two-Call Architecture
**CALL 1** (fast, always runs):
- No web search; uses ARTIST_UNIVERSE (compact, headers stripped at runtime) + Last.fm signals
- 60s timeout, 3,200 max tokens
- Returns exactly 6 weighted recommendations; shown immediately on success
- Cycling loader: "Analysing your vibe DNA…" → "Searching the music universe…" → "Calibrating recommendations…" → "Almost there…" (8s per message)

**CALL 2** (background, runs after CALL 1):
- Web search enabled (1 search), 120s timeout, 1,500 max tokens
- Returns 1–2 fresh discoveries not in the CALL 1 set
- Appended as "✦ Fresh Discovery" cards with a section divider
- Silent fail — user already has CALL 1 results if CALL 2 times out or errors

**Song card fields:** title · artist · subgenre tag · scene/era · instruments · weightMatch · why · YouTube + Spotify links

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
