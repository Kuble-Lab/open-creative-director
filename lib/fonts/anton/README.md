# Anton

- Used for: the big words, counters and clocks of the music video HUD (`lib/music-video-hud/`).
- Source: https://github.com/google/fonts, folder `ofl/anton` (file `Anton-Regular.ttf`, font version 2.116, last changed upstream in commit `e0a8124cf36bb7c32ca68e5d46d6acdbc3df866a`; checked against `main` on 2026-10-08).
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the same upstream folder). The copyright line names no Reserved Font Name.
- Change: the file is a subset. Only Basic Latin, Latin-1 Supplement, Latin Extended-A, general punctuation and the signs the HUD draws (`×`, `·`, `°`, `▼`, `●`, `—`, `’` and a few more) are kept; the outlines of every other glyph are removed and the layout tables (kerning) are kept. Made with `node scripts/subset-font.js <original.ttf> lib/fonts/anton/Anton-Regular.ttf --keep-layout`. Only done to keep the embedded font small: the render node takes at most 2 MB of HTML per chunk.
