# DM Sans (variable font, the axes `opsz` 9 to 40 and `wght` 100 to 1000)

- Used for: the titles (700) and the texts (400) of the event video in the style "workshop" (`lib/event-video/`, see `lib/event-video/styles.js`). One file holds every weight; the page asks for the weight with `font-weight`, and the browser sets the optical size to the size of the text (`font-optical-sizing: auto`).
- Source: https://github.com/google/fonts, folder `ofl/dmsans` (file `DMSans[opsz,wght].ttf`, font version 4.004, taken from `main` on 2026-10-10; SHA-256 `8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d`). Upstream project: https://github.com/googlefonts/dm-fonts (the folder was built from its commit `d0520ba03bd780f5dccb3024854463d44f699b78`).
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the same upstream folder). The copyright line names no Reserved Font Name.
- Change: none. The file is the upstream file, only renamed (`DMSans-Variable.ttf`). Embedded as base64 it adds about 320 KB to a chunk page of the event video (the render node takes at most 2 MB).
- The widths of the text for the layout (`lib/music-video-hud/metrics.js` familyWidth) are read from this file at the weight and at the optical size of the text (`HVAR`).
