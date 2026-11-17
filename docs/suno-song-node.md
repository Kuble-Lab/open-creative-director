# Song direkt mit Suno erstellen (Node und Vorlage)

Der Node «Song erstellen (Suno)» (`suno.song`) macht aus einem Songpaket (Text mit den Blöcken TITLE, STYLE, EXCLUDE und LYRICS) einen fertigen Song in der Sitzung. Die Vorlage «Song mit Suno» (`suno-song`) verbindet das Songpaket der Vorlage «Suno-Songpaket» mit diesem Node: Idee und Sängerin eingeben, Song erhalten.

## Konto und Kosten

Der Node läuft über die persönliche Suno-Verbindung der Person, die den Lauf startet (Account-Menü → Suno, siehe `suno-personal-mcp.md`). Es gibt kein gemeinsames Konto. Suno verrechnet die eigenen Credits der Person; die App berechnet nichts und zählt nichts ins Budget. Der Node ist deshalb als «extern verrechnet» markiert.

## Schutz vor doppelten Ausgaben

- Der offizielle Suno-MCP ist in der Beta und veröffentlicht seine Tool-Schemas nicht. Der Node liest darum vor dem Erstellen die Live-Tool-Liste (`tools/list`) und ordnet Songtext, Stil, Titel und Ausschluss den Feldern zu, die Suno wirklich anbietet. Fehlt das Erstell-Tool oder ein Pflichtfeld, bricht er ab, bevor Credits ausgegeben werden. Kennt Suno kein Ausschlussfeld, wird EXCLUDE weggelassen und im Protokoll genannt.
- Dasselbe Paket derselben Person ist ein Song: Der Schlüssel aus Person, Paket und «Variante» geht als Idempotenzschlüssel an Suno, und die gelieferten Song-IDs werden unter `data/suno/songs/` gemerkt. Ein Lauf nach Zeitüberschreitung oder Abbruch holt denselben Song ab und erstellt nichts neu. Für einen neuen Song aus demselben Paket wird «Variante» erhöht.
- Verlangt Suno für die Datei einen Download-Credit, hält der Node an. Erst mit dem Schalter «Download-Credit erlauben» bestätigt er den Download.
- Die Datei wird nur per HTTPS von Suno-Hosts (`suno.ai`, `suno.com`, dazu `SUNO_AUDIO_HOSTS`) geladen, mit Grössenlimit und Prüfung des Dateityps.

## Ausgänge

`audio` ist der Song (Suno liefert zwei Fassungen als Varianten), `lyrics` der gesungene Text für «Songtext-Zeiten». Damit passt der Node an die Stelle des Song-Uploads in den HUD-Musikvideos.

## Vorlage «Musikvideo im HUD-Stil (Song direkt mit Suno)»

Die Vorlage `music-video-hud-suno-direct` ist der Film von `music-video-hud-suno`, aber ohne Upload: Der Node «Song erstellen (Suno)» steht an der Stelle des Song-Uploads (`n1`). Das Songpaket (`n28`) speist ihn, sein Ausgang `lyrics` geht an «Songtext-Zeiten» (`n3`), sein Ausgang `audio` an alle Stellen, die den Song brauchen, und an einen eigenen Ausgang «Song» (`n32`). Die App-Ansicht hat vier Schritte: 1 Songpaket lesen, 2 Song von Suno anhören, 3 Board, Figurenblatt und Bilder freigeben, 4 der Rest. Es wird eine Fassung geholt (`takes: 1`), und der Download-Credit ist erlaubt (`allow_download_credit: true`, im Formular abschaltbar), weil der Film ohne die Datei nicht weitergeht. Die Vorlage `music-video-hud-suno` mit Upload bleibt für alle, die kein Suno-Konto verbunden haben.

In der Vorlage «Song mit Suno» steht der Schalter «Download-Credit erlauben» seit dieser Änderung auch im Formular der App-Ansicht.

## Stand der Abnahme

Erster echter Lauf am 17.11.2026 auf Maniak (Premier-Konto): Die Tool-Namen `audio-create`, `audio-retrieve` und `audio-download` stimmen. Ein Song kostete 10 Suno-Credits. `audio-retrieve` liefert keine Datei; die Datei kommt über `audio-download`, das einen Download-Credit verlangt (`requires_credit`, dann `confirm: true`). Ein wiederholter Download desselben Songs wurde nicht nochmals belastet. Der Link zeigt auf `suno-data-uploads.s3.amazonaws.com`. Die Tests verwenden weiterhin simulierte Suno-Antworten.
