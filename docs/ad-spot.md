# Werbespot (Story-Spot mit Jingle-Schalter)

Die Vorlagen «Werbespot» (`ad-spot`, 16:9) und «Werbespot (Hochformat)» (`ad-spot-portrait`, 9:16) machen aus einem Briefing einen fertigen Spot von 6 bis 60 Sekunden (Standard 15).

## Ablauf

1. **Werbespot planen** (`ad.plan`): schreibt das Skript mit Hook (höchstens 2.5 s), Einstellungen, Sprechertext, Musik und Schlussbild. Die Zeiten rechnet der Code, die Summe stimmt immer mit der gewählten Länge überein. 15 Sekunden ergeben 4 Einstellungen und 3 Sekunden Schlussbild, 30 Sekunden 9 Einstellungen und 4 Sekunden Schlussbild.
2. **Bilder der Einstellungen** (`image.generate`): ein Bild pro Einstellung, die Produktfotos gehen als Referenz mit.
3. **Clips der Einstellungen** (`magnific.video`, Seedance Pro 2.5 über Magnific): ein Clip von 5 Sekunden pro Bild. Über Magnific, weil Seedance über OpenRouter Bilder ablehnt, auf denen eine echte Person zu sehen sein könnte (auch erzeugte Bilder mit Menschen); abgerechnet in Magnific-Credits.
4. **Sprecher** (`audio.tts`), **Musik oder Jingle** (`ad.music`), **Ton des Spots** (`ad.soundtrack`): eine Tonspur in exakt der Länge des Spots, die Musik wird unter der Stimme leiser.
5. **Schlussbild** (`ad.endcard`): Logo, Claim, Handlungsaufruf und Webadresse in den Farben und Schriften der Marke. Der Text kommt unverändert aus dem Skript, kein Modell schreibt ihn.
6. **Spot schneiden** (`music_video.edit`): harte Schnitte auf die geplanten Zeiten, das Schlussbild am Ende.

## Der Musik-Schalter

Der Parameter «Musik» von «Werbespot planen» entscheidet:

- **Instrumental**: Der Planer gibt eine Musikbeschreibung aus, ElevenLabs macht daraus Musik in der Länge des Spots (bezahltes ElevenLabs-Abo nötig).
- **Jingle**: Der Planer gibt ein Songpaket aus, Suno macht daraus einen gesungenen Jingle über das eigene Suno-Konto der Person (etwa 10 Suno-Credits und ein Download-Credit, die App berechnet nichts). Die Stimme spricht dann nur den Schlusssatz auf dem Schlussbild.
- **Keine**: nur die Stimme.

Technisch füllt der Planer immer nur einen der beiden Ausgänge «Musik-Prompt» und «Jingle-Paket»; der andere bleibt leer (`emptyOutputs`). Beide sind mit «Spot-Musik» verbunden.

## Plan ändern

Das Skript aus dem Ausgang «Skript» ins Feld «Skript (bearbeitet)» kopieren, Texte ändern und den Planer erneut starten. Ein gefülltes Feld wird nur geprüft, ohne Modellaufruf und ohne Kosten. Länge und Format des Skripts gelten dann vor den Einstellungen des Nodes; «Musik» muss zum Skript passen.

## App-Ansicht

Das Formular fragt Briefing, Produktfotos, Branding, Länge, Musik, Tonalität, Sprache und Stimme ab. Der Lauf hält zweimal an: nach dem Storyboard und nach den Bildern, bevor die Clips bezahlt werden.

## Noch nicht enthalten

Mehrere Hook-Varianten zur Auswahl, die Ausgabe in mehreren Formaten aus einem Lauf und der Neudreh einzelner Einstellungen aus einer Szenenliste.

## Tests

`node scripts/run-tests.js test-ad-spot` prüft den Planer, die vier Nodes mit einem Modell-Double, das Schlussbild und schneidet mit echtem ffmpeg einen Spot von 15 Sekunden.
