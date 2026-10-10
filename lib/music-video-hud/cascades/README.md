# Cascades of pico (WP51)

The trained files of the face finder in `../faces.js` (where the face is under the tags of the HUD):

| File | What | Source | SHA-256 |
| --- | --- | --- | --- |
| `facefinder.bin` | upright faces (468 trees of depth 6) | [nenadmarkus/pico](https://github.com/nenadmarkus/pico), `rnt/cascades/facefinder` at commit `c2e81f9d23cc11d1a612fd21e4f9de0921a5d0d9` | `d8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd` |
| `puploc.bin` | the pupils (5 stages of 20 trees of depth 10) | the demo of lploc.js by the same author ([nenadmarkus/picojs](https://github.com/nenadmarkus/picojs), [puploc-with-trees](https://nenadmarkus.com/p/puploc-with-trees)), `https://drone.nenadmarkus.com/data/blog-stuff/puploc.bin` | `aa01adf34e5af6ed333be75e934275fc39fba2b63790cb340353b2d459c96ccc` |

The code that reads them (`unpackCascade`, `classify`, `runCascade`, `clusterFinds`, `unpackLocalizer`, `localize` in `../faces.js`) is pico.js and lploc.js
rewritten (no random numbers: the moved windows of the pupil search are a fixed sequence). The files are unchanged. pico, pico.js and lploc.js are
released under the MIT licence:

```
The MIT License

Copyright (c) 2013 Nenad Markus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
