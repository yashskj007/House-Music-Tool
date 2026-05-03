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

### Preference Layer (5 sliders, range 1-7)
1. **Groove Architecture** — Locked/driving (1) → Swung/syncopated/percussive (7)
2. **Production Texture** — Warm/raw/organic/analog (1) → Clean/bright/polished/surgical (7)
3. **Harmonic Depth** — Hypnotic/minimal/repetitive (1) → Melodic/harmonic/emotionally lifted (7)
4. **Structural Payoff** — Steady groove throughout (1) → Strong build/breakdown/release arc (7)
5. **Discovery Mode** — Trusted artist/label/scene (1) → Unfamiliar but sonically right (7)
- Each slider normalised to [-1, +1] before passing to recommendation prompt

### Recommendation Layer (fires on "Find My Songs")
- 6-8 songs recommended
- Each card: title, artist, subgenre, instrument profile, why it matches, YouTube link, Spotify link
- Must include artists from ALL tiers — not just top 40-50 famous names

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
