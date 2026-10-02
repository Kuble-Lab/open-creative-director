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
- **Videomodell-Wahl** — bevor ein Video startet, zeigt der Director im Chat eine Karte mit den OpenRouter-Videomodellen, die zum Auftrag passen (Länge, Auflösung, Format, Startbild, Referenzen): geschätzter Preis für genau diesen Auftrag, Stärken und Schwächen, eine Empfehlung. Erst der Klick startet die kostenpflichtige Erzeugung; Abbrechen kostet nichts. Wer ein Budget hat, sieht den Rest, Optionen darüber sind deaktiviert, und der Server prüft es nochmals und reserviert die Schätzung. «In diesem Chat nicht mehr fragen» merkt das Modell für dich in diesem Chat (in einem geteilten Chat bekommen alle anderen weiterhin die Karte; zurücksetzbar über dem Eingabefeld). Admins schalten die Frage unter Einstellungen → Dienste aus (*Vor jedem Video nach dem Modell fragen*); dann startet das konfigurierte Standardmodell sofort.
- **Live-Produktionsstatus** — laufende Jobs erscheinen in einer Live-Statusleiste mit Laufzeit, der Director meldet Ergebnisse und Fehler von selbst im Chat, und die Denk-Anzeige zeigt, was gerade ausgeführt wird.
- **Sprache** — ElevenLabs Text-to-Speech für Voice-Over und Voice-Master (optional).
- **Higgsfield-Integration** — higgsfield.ai-Konto mit einem Klick verbinden (kein API-Key nötig): 30+ Bild-/Videomodelle für den Director, abgerechnet als Higgsfield-Credits auf deinem Plan (optional).
- **Motion Graphics** — HTML/GSAP-Compositions als MP4, gerendert auf einem oder mehreren Render-Nodes (16:9, 9:16, 1:1) (optional).
- **Node-Ansicht** — wiederverwendbare Produktionsabläufe auf einer Arbeitsfläche bauen (Batch-Läufe, acht Vorlagen), als aufgeräumte Design App veröffentlichen und Ergebnisse in einen Chat zurückschicken.
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
| `FAL_KEY` | Optional | fal.ai-Modelle in der Node-Ansicht: die MiniMax-H3-Max-Nodes (Text-/Bild-/Referenz-Video, Lip Sync, Kamerafahrten, Video verlängern, Szene einfügen, 3D zu Video, Stile) und ein freier fal.ai-Modell-Node. fal.ai rechnet pro Sekunde ab | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| Higgsfield-Konto | Optional | 30+ zusätzliche Bild-/Videomodelle für den Director | Kein Key — in den Menü → Einstellungen auf **Verbinden** klicken und im Browser bei Higgsfield anmelden (OAuth-Login, Tokens bleiben auf dem Server). Hinter einem Reverse-Proxy `PUBLIC_BASE_URL` setzen, damit der Browser die Callback-URL erreicht |
| ChatGPT-Abo | Optional | Der Director läuft auf GPT-5.6-Modellen über dein ChatGPT-Plus/Pro-Abo statt Token-Abrechnung | Kein Key — in der [Codex CLI](https://github.com/openai/codex) mit «Sign in with ChatGPT» einloggen, dann in den Menü → Einstellungen **Aus Codex-CLI-Login übernehmen** klicken. Inoffizieller Weg über das Codex-Backend (Grauzone der OpenAI-Nutzungsbedingungen) — Nutzung auf eigene Verantwortung. Ist das Abo nicht erreichbar (Login abgelaufen, Nutzungslimit, Störung) und ein OpenRouter-Key gesetzt, wird dieser eine Modellaufruf über OpenRouter als `openai/<Modell>` wiederholt: Ein Hinweis im Chat sagt es, der Aufruf wird deinem OpenRouter-Konto berechnet, und das Abo wird 10 Minuten lang übersprungen |
| `RENDER_NODE_URL` + `RENDER_NODE_TOKEN` | Optional | HTML/GSAP-Motion-Graphics-Rendering | Eigenen Render-Node betreiben (siehe unten); mehrere Nodes in den Menü → Einstellungen verwaltbar |
| `PUBLIC_BASE_URL` | Optional | Seedance-Audio-/Video-Referenzen (brauchen öffentlich erreichbare HTTPS-URLs); ausserdem Basis der Higgsfield-Login-Callback-URL (`<PUBLIC_BASE_URL>/api/higgsfield/oauth/callback`) | Nur beim öffentlichen Hosting oder hinter einem Reverse-Proxy nötig |
| `AUTH_WHOAMI_URL` + `ADMIN_EMAILS` | Optional | Benutzerverwaltung hinter eigenem Login: private Chats/Workflows, Teilen, Admins, Team-Liste (`SUPERADMIN_EMAILS`, `AUTH_LOGOUT_URL` optional) | Nur fürs Team-Hosting — lokal läuft die App offen. Siehe [Benutzerverwaltung](#benutzerverwaltung-optional) |
| `GTS_API_TOKEN` + `GTS_BASE_URL` | Optional | Wissensdatenbank-Dokumente als Chat-Kontext | Jeder kompatible GTS-Endpunkt; der Beispiel-Default zeigt auf `gts.kuble.com` |

Keys lassen sich auch zur Laufzeit in den **Menü → Einstellungen** eintragen (serverseitig in `data/settings.json`, chmod 600, nie im Repo) — sie übersteuern die `.env` ohne Neustart.

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
   ├─ higgsfield_* ── Higgsfield-MCP-Client, OAuth-Login im Browser (optional)
   ├─ render_motion_graphics ── eigene HyperFrames-Render-Node(s) (optional)
   └─ Speicher: Sessions, Assets, Brandings, Cast, Projekte — einfache Dateien unter data/ und assets/
```

Keine Datenbank, kein Cloud-Speicher: Sessions, generierte Assets, Brandings und Einstellungen sind einfache Dateien auf deiner Disk. Ordner löschen — alles weg.

## Node-Ansicht (Workflows und Design Apps)

![Open Creative Director — Node-Ansicht mit der Vorlage Standbild zu vertikalem Spot mit Sprecher: Eingaben, LLM-Beschreibung, Seedance-Animation, Sprecher und Ergebnis-Node auf der Arbeitsfläche](docs/screenshots/nodes.png)

Neben dem Chat öffnet der Umschalter **Chat | Nodes** in der Kopfzeile eine Arbeitsfläche für wiederverwendbare Produktionsabläufe. Nodes für Eingaben (Text, Textliste, Bilder, Videos, Audio), LLM-Schritte, Bild-/Video-/Audio-Generierung, ffmpeg-Bearbeitung und Ergebnisse werden verbunden; jeder Workflow legt seine Medien in einer eigenen versteckten Session ab, damit deine Chatliste sauber bleibt.

- **Canvas** — Ziehen mit der linken Maustaste auf leerer Fläche zieht einen Auswahlrahmen (Shift ergänzt); die Werkzeugleiste wechselt zwischen *Auswahl (V)* und *Hand (H)*. Verschieben geht auch mit Leertaste + Ziehen, mittlerer Maustaste oder zwei Fingern auf dem Trackpad, Zoomen mit Ctrl/Cmd + Mausrad oder Pinch zum Cursor. Rückgängig/Wiederholen, Kopieren/Einfügen, Gruppen und Notizen funktionieren wie gewohnt.
- **Läufe** — ein Node, die Auswahl oder der ganze Ablauf läuft auf dem Server. Ergebnisse werden anhand ihrer Eingaben gecacht, unveränderte Nodes werden übersprungen. Kostenpflichtige Nodes tragen ein `$`, der Lauf-Dialog zeigt die zuletzt bekannten Kosten, und ein kostenpflichtiger Lauf verlangt immer eine Bestätigung.
- **Batch** — eine *Textliste* (ein Eintrag pro Zeile oder Blöcke, getrennt durch `---`) oder eine *Medienliste* lässt den Ablauf pro Eintrag einmal laufen (bis 50). Der Zähler unter der Liste zeigt, wie viele Einträge verwendet werden.
- **fal.ai (MiniMax H3 Max)** — mit einem `FAL_KEY` bietet die Kategorie *fal.ai* Nodes für jeden Queue-Endpunkt von MiniMax H3 Max (H3-Max-Video und Turbo, Referenz-Video, Lip Sync, Kamerafahrt, Video verlängern, Szene einfügen, 3D zu Video, fünf Stile) und einen freien *fal.ai-Modell*-Node für beliebige weitere Endpunkte. Medien werden in den fal-Speicher hochgeladen, der Job läuft in der fal-Queue und das Ergebnis wird im Hintergrund abgeholt, du kannst die Seite also verlassen. Die Kosten sind Schätzungen nach Listenpreis (fal.ai meldet keinen Preis); die Nodes sind experimentell, bis sie live getestet wurden. Der Echtzeit-Endpunkt *director* wird nicht angeboten.
- **Prompt-Node** — *Prompt* (erster Eintrag der Kategorie *Eingaben*) ist ein eigener Node mit grossem Textfeld, in dem du den Prompt direkt auf der Fläche schreibst; verbinde ihn mit einem oder mehreren Generierungs-Nodes, dann sieht man im Graphen, welcher Prompt wohin geht. Die eingebetteten Prompt-Felder funktionieren weiterhin: der kleine Button in ihrer Ecke (und der Button beim Feld im Inspektor) verschiebt den Text in einen neuen Prompt-Node links vom Node und verbindet ihn (ein Rückgängig-Schritt). Wer eine Verbindung von einem Node zieht und auf leerer Fläche loslässt, bekommt an dieser Stelle eine Schnellauswahl mit nur den passenden Nodes (bei Text-Eingängen steht Prompt zuoberst); Esc oder ein Klick daneben bricht ab.
- **Anschluss-Hilfe** — wer kurz (etwa eine Drittelsekunde) über einem Anschluss verweilt (Punkt oder Beschriftung, Ein- und Ausgänge), sieht, was er erwartet oder liefert: Name, Typ, Pflicht oder optional, eine kurze Beschreibung, wie viele Verbindungen er annimmt und in welcher Reihenfolge sie zählen. Esc, ein Klick, ein Ziehvorgang, Scrollen oder Zoomen blendet die Hilfe aus.
- **Mehrere Referenzen** — Eingänge mit doppeltem Ring (zum Beispiel *Bilder* beim H3-Max-Referenz-Node, *Referenzen* bei Seedance) nehmen mehrere Verbindungen an, neben der Beschriftung steht `n/max`. Entweder verbindest du mehrere Bild-Nodes mit demselben Eingang, oder eine *Medienliste*: Eine Liste an so einem Eingang liefert alle Dateien auf einmal, an einem Einzel-Eingang läuft der Node dagegen einmal pro Element. Weitere Verbindungen ziehst du vom Ausgang der jeweiligen Quelle zum selben Eingang (Ziehen am Eingang selbst löst die letzte Verbindung). Im Prompt zählen die Referenzen in der Reihenfolge der Verbindungen (H3-Max-Referenzvideo: «Image 1», «Image 2», «Video 1» …); eine Medienliste zählt mit allen ihren Dateien und jede Datei zählt zum Maximum, darum verschieben sich die Nummern nach einer Liste, und die Hover-Hilfe zeigt dahinter keine Positionen mehr. Wer von einem Mehrfach-Eingang ins Leere zieht, bekommt in der Schnellauswahl zuerst die *Medienliste* und den passenden Einzel-Eingabe-Node.
- **Motion Graphics aus HTML** — der Node *Motion Graphics aus HTML (Render-Node)* rendert fertigen HTML/GSAP-Code, keine Anweisung. Den Code liefert ein davorgeschalteter *Motion-HTML-Autor* (dort beschreibst du die Animation; dieselben Dateien an beide Nodes hängen und im Code als `{{asset:1}}`, `{{asset:2}}` … ansprechen) oder du fügst ihn ins Feld ein. Zum Aneinanderhängen von Videos nimmst du stattdessen *Videos aneinanderhängen*. Steht im Feld normaler Text («make it one video») oder HTML ohne `data-width` / `data-height` des gewählten Formats, ist der Node vor dem Lauf als unvollständig markiert und sagt, was zu ändern ist; bei normalem Text legt der Button *Mit KI in HTML umwandeln* links einen Prompt-Node und einen Motion-HTML-Autor an (dein Text wird zum Prompt, Format und Dateien werden übernommen, das Feld wird geleert, ein Undo-Schritt). Es läuft nichts, bis du startest; der Autor ist ein kostenpflichtiger Node und fragt wie gewohnt nach Bestätigung.
- **Assets** — jede Bild-/Video-/Audio-Eingabe nimmt einen Upload, eine Datei aus einem deiner Chats oder ein bereits in diesem Workflow erzeugtes Asset.
- **Vorlagen** — *Neu aus Vorlage* bietet acht fertige Abläufe: Produkt-Hero (4 Varianten), Standbild zu vertikalem Spot mit Sprecher, Konsistente Figuren-Serie (Batch), Fortlaufende Einstellungen über das letzte Bild, Motion-Titel über Footage, Maskierte Bearbeitung, Clip in drei Landessprachen (Higgsfield-Dubbing mit Lippensynchronisation) und Sprechendes Porträt (ElevenLabs-Stimme plus H3-Max-Lip-Sync auf fal.ai). Vorlagen, deren Anbieter nicht konfiguriert ist, werden als nicht verfügbar angezeigt; ihre Texte gibt es auf Deutsch, Englisch und Spanisch.
- **Design App** — in der Kopfleiste *Design App* einschalten, Parameter deiner Nodes freigeben (der kleine Schalter neben einem Feld) und die Ergebnis-Nodes wählen. `#app=<Workflow-ID>` zeigt dann ein aufgeräumtes Formular mit *Ausführen*, Live-Status, Ergebnisgalerie, Downloads und *In Chat senden*. Die Formularwerte gelten nur für diesen Lauf; der gespeicherte Workflow bleibt unverändert.
- **Chat-Brücke** — *In Chat senden* zeigt zuerst, was gesendet wird (Medien mit kleiner Vorschau, Texte mit ihren ersten Zeichen; Zusatztexte eines Medien-Ergebnisses sind zunächst nicht angehakt), und kopiert das Ergebnis dann in einen Chat deiner Wahl. Dort erscheint es als Karte mit Workflow, Node, Player oder Vorschaubild, einklappbaren Texten und einem Link zurück zum Workflow. Der Director sieht die Dateien mit ihren Asset-IDs und kann damit weiterarbeiten; es startet nichts automatisch.
- **Projekte** — einen Workflow einem Projekt zuweisen (dieselben Ordner wie bei deinen Chats); der Projektname erscheint in der Workflow-Liste. Wer einen Workflow sieht, regelt die [Benutzerverwaltung](#benutzerverwaltung-optional) (ohne sie ist alles für alle offen); beim Löschen werden auch die Medien gelöscht (die App fragt vorher nach).

## Motion-Graphics-Render-Node (optional)

Das Tool `render_motion_graphics` schickt HTML/GSAP-Compositions an einen kleinen Render-Service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg), der auf demselben Rechner oder jedem anderen Computer laufen kann — direkt erreichbar oder über einen SSH-Tunnel. Der Service liegt in diesem Repo unter [`render-node/`](render-node/README.md). Mehrere Nodes werden automatisch verteilt (idle zuerst, dann kürzeste Queue), und importierte Medien streamen in Blöcken zum Node (bis 500 MB pro Render). Nodes verwaltest du in **Menü → Einstellungen → Render-Nodes**.

## Benutzerverwaltung (optional)

Ab Werk ist die App Einzelplatz und offen: alle dürfen alles, nichts hat einen Besitzer. **Die Benutzerverwaltung ist aktiv genau dann, wenn `AUTH_WHOAMI_URL` gesetzt ist.** Das Login bleibt ausserhalb der App: Stelle sie hinter dein eigenes Login (jeder Auth-Proxy, der für das Cookie des Aufrufers einen Whoami-Endpoint `{ "logged_in": true, "email": "…" }` beantwortet). Die App fragt nie nach einem Passwort.

| Einstellung | Bedeutung |
| --- | --- |
| `AUTH_WHOAMI_URL` | Whoami-Endpoint deines Logins. Schaltet die Benutzerverwaltung ein. Nicht gesetzt = lokaler Modus, exakt wie bisher |
| `ADMIN_EMAILS` | Admins, kommagetrennt (weitere in Menü → Einstellungen). Kein eingebauter Standard |
| `SUPERADMIN_EMAILS` | Superadmins, kommagetrennt, beliebige Domain. Nur per Umgebung, nie in der App änderbar. Sie sind auch Admins und dürfen die Monitoring-Seite öffnen |
| `AUTH_LOGOUT_URL` | Optionaler Abmelde-Link fürs Konto-Menü (`https://…` oder absoluter Pfad). Ohne ihn gibt es keinen Abmelden-Eintrag |
| `INTERNAL_EMAIL_DOMAINS` | E-Mail-Domains der eigenen Organisation, kommagetrennt (z. B. `example.com`). Deren Adressen sind *interne Personen*. Nur mit [Teams](#teams-mit-usd-budget-optional) relevant: Eine angemeldete Adresse, die weder intern noch in einem Team ist, ist ein Gast. Nicht gesetzt = alle Angemeldeten gelten als intern (Verhalten vor den Teams), ausser Adressen, die in einem Team sind oder waren (auch archiviert oder entfernt): Sie gelten als Gast. Die App warnt beim Start und in den Team-Einstellungen, solange die Variable fehlt |
| `ACCESS_ALLOWLIST_FILE` + `ACCESS_ALLOWLIST_ROUTE` | Optionaler [Freigabelisten-Sync](#freigabelisten-sync-optional): Pfad der JSON-Datei deines Logins und die zu pflegende Route (z. B. `/training`). Beide oder keines |

Regeln im aktiven Modus:

- **Wer ist wer.** Aufrufer ist die E-Mail-Adresse, die der Whoami-Endpoint liefert. Eine Anfrage ohne gültige Adresse (Whoami fehlgeschlagen, direkter Zugriff auf den Port) ist anonym: Sie sieht und nutzt nur, was keinen Besitzer hat, und was sie anlegt, bekommt ebenfalls keinen.
- **Unbestätigte Anmeldung (fail closed).** Sobald eine Einschränkung aktiv ist, kann eine anonyme Anfrage eine Teilnehmerin oder ein Teilnehmer sein, deren Anmeldung nicht bestätigt werden konnte (Whoami-Timeout, Netzfehler, 5xx). Eine Einschränkung ist aktiv, wenn die Teams-Datei irgendeine Adresse kennt (auch von entfernten Personen), die Teams-Datei unlesbar ist oder `INTERNAL_EMAIL_DOMAINS` gesetzt ist. Dann antwortet jede `/api`-Route mit `401` und dem Code `LOGIN_UNCONFIRMED` (Text auf Deutsch, Englisch und Spanisch), ausser den öffentlichen (`GET /api/me`, `/api/nodes/registry`, `/api/workflow-templates`, `/api/roles/default`) und `GET /api/config` (wie für Gäste gefiltert). Statische Dateien und die App-Hülle bleiben erreichbar; beide Ansichten zeigen ein Banner mit Knopf «Neu laden», und die Seite lädt sich selbst neu, sobald die Anmeldung wieder bestätigt ist. Ein fehlgeschlagener Whoami-Aufruf wird nur 2 s gemerkt (eine klare Antwort 10 s), und für so eine Anfrage startet keine bezahlte Aktion. Ohne Einschränkung (nie Teams, keine Domain-Liste) und im lokalen Modus bleibt alles wie bisher.
- **Neue Chats und Node-Workflows starten privat** (Besitzer und Admins). Der Besitzer kann sie mit dem ganzen Team oder mit ausgewählten Personen aus der Team-Liste teilen. Wer Zugriff hat, kann den Chat öffnen und weiterchatten, einen Workflow bearbeiten und ausführen, seine Design App nutzen und Dateien herunterladen; umbenennen, verschieben, löschen und neu teilen dürfen nur Besitzer und Admins.
- **Bestand bleibt offen.** Chats und Workflows ohne Besitzer (vor dem Einschalten der Benutzerverwaltung entstanden) bleiben für alle sichtbar und nutzbar, auch umbenennen und löschen, wie bisher. Die Freigabe ändern nur Admins; der handelnde Admin wird dabei Besitzer.
- **Fremde private Einträge gibt es für dich nicht.** Jede Route antwortet mit 404 (nicht 403) auf einen Chat oder Workflow, den du nicht sehen darfst; dasselbe gilt für seine Dateien (`/assets/…`), Downloads (ZIP), Exporte, Event-Streams und Läufe. Wird eine Freigabe zurückgenommen, enden offene Event-Streams.
- **Projekte** (Ordner) zeigen nur Einträge, die du sehen darfst; ein Projekt mit nur fremden privaten Einträgen ist ausgeblendet. Ein Projekt mit Einträgen anderer Personen oder mit Produktions-Profil, Kontextdateien, Memory oder Cast umbenennen oder löschen dürfen nur Admins. Projektnamen sind app-weit eindeutig: Ein Name, den ein für dich unsichtbares Projekt trägt, wird neutral mit «nicht verfügbar» beantwortet.
- **Das Gedächtnis des Directors folgt dem Chat.** Notizen mit `save_memory` gehören der Person, die gerade chattet, und fliessen nur in ihre eigenen Chats (Notizen aus der Zeit vor der Benutzerverwaltung bleiben global). Notizen mit `save_project_memory` sehen nur Personen, die den Chat nutzen dürfen, aus dem sie stammen, und nur diese Chats erhalten sie im Prompt (Teilen des Chats teilt sie; Admins sehen alle). Chat-Werkzeuge, die Brandings ändern (`create_branding`, `update_branding`, `add_branding_asset`), sind wie Branding-Import/-Löschen nur für Admins. Bekannte Grenze: Die Cast-Werkzeuge (`create_cast_member`, `update_cast_member`, `import_cast_asset`) bleiben für alle nutzbar, die das Projekt nutzen dürfen, weil sie der einzige Weg sind, den Cast zu füllen (Teilnehmende und Gäste nur in Projekten, die sie selbst angelegt haben); nur das Löschen eines Mitglieds ist Admin-Sache.
- **Nur für Admins** (alles andere steht allen Angemeldeten offen): Menü → Einstellungen und API-Keys, Admin- und Nutzerverwaltung, Render-Nodes, Higgsfield- und ChatGPT-Verbindung, Rollen, eigene Prompt-Presets, Branding-Import/-Löschen, Projektprofile (Richtlinien, Kontextdateien, Memory, Cast).
- **Team-Liste.** Die Personen, mit denen du teilen kannst: Admins, von Admins in Menü → Einstellungen eingetragene Personen (`data/users.json`) und alle, die die App einmal benutzt haben (automatisch mit *zuerst/zuletzt gesehen* in `data/team-seen.json` erfasst). Sie ist keine Zugangsliste — der Zugang bleibt beim Login. Admins können Einträge entfernen; eine entfernte Person wird nicht automatisch wieder erfasst, bis ein Admin sie wieder hinzufügt.
- **Kosten** werden pro Person erfasst; Admins sehen alle, alle anderen nur ihre eigenen.
- **Monitoring** (nur Superadmins, alle anderen erhalten 404): `/monitoring.html` und `GET /api/admin/monitoring` (`?days=7|30|90|all&user=…&provider=…`, CSV: `/api/admin/monitoring/export`) zeigen Nutzung und Kosten pro Person, Anbieter und Tag sowie Läufe, Jobs und fehlgeschlagene Anfragen.

Was Personen in der Oberfläche sehen (im lokalen Modus erscheint nichts davon):

- **Menü** (oben rechts, in der Chat- und in der Node-Ansicht): Initialen-Chip, E-Mail-Adresse, Rolle (Person, Admin, Superadmin), die eigenen Kosten des Monats, Einstellungen (Admins), *Hilfe*, für Superadmins ein Link zur Monitoring-Seite, die Sprache und ein Eintrag *Abmelden*, wenn `AUTH_LOGOUT_URL` gesetzt ist. Im lokalen Modus liegt dasselbe Menü hinter einem Drei-Punkte-Knopf und enthält Kosten, Einstellungen, Hilfe und Sprache. Wer nicht identifiziert ist, sieht einen Hinweis, dass nur Einträge ohne Besitzer zur Verfügung stehen.
- **Seitenleiste und Kopfzeile.** Ein fremder Chat zeigt seinen Besitzer neben dem Datum (volle Adresse im Tooltip) und ein Badge *Intern*, den Teamnamen oder *n Personen*, wenn er geteilt ist. In der Kopfzeile zeigt der Pfad *Projekt / Chattitel* den Besitzer (*von Name*) nur in einem fremden Chat; Besitzer, die Admins sind, tragen das Kennzeichen *ADMIN*. *Geteilt* ist ein Status mit grünem Punkt, in einem fremden Chat *Geteilt mit dir*; wer die Freigabe nicht verwalten darf, sieht den Status ohne Knopf. Chats und Workflows aus der Zeit vor der Benutzerverwaltung zeigen weder Badge noch Besitzer.
- **Teilen-Knopf** (Chats in der Kopfzeile und im Menü der Seitenleiste, Workflows in der Kopfzeile der Node-Ansicht und im Menü der Liste; nur für Besitzer und Admins): privat, *Alle intern*, *Teams* oder ausgewählte Personen (welche Arten es gibt, hängt vom Konto ab, siehe *Oberfläche der Teams* weiter unten). Bei einem Eintrag ohne Besitzer weist der Dialog darauf hin; beim Speichern wird der Admin zum Besitzer. Nimmt der Besitzer die Freigabe zurück, während jemand den Eintrag offen hat, schliesst er sich mit einer kurzen Meldung (auch bei offenen Event-Streams).
- **Design-App-Links.** Beim Kopieren des App-Links eines privaten Workflows erscheint ein Hinweis, dass andere ihn erst nach dem Teilen öffnen können.
- **Nur für Admins** (eigene Prompt-Presets, neue Rollen, Branding-Import/-Löschen, Projektprofil bearbeiten) ist für alle anderen ausgeblendet; das Projektprofil öffnet sich schreibgeschützt. Die Menü → Einstellungen zeigen eine *Team-Liste* mit zuerst/zuletzt gesehen (Personen hinzufügen oder entfernen) und für Superadmins einen Link zur Monitoring-Seite.

## Teams mit USD-Budget (optional)

Teams sind für Schulungen und Kurse gedacht: Personen von ausserhalb deiner Organisation erhalten Zugang zur App, ein festes USD-Budget und eine bewusst schmale Sicht. Sie setzen die Benutzerverwaltung voraus (`AUTH_WHOAMI_URL`); im lokalen Modus antworten die Team-Routen mit `400 USER_MANAGEMENT_INACTIVE`, und nichts ändert sich. Ohne Teams und ohne `INTERNAL_EMAIL_DOMAINS` verhält sich die App exakt wie oben beschrieben.

**Rollen.** Admins legen Teams in der Oberfläche an (Menü → *Teams verwalten* oder Menü → Einstellungen → *Personen*, siehe *Oberfläche der Teams* weiter unten) oder per API (`/api/teams`, nur Admins) und tragen Personen per E-Mail-Adresse ein.

| Rolle | Wer | Sieht und darf |
| --- | --- | --- |
| Admin / Superadmin | `ADMIN_EMAILS`, `SUPERADMIN_EMAILS`, in Menü → Einstellungen eingetragene Admins | Alles, kein Budget |
| Interne Person | Adresse einer `INTERNAL_EMAIL_DOMAINS`-Domain (ungesetzt: jede angemeldete Adresse, die nie in einem Team war) ohne Team | Wie bisher: Bestand, alle Werkzeuge, kein Budget |
| Teilnehmer | Mitglied mindestens eines aktiven Teams (auch mit interner Adresse) | Eigene Chats, Workflows und Projekte und was mit ihrem Team geteilt ist; das Budget ihres Teams; keine internen Ressourcen |
| Gast | Angemeldet, nicht intern, in keinem Team | Wie ein Teilnehmer mit Budget 0 (nur Kostenloses) |
| Anonym | Kein gültiges Login | Wie bisher |

**Was ein Teilnehmer nicht bekommt.** Bestand ohne Besitzer und alle privaten Einträge anderer (404), die interne Wissensdatenbank (GTS), Brandings, Team-Rollen und eigene Prompt-Vorlagen, das Projektprofil (Richtlinien, Kontextdateien, Brandings) von Projekten, die er nicht selbst angelegt hat, die Namen der Render-Nodes, die ChatGPT-Abo-Modelle, alle Higgsfield-Werkzeuge und -Nodes (Guthaben des Betreibers) und die geklonten ElevenLabs-Stimmen (nur Bibliotheksstimmen). Geteilt wird nur mit Teams, in denen er selbst ist, oder mit Personen der eigenen Teams, nie mit «allen Internen». Gäste können nur privat halten. Die Antworten nennen den Grund: `403 FORBIDDEN_FOR_ROLE` mit dem `feature` (`gts`, `higgsfield`, `chatgpt` …).

**Teure Director-Modelle (optional).** `config.json` kennt `restrictedBrainModels`, eine Liste von Modell-IDs (zum Beispiel `["openai/gpt-5.6-luna", "google/gemini-3.1-pro"]`). Ist sie gesetzt, sehen und nutzen Teilnehmende und Gäste nur diese Director-Modelle: im Chat-Menü, als Standardmodell (das konfigurierte `defaultBrain`, wenn es auf der Liste steht, sonst der erste Eintrag) und in den LLM-Nodes. Der Server setzt das durch: Eine Chat-Anfrage mit einem anderen Modell beantwortet das Standardmodell der Liste (mit Hinweis), und ein LLM-Node, der ein anderes Modell nennt, wird mit `403 FORBIDDEN_FOR_ROLE` (`feature`: `models`) abgelehnt. Leer oder fehlend: nichts ändert sich. Die ChatGPT-Abo-Modelle bleiben für sie in jedem Fall gesperrt; interne Personen und Admins sind nicht betroffen. Es gibt dafür keine Oberfläche in den Einstellungen, die Datei genügt.

**Teilen mit Teams.** Ein neuer Freigabemodus `teams` (`sharedTeams`: bis zu 20 Team-IDs) macht einen Chat oder Workflow für alle Mitglieder dieser Teams zugleich verfügbar — und nur für sie. Interne Personen dürfen jedes aktive Team wählen, Teilnehmer nur ihre eigenen. Wer aus dem Team entfernt wird oder dessen Team archiviert wird, verliert den Zugriff sofort.

**Oberfläche der Teams.** *Admins:* Menü → *Teams verwalten* (oder Menü → Einstellungen → *Personen*, die Teams stehen zuoberst) zeigt jedes Team als Karte: Personen, USD pro Person, verbrauchter Betrag. Ein aufgeklapptes Team hat Namen, Betrag und Beschreibung mit *Archivieren* / *Wieder aktivieren* / *Team löschen*, ein Einfügefeld und die Mitgliedertabelle (zuletzt gesehen, verbraucht, Rest, Budget). *Budget ändern* setzt für eine Person einen eigenen Betrag (Kennzeichen *individuell*, *Team-Betrag* nimmt ihn zurück), *Zurücksetzen* startet die Zählung ab jetzt neu, *Entfernen* beendet Zugang und Budget sofort; Zurücksetzen, Entfernen und Löschen brauchen einen zweiten Klick. Das Einfügefeld nimmt alles, was Adressen enthält: eine Excel-Spalte, eine Adresse pro Zeile, mit Komma oder Semikolon getrennt, `Name <mail@example.com>` aus dem Mailprogramm. Die Vorschau zeigt *N neu · M schon im Team · K ungültig* (die ungültigen Stücke lassen sich aufklappen), dann fügt ein Knopf die neuen in einer einzigen Anfrage hinzu (bis 500). Die Team-Liste in den Einstellungen hat dasselbe Einfügefeld. Ist der Freigabelisten-Sync fehlgeschlagen, steht über der Liste eine Warnung; das Team ist trotzdem gespeichert. Superadmins haben im Monitoring den Filter *Team* und die Tabelle *Teams und Budget* (Budget, Verbrauch, Rest, Reserviert, Verbrauch im Zeitraum, Jobs ohne Preis pro Person). *Teilnehmende:* Das Menü zeigt das Budget mit Balken, Betrag und Verbrauch sowie die Teams; ein Hinweis über dem Chat sagt, wenn das Budget knapp oder aufgebraucht ist. Abgelehnte (`402`) oder nicht verfügbare (`403`) bezahlte Aktionen werden in der Sprache der Oberfläche erklärt, Chats und Ergebnisse bleiben lesbar. Ein bezahlter Node-Lauf zeigt im Bestätigungsdialog das Restbudget und seine Schätzung und wird gar nicht erst angeboten, wenn die Schätzung den Rest übersteigt. Der Teilen-Dialog bietet *Privat*, *Teams* (nur die eigenen) und *Bestimmte Personen* (nur Teammitglieder); Interne und Admins haben zusätzlich *Alle intern*, Gäste können nur privat halten. Die Hilfeseite (`public/help.html`) erklärt das unter *Teams und Schulungen* und *Budget und Teilnahme*.

**Budget.** Jedes Team hat einen Betrag in USD **pro Person** (0 bis 10 000, ganze Rappen). Pro Person lässt er sich übersteuern (`budgetOverrideUsd`) oder neu beginnen (`resetBudget`: Die Zählung startet ab jetzt neu). Wer in mehreren Teams ist, hat den höchsten Betrag und den spätesten Start seiner Mitgliedschaften; der Beitritt zu einem neuen Team beginnt eine frische Zählung. Der Verbrauch stammt aus dem Kosten-Journal (`data/costs.jsonl`, jede Zeile trägt die Person) und wird inkrementell gelesen, nie als Ganzes. Kosten, die der Anbieter nicht meldet, zählen 0; Admins sehen solche Jobs im Monitoring (`unknownCostJobs`).

Jede Stelle, die Geld ausgeben kann, fragt zuerst das Budget und antwortet mit `402`, bevor etwas startet:

- Chat-Züge (vor dem Stream und vor jeder Werkzeug-Runde eines Zugs),
- die Director-Werkzeuge `generate_image`, `edit_image`, `generate_video`, `generate_speech` und (Node-Ansicht) `fal_generate`,
- Node-Läufe: Die Schätzung des Plans muss passen und wird für den Lauf reserviert; der Plan (`POST /api/workflows/:id/runs/plan`) meldet `budget` und `blocked`-Nodes,
- LLM-Nodes (`llm.completeText`); asynchrone Jobs (Video, fal) behalten ihre Reservierung, bis der Poller die Kosten verbucht hat. Ein Video von der Modellkarte reserviert den geschätzten Preis des gewählten Modells (das obere Ende der Schätzung). Hat ein Video-Job vorab keinen Preis, reserviert der Director pauschal `BUDGET_ASYNC_HOLD_USD` (Standard 2, höchstens der Rest) pro Job, und eine teilnehmende Person darf höchstens `BUDGET_MAX_OPEN_JOBS` (Standard 2) Anbieter-Jobs gleichzeitig offen haben (`429 BUDGET_JOBS_OPEN`). Wird ein Node-Lauf abgebrochen oder läuft in ein Timeout, während ein Anbieter-Job noch läuft, geht die Reservierung des Laufs auf diesen Job über, statt freigegeben zu werden.
- Sprache (`generate_speech`) wird pro Zeichen bepreist (`ELEVENLABS_USD_PER_1K_CHARS`, Standard 0.30): Die Schätzung wird reserviert, als Kosten vom Typ `speech` verbucht und im Monitoring angezeigt.

Codes: `BUDGET_EXHAUSTED` (nichts mehr übrig) und `BUDGET_INSUFFICIENT` (die Preisschätzung übersteigt den Rest) — Body mit `budget`, `estimateUsd`, `remainingUsd` und deutschem `error`-Text. Chats, Ergebnisse und Downloads bleiben bei aufgebrauchtem Budget verfügbar. Reservierungen paralleler Aktionen liegen im Speicher (für offene Jobs nach einem Neustart wiederhergestellt).

*Bekannte Grenze:* Wo vorab kein Preis bekannt ist (Bilder; Videos nutzen die Pauschale oben), wird nur geprüft, ob noch etwas übrig ist; einige parallele Jobs einer Person können das Budget daher um ihren eigenen Preis überschreiten. Die echten Kosten werden danach verbucht, und die nächste Aktion wird abgelehnt.

**Chats und Workflows nach Team (Admins).** Admins sehen alle Chats und Workflows. Ein Umschalter «Projekte | Teams» über der Chat-Liste und der Workflow-Liste der Node-Ansicht gruppiert sie nach Team (Standard: «Projekte»; die Wahl merkt sich der Browser pro Ansicht). Jedes Team ist eine aufklappbare Gruppe mit der Anzahl Chats bzw. Workflows und Personen; archivierte Teams folgen zugeklappt, alles ohne Team (Besitzer ohne Team, Gäste, alte Daten ohne Besitzer) steht zuletzt als «Intern»; jeder Eintrag nennt seine Besitzerin oder seinen Besitzer. Alle anderen bekommen weder Umschalter noch Team-Angaben (der Server lehnt die Gruppen-Routen mit `403` ab). Welches Team gilt: Neue Chats und Workflows speichern `teamId`, das aktive Team der anlegenden Person (bei mehreren das zuletzt beigetretene); nur der Server setzt es, keine Anfrage kann es (auch nicht beim Import, wo ein `teamId` in der Datei verworfen wird, und nicht beim Duplizieren: das speichert das Team der duplizierenden Person). Einträge ohne `teamId` gehören zum Team der Besitzerin oder des Besitzers zum Zeitpunkt der Erstellung: die Mitgliedschaft mit dem spätesten `addedAt`, das nicht nach `createdAt` liegt (archivierte Teams zählen), sonst die früheste spätere, sonst «Intern». Ein gespeichertes Team, das gelöscht wurde, schickt den Eintrag nach «Intern»; wer aus einem Team entfernt wird, verliert die abgeleitete Zuordnung älterer Einträge, die gespeicherte bleibt. Die Gruppen sind vollständig, auch wenn die Chat-Liste seitenweise lädt (sie kommen aus dem Index der Session-Dateien im Speicher, keine Datei wird neu gelesen). Der Tastaturfokus bleibt auf dem Gruppenkopf oder auf «Mehr laden», wenn eine Gruppe auf- oder zugeklappt oder erweitert wird; die Antwort für eine Gruppe, die vor dem Löschen eines Chats gelesen wurde, wird verworfen und neu gelesen. In der Team-Ansicht heisst die Seitenleiste «Chats».

**API** (nur Admins, sofern nicht anders vermerkt; `sync` ist der Zustand des Freigabelisten-Syncs):

| Route | Zweck |
| --- | --- |
| `GET /api/teams`, `POST /api/teams` | Auflisten / anlegen (`name`, `budgetUsd`, `description`) |
| `GET/PATCH/DELETE /api/teams/:id` | Detail mit dem Budget jeder Person / umbenennen, Betrag ändern, `archived` / löschen |
| `POST /api/teams/:id/members` | `{ emails: [...] }` oder `{ text }`: bis zu 500 auf einmal, Antwort `added`, `already`, `invalid`, `duplicates` |
| `PATCH /api/teams/:id/members/:email` | `{ budgetOverrideUsd: Zahl oder null }` oder `{ resetBudget: true }` |
| `DELETE /api/teams/:id/members/:email` | Person entfernen |
| `GET /api/teams/mine` | Alle Angemeldeten: die Teams, mit denen sie teilen dürfen |
| `GET /api/sessions/team-groups` | Die Gruppen der Chat-Liste: `{ groups: [{ id, name, archived, internal, count, people, lastActivity }], total }`, aktive Teams nach letzter Aktivität, dann archivierte, zuletzt `id: "none"` (Intern) |
| `GET /api/sessions?team=<id\|none>&limit=&offset=` | Die Chats einer Gruppe, seitenweise; jeder Chat trägt `team: { id, name, archived }` oder `null`. Mit `q=…&teams=1` trägt auch die flache Suche das Team |
| `GET /api/workflows` | Admins erhalten zusätzlich `team` pro Workflow und `teamGroups` (gleiche Kopfdaten); die Liste ist nicht seitenweise, der Client gruppiert |
| `POST /api/users` | Auch `{ emails: [...] }` / `{ text }` für die Team-Liste (derselbe Parser) |
| `GET /api/admin/monitoring?team=<id>` | Superadmins: Nutzung und Budget-Bild pro Team und Person (`teams`, `options.teams`) |

Eingefügte Listen (Excel-Spalten, Outlook-/Gmail-Empfängerlisten, CSV, eine Adresse pro Zeile) liest ein gemeinsamer Parser (`public/email-list.js`, im Browser und auf dem Server): Kleinschreibung, Doppelte nur einmal, Stücke ohne Adresse als `invalid` gemeldet.

Daten: `data/teams.json` (chmod 600, atomar geschrieben), `data/folder-owners.json` (wer ein Projekt angelegt hat) und `data/access-sync.json`. Fehler: `400` mit `INVALID_TEAM`, `INVALID_BUDGET`, `TEAM_NAME_TAKEN`, `NO_EMAILS`, `INVALID_EMAILS`, `TOO_MANY_EMAILS`, `TEAM_FULL`, `SHARE_MODE_FORBIDDEN`, `UNKNOWN_TEAMS`; `404` mit `TEAM_NOT_FOUND`, `MEMBER_NOT_FOUND`.

### Freigabelisten-Sync (optional)

Teilnehmer haben Adressen, die dein Login nicht kennt. Führt dein Login eine Freigabelisten-Datei (`{ "default": {...}, "routes": [{ "path": "/training", "public": false, "extra_emails": [...] }] }`), setze `ACCESS_ALLOWLIST_FILE` (Pfad) und `ACCESS_ALLOWLIST_ROUTE` (Route). Nach jeder Änderung an einem Team hält die App dann `extra_emails` dieser Route auf den von Hand gepflegten Adressen plus allen Mitgliedern aktiver Teams (Adressen aus `INTERNAL_EMAIL_DOMAINS` werden nicht eingetragen). Manuelle Einträge und andere Routen bleiben unangetastet: Nur was die App selbst eingetragen hat, wird wieder entfernt (gemerkt in `data/access-sync.json`, vor der Änderung der Liste geschrieben und zusätzlich als Kopie neben der Liste; ein unlesbarer Status stoppt den Sync mit einer Warnung). Die Datei wird atomar geschrieben (ein Symlink wird aufgelöst; der Eigentümer bleibt erhalten, soweit die App ihn setzen darf; eine in einen Container eingehängte Einzeldatei wird direkt überschrieben), behält ihre Rechte, und vor der ersten Änderung entsteht einmal eine Kopie `<Datei>.bak-<Zeitstempel>`; eine fehlende Route wird angelegt. Ein Fehler blockiert die Team-Änderung nie — er erscheint als Warnung in `sync`. Sind beide Variablen nicht gesetzt, passiert nichts.

## Hilfe und Mitarbeit

Die Hilfe-Seite (`public/help.html`, im Menü verlinkt) beschreibt alle Funktionen auf Deutsch, Englisch und Spanisch. Wer eine Funktion ändert, führt alle drei Sprachblöcke nach; siehe [docs/agent-rules.md](docs/agent-rules.md).

## Lizenz

[MIT](LICENSE) © 2026 Kuble AG — gebaut vom [Kuble](https://kuble.com)-Team mit Claude Code und Codex.
