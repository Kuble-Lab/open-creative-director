# Instrument Serif Italic

- Used for: the quiet lines of the music video HUD (one word in the accent colour) (`lib/music-video-hud/`).
- Source: https://github.com/google/fonts, folder `ofl/instrumentserif` (file `InstrumentSerif-Italic.ttf`, font version 1.000, last changed upstream in commit `5e0122a40050ed2cc20e9d5c387d19dd13c6c69f`; checked against `main` on 2026-10-08). Upstream project: https://github.com/Instrument/instrument-serif
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the same upstream folder). The copyright line names no Reserved Font Name.
- Change: the file is a subset (same character set as `lib/fonts/anton`), the layout tables (kerning) are kept. Made with `node scripts/subset-font.js <original.ttf> lib/fonts/instrument-serif/InstrumentSerif-Italic.ttf --keep-layout`.
