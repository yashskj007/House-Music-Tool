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

## What Is NOT Yet Built (remaining work)
- [ ] Instrument analysis dimension (Prompt 2)
- [ ] 5 slider preference questions replacing old 4 button questions (Prompt 2)
- [ ] Full House subgenre taxonomy in recommendation prompt (Prompt 3)
- [ ] Full artist universe from CSV embedded in prompt (Prompt 3)

---

## Context Files (in /context folder)
- `context/artists.csv` — 3,037 House artists with subgenre buckets and scene depth scores
- `context/schema.docx` — Full music feature analysis framework
- `context/questions.docx` — 5 preference question designs with model feed instructions

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
| Next | Prompt 2: instruments + 5 sliders |
| Next | Prompt 3: full subgenre taxonomy + full artist universe |
