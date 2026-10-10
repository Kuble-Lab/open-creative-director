# Playfair Display Italic (variable font, the axis `wght` 400 to 900)

- Used for: the italic titles of the event video in the style "celebration" (600) and in the moods "emotional" (500) and "elegant" (600) (`lib/event-video/`, see `lib/event-video/styles.js`). One file holds every weight; the page asks for the weight with `font-weight`.
- Source: https://github.com/google/fonts, folder `ofl/playfairdisplay` (file `PlayfairDisplay-Italic[wght].ttf`, font version 1.203, taken from `main` on 2026-10-10; SHA-256 `a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b`). Upstream project: https://github.com/clauseggers/Playfair (the folder was built from its commit `80a334101928546b04fa9e709ad4b2f11f8a9e10`).
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the same upstream folder). The copyright line names the Reserved Font Name "Playfair Display".
- Change: none, on purpose. Because of the Reserved Font Name a changed file (a subset, as for the HUD fonts) could not keep the name "Playfair Display"; the file is the upstream file, only renamed (`PlayfairDisplay-Italic-Variable.ttf`). Embedded as base64 it adds about 370 KB to a chunk page of the event video (the render node takes at most 2 MB).
- The widths of the text for the layout (`lib/music-video-hud/metrics.js` familyWidth) are read from this file at the weight (`HVAR`).
