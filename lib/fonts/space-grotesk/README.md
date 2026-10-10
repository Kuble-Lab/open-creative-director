# Space Grotesk (variable font, the axis `wght` 300 to 700)

- Used for: the titles (700) of the event video in the style "launch" (`lib/event-video/`, see `lib/event-video/styles.js`). One file holds every weight; the page asks for the weight with `font-weight`.
- Source: https://github.com/google/fonts, folder `ofl/spacegrotesk` (file `SpaceGrotesk[wght].ttf`, font version 2.000, taken from `main` on 2026-10-10; SHA-256 `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72`). Upstream project: https://github.com/floriankarsten/space-grotesk (the folder was built from its commit `03507d024a01282884232081fc6011c09ff4e849`).
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the same upstream folder). The copyright line names no Reserved Font Name.
- Change: none. The file is the upstream file, only renamed (`SpaceGrotesk-Variable.ttf`). Embedded as base64 it adds about 180 KB to a chunk page of the event video (the render node takes at most 2 MB).
- The widths of the text for the layout (`lib/music-video-hud/metrics.js` familyWidth) are read from this file at the weight (`HVAR`).
