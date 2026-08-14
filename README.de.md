# Open Creative Director

**Dein persönlicher KI-Creative-Director — eine Chat-App, die Bilder, Videos, Stimmen und Motion Graphics auf deinem Rechner plant und produziert.**

English version: [README.md](README.md)

Du beschreibst in normaler Sprache, was du willst («eine 15-Sekunden-Hochformat-Ad für meine Kaffeemarke, warmes Morgenlicht»). Der Creative Director — ein LLM über [OpenRouter](https://openrouter.ai) — plant die Produktion und setzt sie mit echten Generierungs-Tools um: Bilder mit **GPT Image 2**, Video mit **Seedance 2.5**, Sprache mit **ElevenLabs**, 30+ Zusatzmodelle (Kling, Veo, Sora, …) über **Higgsfield**, und HTML/GSAP-**Motion-Graphics**, gerendert auf deinen eigenen Rechnern. Ergebnisse erscheinen direkt im Chat und werden lokal gespeichert.

Inspiriert vom Higgsfield-«Supercomputer»-Konzept — neu gebaut als offene, lokale App.

## Features

- **Produktion per Chat** — der Director stellt die richtigen Fragen und generiert dann. Tool-Calling, Live-Streaming, Kostentransparenz pro Generierung.
- **Bilder** — GPT-Image-2-Generierung und -Bearbeitung, Referenzbilder, SVG-Rasterung.
- **Video** — Seedance 2.5 Text-zu-Video und Bild-zu-Video (4–30 s). Stimm- und Figuren-Konsistenz über Bild-, Video- und Audio-Referenzen.
- **Sprache** — ElevenLabs Text-to-Speech für Voice-Over und Voice-Master (optional).
- **Higgsfield-Integration** — higgsfield.ai-Konto mit einem Klick verbinden (kein API-Key nötig): 30+ Bild-/Videomodelle für den Director, abgerechnet als Higgsfield-Credits auf deinem Plan (optional).
- **Motion Graphics** — HTML/GSAP-Compositions als MP4, gerendert auf einem oder mehreren Render-Nodes (16:9, 9:16, 1:1) (optional).
- **Casting** — wiederverwendbare Figuren pro Projekt: Referenzbilder plus Voice-Master halten Gesicht und Stimme über Episoden konsistent.
- **Branding-Studio** — Farben, Typografie, Logos, Bildwelt, Tonalität. Design-System-Import per ZIP (z. B. aus claude.ai/design exportiert), Export als ZIP.
- **Projekte mit Produktions-Profilen** — Briefing-Richtlinien, Kontextdateien, Brandings, Cast und ein Projekt-Gedächtnis, das der Director selbst pflegt.
- **Rollen** — eigene System-Prompts pro Chat, mit KI-Rollen-Generator.
- **Prompt-Vorlagen** — kuratiertes, klappbares Menü produktionsreifer Prompts (Casting, Serie, Branding, Motion, Social Media, Marketing) plus eigene team-geteilte Vorlagen.
- **Drei Sprachen** — UI auf Deutsch, Englisch und Spanisch.
- **Kosten-Journal** — jede Generierung und jeder LLM-Call wird mit Kosten protokolliert.

## Schnellstart

Voraussetzungen: [Node.js](https://nodejs.org) ≥ 22, ein [OpenRouter](https://openrouter.ai)-API-Key. Optional: `ffmpeg` im PATH (aktiviert automatische Konsistenz-Checks auf fertigen Videos).

```bash
git clone https://github.com/Kuble-Lab/open-creative-director.git
cd open-creative-director
npm install
cp .env.example .env    # dann deinen OpenRouter-Key in .env eintragen
npm start               # → http://localhost:3111
```

Das ist alles. Der Rest ist optional und degradiert sauber.

> Lieber von einem KI-Agenten installieren lassen? Kopiere den Prompt aus [INSTALL-PROMPT.md](INSTALL-PROMPT.md) in Claude Code, Codex oder einen anderen Coding-Agenten.

## Welche Keys brauche ich?

| Key / Einstellung | Nötig? | Was es freischaltet | Wo bekommen |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | **Ja** | Director-LLM, GPT-Image-2-Bilder, Seedance-2.5-Video — alles über ein OpenRouter-Konto abgerechnet | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `ELEVENLABS_API_KEY` | Optional | Text-to-Speech (`generate_speech`, Stimmenliste) | [elevenlabs.io](https://elevenlabs.io) |
| Higgsfield-Konto | Optional | 30+ zusätzliche Bild-/Videomodelle für den Director | Kein Key — in den ⚙️ Einstellungen auf **Verbinden** klicken und im Browser bestätigen (Device-Flow, Tokens bleiben auf deinem Rechner) |
| `RENDER_NODE_URL` + `RENDER_NODE_TOKEN` | Optional | HTML/GSAP-Motion-Graphics-Rendering | Eigenen Render-Node betreiben (siehe unten); mehrere Nodes in den ⚙️ Einstellungen verwaltbar |
| `PUBLIC_BASE_URL` | Optional | Seedance-Audio-/Video-Referenzen (brauchen öffentlich erreichbare HTTPS-URLs) | Nur beim öffentlichen Hosting nötig |
| `AUTH_WHOAMI_URL` + `ADMIN_EMAILS` | Optional | Team-Betrieb hinter eigenem Auth-Proxy | Nur fürs Team-Hosting — lokal läuft die App offen |
| `GTS_API_TOKEN` + `GTS_BASE_URL` | Optional | Wissensdatenbank-Dokumente als Chat-Kontext | Jeder kompatible GTS-Endpunkt; der Beispiel-Default zeigt auf `gts.kuble.com` |

Keys lassen sich auch zur Laufzeit in den **⚙️ Einstellungen** eintragen (serverseitig in `data/settings.json`, chmod 600, nie im Repo) — sie übersteuern die `.env` ohne Neustart.

## Wie es funktioniert

```
Browser (Vanilla JS, SSE)
   │
Node/Express-Server (server.js)
   │
   ├─ Director-LLM ── OpenRouter Chat Completions mit Tool-Calling
   ├─ generate_image / edit_image ── GPT Image 2 via OpenRouter
   ├─ generate_video ── Seedance 2.5 via OpenRouter (asynchrone Jobs + Poller)
   ├─ generate_speech / list_voices ── ElevenLabs (optional)
   ├─ higgsfield_* ── Higgsfield-MCP-Client, Device-Flow-Auth (optional)
   ├─ render_motion_graphics ── eigene HyperFrames-Render-Node(s) (optional)
   └─ Speicher: Sessions, Assets, Brandings, Cast, Projekte — einfache Dateien unter data/ und assets/
```

Keine Datenbank, kein Cloud-Speicher: Sessions, generierte Assets, Brandings und Einstellungen sind einfache Dateien auf deiner Disk. Ordner löschen — alles weg.

## Motion-Graphics-Render-Node (optional)

Das Tool `render_motion_graphics` schickt HTML/GSAP-Compositions an einen kleinen Render-Service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg), der auf demselben Rechner oder jedem anderen Computer laufen kann — direkt erreichbar oder über einen SSH-Tunnel. Mehrere Nodes werden automatisch verteilt (idle zuerst, dann kürzeste Queue). Nodes verwaltest du in **⚙️ Einstellungen → Render-Nodes**.

## Team-Betrieb (optional)

Ab Werk ist die App Einzelplatz und offen. Es gibt kein eingebautes Admin-Konto. Für ein Team stellst du sie hinter dein eigenes Login (jeder Auth-Proxy mit Whoami-Endpoint), setzt `AUTH_WHOAMI_URL` und listest Admin-E-Mails in `ADMIN_EMAILS` — nur diese Admins erhalten die ⚙️ Einstellungen (API-Keys, Render-Nodes, Admins, Higgsfield). Ohne `AUTH_WHOAMI_URL` bleibt der lokale Zugriff offen. Kosten werden pro User erfasst.

## Lizenz

[MIT](LICENSE) © 2026 Kuble AG — gebaut vom [Kuble](https://kuble.com)-Team mit Claude Code und Codex.
