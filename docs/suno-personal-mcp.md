# Persönlicher Suno-MCP-Zugang

Der Zugang verwendet den offiziellen Endpunkt `https://api.suno.com/mcp` und OAuth Authorization Code mit PKCE S256. Jede Verbindung gehört ausschliesslich der durch `whoami` bestätigten Identität. Auch Admins können über diese Routen keine fremde Verbindung wählen. Lokaler anonymer Betrieb ist ausgeschlossen.

## Einrichtung

`AUTH_WHOAMI_URL` muss aktiv und `PUBLIC_BASE_URL` auf die feste öffentliche HTTPS-Basis der Anwendung gesetzt sein (mit Pfadpräfix, falls vorhanden). Die Rücksprungadresse ist `<PUBLIC_BASE_URL>/api/suno/oauth/callback`. Sunos öffentliche OAuth-Metadaten wurden am 10. November 2026 gelesen; sie weisen einen Endpunkt für dynamische Client-Registrierung aus. Eine echte Client-Registrierung wurde noch nicht ausgeführt. Ein echter Login und die damit gewährten MCP-Tools sind noch nicht getestet.

Der Server registriert beim ersten Verbindungsaufbau einen öffentlichen OAuth-Client. Tokens liegen je Nutzer AES-256-GCM-verschlüsselt in `data/suno/`, mit gebundener Nutzeridentität als AAD. Der lokale Schlüssel hat Modus 0600, das Verzeichnis 0700. Schlüssel und verschlüsselte Datensätze müssen gemeinsam geschützt gesichert werden. Dies schützt nicht vor einem kompromittierten Serverkonto. Keine Zugangsdaten werden im Browser oder Repo gespeichert.

## Schnittstelle

Alle Routen benötigen die bestätigte Nutzeridentität und liefern `Cache-Control: no-store`. Schreibzugriffe benötigen einen passenden Origin-Header. Nutzer-IDs aus URL oder Body werden nicht akzeptiert.

- `GET /api/suno/status`: lokale Verbindung vorhanden.
- `POST /api/suno/connect`: liefert `authorizationUrl`; Anmeldung bei Suno, danach Rücksprung zur App.
- `GET /api/suno/oauth/callback`: prüft Nutzer, einmaligen State, Ablauf und optionalen Issuer.
- `DELETE /api/suno/auth`: entfernt lokale Tokens und offene Anmeldungen des Nutzers. Die App kann danach keine Suno-Aufrufe für ihn ausführen. Eine anbieterseitige Widerrufsfunktion ist nicht implementiert; diese ist zusätzlich im Suno-Konto möglich.
- `GET /api/suno/account`, `/usage`, `/library`: persönliche MCP-Abfragen; Bibliothek mit optionalem Cursor, 20 Einträge pro Seite.

Der interne Client `mcpCall(owner, name, args)` serialisiert je Nutzer Token-Erneuerung, Aufrufe und Trennen. HTTP-Routen exponieren nur die drei genannten Leseoperationen. Es gibt keinen beliebigen Tool-Proxy und keine automatische Generierung oder Ausgabe von Credits.

## Bedienoberfläche

Die persönliche Bedienoberfläche ist im Account-Menü unter «Suno» verfügbar, auch für Teilnehmer und Gäste. Sie zeigt den Status, startet die Anmeldung im gleichen Fenster und trennt die eigene Verbindung nach Bestätigung. Nach dem OAuth-Rücksprung öffnet sich der Dialog erneut. Deutsch, Englisch und Spanisch folgen der App-Sprache. Es gibt kein periodisches Status-Polling.

## Abnahme

Sieben gezielte Testdateien sind grün: Suno-Backend, Suno-Browseroberfläche, whoami, Nutzerverwaltung, Teamrechte, bestehende MCP-Oberfläche und Einstellungen. Der Browsertest verwendet simulierte Suno-Antworten und prüft Teilnehmer/Gäste, Weiterleitung und Rückkehr, Trennen, Fehlerdarstellung, Fokus, Sprachwechsel und mobile Breite.

Kein Deployment. Vor Merge ist gemäss Team-Regel eine zweite verantwortliche Person für die Login-/Rechteänderung erforderlich. Ein Live-Login mit anschliessendem Konten-/Bibliotheksabruf bleibt Teil der Abnahme. Songgenerierung, Download-Freigaben und Workflow-Nodes sind in diesem Zugangspaket noch nicht enthalten.
