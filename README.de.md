# Open Creative Director

**Dein persönlicher KI-Creative-Director — eine Chat-App, die Bilder, Videos, Stimmen und Motion Graphics auf deinem Rechner plant und produziert.**

English version: [README.md](README.md)

Du beschreibst in normaler Sprache, was du willst («eine 15-Sekunden-Hochformat-Ad für meine Kaffeemarke, warmes Morgenlicht»). Der Creative Director — ein LLM über [OpenRouter](https://openrouter.ai) — plant die Produktion und setzt sie mit echten Generierungs-Tools um: Bilder mit **GPT Image 2**, Video mit **Seedance 2.5**, Sprache mit **ElevenLabs**, 30+ Zusatzmodelle (Kling, Veo, Sora, …) über **Higgsfield**, und HTML/GSAP-**Motion-Graphics**, gerendert auf deinen eigenen Rechnern. Ergebnisse erscheinen direkt im Chat und werden lokal gespeichert.

Inspiriert vom Higgsfield-«Supercomputer»-Konzept — neu gebaut als offene, lokale App.

![Open Creative Director — Chat mit generiertem Hero-Bild, Kosten-Badges und Qualitäts-Check des Directors](docs/screenshots/chat.png)

## Features

- **Produktion per Chat** — der Director stellt die richtigen Fragen und generiert dann. Tool-Calling, Live-Streaming, Kostentransparenz pro Generierung.
- **Bilder** — GPT-Image-2-Generierung und -Bearbeitung, Referenzbilder, SVG-Rasterung.
- **Video** — Seedance 2.5 Text-zu-Video und Bild-zu-Video (4–30 s). Stimm- und Figuren-Konsistenz über Bild-, Video- und Audio-Referenzen. Finale Schnitte via `concat_videos`: ffmpeg hängt fertige Clips verlustfrei aneinander, ohne Grössenlimit (braucht `ffmpeg` im PATH).
- **Live-Produktionsstatus** — laufende Jobs erscheinen in einer Live-Statusleiste mit Laufzeit, der Director meldet Ergebnisse und Fehler von selbst im Chat, und die Denk-Anzeige zeigt, was gerade ausgeführt wird.
- **Sprache** — ElevenLabs Text-to-Speech für Voice-Over und Voice-Master (optional).
- **Higgsfield-Integration** — higgsfield.ai-Konto mit einem Klick verbinden (kein API-Key nötig): 30+ Bild-/Videomodelle für den Director, abgerechnet als Higgsfield-Credits auf deinem Plan (optional).
- **Motion Graphics** — HTML/GSAP-Compositions als MP4, gerendert auf einem oder mehreren Render-Nodes (16:9, 9:16, 1:1) (optional).
- **Node-Ansicht** — wiederverwendbare Produktionsabläufe auf einer Arbeitsfläche bauen (Batch-Läufe, sieben Vorlagen), als aufgeräumte Design App veröffentlichen und Ergebnisse in einen Chat zurückschicken.
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
| ChatGPT-Abo | Optional | Der Director läuft auf GPT-5.6-Modellen über dein ChatGPT-Plus/Pro-Abo statt Token-Abrechnung | Kein Key — in der [Codex CLI](https://github.com/openai/codex) mit «Sign in with ChatGPT» einloggen, dann in den ⚙️ Einstellungen **Aus Codex-CLI-Login übernehmen** klicken. Inoffizieller Weg über das Codex-Backend (Grauzone der OpenAI-Nutzungsbedingungen) — Nutzung auf eigene Verantwortung |
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

## Node-Ansicht (Workflows und Design Apps)

![Open Creative Director — Node-Ansicht mit der Vorlage Standbild zu vertikalem Spot mit Sprecher: Eingaben, LLM-Beschreibung, Seedance-Animation, Sprecher und Ergebnis-Node auf der Arbeitsfläche](docs/screenshots/nodes.png)

Neben dem Chat öffnet **🧩 Nodes** in der Seitenleiste eine Arbeitsfläche für wiederverwendbare Produktionsabläufe. Nodes für Eingaben (Text, Textliste, Bilder, Videos, Audio), LLM-Schritte, Bild-/Video-/Audio-Generierung, ffmpeg-Bearbeitung und Ergebnisse werden verbunden; jeder Workflow legt seine Medien in einer eigenen versteckten Session ab, damit deine Chatliste sauber bleibt.

- **Canvas** — Ziehen mit der linken Maustaste auf leerer Fläche zieht einen Auswahlrahmen (Shift ergänzt); die Werkzeugleiste wechselt zwischen *Auswahl (V)* und *Hand (H)*. Verschieben geht auch mit Leertaste + Ziehen, mittlerer Maustaste oder zwei Fingern auf dem Trackpad, Zoomen mit Ctrl/Cmd + Mausrad oder Pinch zum Cursor. Rückgängig/Wiederholen, Kopieren/Einfügen, Gruppen und Notizen funktionieren wie gewohnt.
- **Läufe** — ein Node, die Auswahl oder der ganze Ablauf läuft auf dem Server. Ergebnisse werden anhand ihrer Eingaben gecacht, unveränderte Nodes werden übersprungen. Kostenpflichtige Nodes tragen ein `$`, der Lauf-Dialog zeigt die zuletzt bekannten Kosten, und ein kostenpflichtiger Lauf verlangt immer eine Bestätigung.
- **Batch** — eine *Textliste* (ein Eintrag pro Zeile oder Blöcke, getrennt durch `---`) oder eine *Medienliste* lässt den Ablauf pro Eintrag einmal laufen (bis 50). Der Zähler unter der Liste zeigt, wie viele Einträge verwendet werden.
- **Assets** — jede Bild-/Video-/Audio-Eingabe nimmt einen Upload, eine Datei aus einem deiner Chats oder ein bereits in diesem Workflow erzeugtes Asset.
- **Vorlagen** — *Neu aus Vorlage* bietet sieben fertige Abläufe: Produkt-Hero (4 Varianten), Standbild zu vertikalem Spot mit Sprecher, Konsistente Figuren-Serie (Batch), Fortlaufende Einstellungen über das letzte Bild, Motion-Titel über Footage, Maskierte Bearbeitung und Clip in drei Landessprachen (Higgsfield-Dubbing mit Lippensynchronisation). Vorlagen, deren Anbieter nicht konfiguriert ist, werden als nicht verfügbar angezeigt; ihre Texte gibt es auf Deutsch, Englisch und Spanisch.
- **Design App** — in der Kopfleiste *Design App* einschalten, Parameter deiner Nodes freigeben (der kleine Schalter neben einem Feld) und die Ergebnis-Nodes wählen. `#app=<Workflow-ID>` zeigt dann ein aufgeräumtes Formular mit *Ausführen*, Live-Status, Ergebnisgalerie, Downloads und *In Chat senden*. Die Formularwerte gelten nur für diesen Lauf; der gespeicherte Workflow bleibt unverändert.
- **Chat-Brücke** — *In Chat senden* kopiert Ergebnisse als sichtbare Nachricht mit angehängten Medien in einen Chat deiner Wahl, damit der Director dort weiterarbeiten kann.
- **Projekte** — einen Workflow einem Projekt zuweisen (dieselben Ordner wie bei deinen Chats); der Projektname erscheint in der Workflow-Liste. Workflows sind für das ganze Team sichtbar; beim Löschen werden auch die Medien gelöscht (die App fragt vorher nach).

## Motion-Graphics-Render-Node (optional)

Das Tool `render_motion_graphics` schickt HTML/GSAP-Compositions an einen kleinen Render-Service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg), der auf demselben Rechner oder jedem anderen Computer laufen kann — direkt erreichbar oder über einen SSH-Tunnel. Der Service liegt in diesem Repo unter [`render-node/`](render-node/README.md). Mehrere Nodes werden automatisch verteilt (idle zuerst, dann kürzeste Queue), und importierte Medien streamen in Blöcken zum Node (bis 500 MB pro Render). Nodes verwaltest du in **⚙️ Einstellungen → Render-Nodes**.

## Team-Betrieb (optional)

Ab Werk ist die App Einzelplatz und offen. Es gibt kein eingebautes Admin-Konto. Für ein Team stellst du sie hinter dein eigenes Login (jeder Auth-Proxy mit Whoami-Endpoint), setzt `AUTH_WHOAMI_URL` und listest Admin-E-Mails in `ADMIN_EMAILS` — nur diese Admins erhalten die ⚙️ Einstellungen (API-Keys, Render-Nodes, Admins, Higgsfield). Ohne `AUTH_WHOAMI_URL` bleibt der lokale Zugriff offen. Kosten werden pro User erfasst.

## Lizenz

[MIT](LICENSE) © 2026 Kuble AG — gebaut vom [Kuble](https://kuble.com)-Team mit Claude Code und Codex.
