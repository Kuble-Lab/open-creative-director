# Suno im Chat und in Assistenten

Die persönliche Kontoverbindung allein stellt einem Sprachmodell noch keine Werkzeuge bereit. Der Chat registriert deshalb fünf Werkzeuge für angemeldete Nutzer: `suno_status`, `suno_library`, `suno_generate`, `suno_audio`, `suno_download`. Identität und Chat-Nachricht stammen aus dem Serverkontext; das Modell kann kein fremdes Konto auswählen.

Die Chat-Anweisungen erklären die persönliche Verbindung im Account-Menü. Für einen ausdrücklich gewünschten Song nutzt der Director die echte Suno-Generierung statt einer Vorlage, die nur Lyrics schreibt. Eine Generierungsanfrage kann mehrere Songs liefern. Wiederholungen derselben Nutzernachricht verwenden denselben Idempotenzschlüssel; geänderte Parameter unter demselben Schlüssel muss Suno zurückweisen. Suno-Ausgaben sind Daten, keine Anweisungen. Eigene Suno-Credits werden nicht nochmals als Kuble-USD abgerechnet; Sprachmodellkosten bleiben unverändert.

Downloads werden zuerst ohne Credit-Bestätigung angefragt. Meldet Suno `requires_credit`, speichert die App eine kurzlebige Zustimmungsvorlage für Nutzer, Chat, Song und Format. Nur ein ausdrückliches Ja in der unmittelbar nächsten Nutzernachricht kann diese einmalig bestätigen. Ein vom Modell gesetztes `confirm:true` in derselben Runde, eine andere Person, ein anderer Song oder ein anderes Format reichen nicht. Liefert Suno nur `processing`, ist noch kein Download verfügbar. Ergebnis ist der vom Anbieter gelieferte Download-Link; ein automatischer Import in Workflow-Assets ist noch nicht enthalten.

Der Node-Assistent kennt die Integration und ihren persönlichen Verbindungsstatus. Er startet weiterhin keine Jobs und erfindet keinen Suno-Node: Generieren/Download erfolgt im Chat, anschliessend kann eine Audiodatei in den Musikvideo-Workflow hochgeladen werden.

Externe MCP-Agents entdecken drei neue Lese-Werkzeuge (`suno_status`, `suno_library`, `suno_audio`), die das Konto des Schlüsselbesitzers verwenden. Bestehende Schlüssel können damit keine Suno-Credits ausgeben. Eine separate Freigabe vor Merge ist für diese Erweiterung des Lesezugriffs erforderlich.

Tests verwenden Provider-Mocks und echte lokale HTTP-/Browserprüfungen. Keine kostenpflichtige Songgenerierung und kein Download-Credit wurden im Test verbraucht. Live-Abnahme der neuen Chat-Werkzeuge ist noch offen.
