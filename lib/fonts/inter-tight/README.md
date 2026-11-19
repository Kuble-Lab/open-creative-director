# Inter Tight (variable font, the axis `wght` 100 to 900, Latin)

- `InterTight-latin-variable.woff2`: the Latin subset of Inter Tight as Google Fonts serves it (the web font of the app).
- `InterTight-latin-variable.ttf`: the same font as TrueType, for the Composer (`lib/composer-render.js`, the default font of its text layers). fontkit cannot make instances of a variable WOFF2 (the weight would be ignored), so the WOFF2 was unpacked to TTF with fonttools: `python3 -c "from fontTools.ttLib import TTFont; f = TTFont('InterTight-latin-variable.woff2'); f.flavor = None; f.save('InterTight-latin-variable.ttf')"`. The outlines and tables are unchanged.
- Licence: SIL Open Font License 1.1 (`OFL.txt`).
