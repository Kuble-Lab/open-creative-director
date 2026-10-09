# JetBrains Mono (Medium and Bold)

- Used for: the labels, tables, tags, terminals, the title tiles and the ticker of the music video HUD (`lib/music-video-hud/`).
- Source: https://github.com/JetBrains/JetBrainsMono, `fonts/ttf/JetBrainsMono-Bold.ttf` and `JetBrainsMono-Medium.ttf` (font version 2.305, last changed upstream in commit `02bb50b082dad9ef8a0f33ac393839202b760223`; taken from the `master` branch on 2026-10-08, the latest release tag is v2.304).
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the root of the same repository). The copyright line names no Reserved Font Name.
- Change: the files are subsets (same character set as `lib/fonts/anton`). The layout tables (GSUB, GPOS) are removed on purpose: without them the programming ligatures (`->`, `==`) cannot appear in the HUD texts. Made with `node scripts/subset-font.js <original.ttf> lib/fonts/jetbrains-mono/JetBrainsMono-Bold.ttf` (and the same for Medium).
