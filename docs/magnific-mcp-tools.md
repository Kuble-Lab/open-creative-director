# Magnific MCP: live schema snapshot (2026-10-22)

Read from `https://mcp.magnific.com` with a connected Premium+ account. Only the tools and fields the app uses are listed.
The app validates every call against the live `tools/list` schema again, so a change on Magnific's side fails before
any spend instead of sending a wrong request.

## Upload and results

| Tool | Arguments | Answer |
| --- | --- | --- |
| `creations_request_upload` | `mimeType` (required; jpeg, png, svg, webp, mp4, quicktime, webm, wav, mpeg, mp4 audio, ogg, flac — no GIF) | JSON: `proxyUploadUrl`, `path`, `mimeType`, `expiresAt` |
| PUT `proxyUploadUrl` | raw bytes, `Content-Type` = the MIME type | 2xx; a second PUT to the same URL is rate limited |
| `creations_finalize_upload` | `fileName` (required), `path`, `visible` (false keeps it out of the library) | the new creation (`identifier`) |
| `creations_wait` | `identifiers` (1–8), `timeoutSeconds` (0–55) | JSON: `results[] { identifier, status, results { url, thumbnailUrl } }`, `allTerminal` |
| `creation_status` | `creationIdentifier` | JSON: `{ creationIdentifier, status, tool, results { url } }` |
| `creations_get` | `creationIdentifier` or `identifiers` | indented `key: value` listing, not JSON (`url`, `previewUrl`, `status`) |
| `simulate_cost` | `tool`, `arguments` | JSON: `{ credits, isUnlimited, certainty }` |
| `images_upscale_modes_list` | — | indented listing (modes `creative`, `ultra-sublime` 2–16x; `ultra-photo`, `ultra-denoiser`, `ultra` 2x only) |

Status values seen: `completed`; in progress entries carry `poll_after_seconds`. Some answers are not JSON, so the app
reads identifiers, status and URLs from both forms.

## Tools behind the nodes

All take the session asset as `creationIdentifier` (audio: `audioUrl`, which accepts a creation identifier).

| Node | Tool | Arguments the node sets |
| --- | --- | --- |
| Magnific Upscale | `images_upscale` | `mode`, `scale` (`"2x"` … `"16x"`) |
| Remove Background | `images_remove_background` | — |
| Replace Background | `images_replace_background` | `prompt` and/or `backgroundCreationIdentifier` |
| Relight | `images_relight` | `lights[1] { azimuth, elevation, intensity, type, color }`, `resolution` |
| Expand | `images_expand` | `aspectRatio`, `prompt`, `mode` (ideogram, flux, classic) |
| Reimagine | `images_reimagine` | `prompt`, `strength` (0–1), `mode` (flux, fast, imagen-nano-banana) |
| Change Camera | `images_change_camera` | `rotate` (0–360), `vertical` (−30–90), `closeup` (0–10) |
| Skin Enhancer | `images_skin_enhancer` | `version`, `sharpen`, `smartGrain` |
| Restyle | `images_restyle` | `styleCreationIdentifier` |
| Vectorize | `images_to_svg` | — |
| Video Upscale | `video_upscale` | `mode` (magnific, magnific_precision), `targetResolution` (640–3840) |
| Video HDR | `video_hdr` | — |
| Video Remove Background | `video_remove_background` | `videoOutputType`, `backgroundColor`, `model` (max 20 s) |
| Clean Speech | `audio_clean_speech` | `targetLufs` (−40 to −8) |

Example price: `images_remove_background` = 3 credits (`certainty: exact`). Through MCP the account's "unlimited" mode
does not apply; every call is billed in credits.
