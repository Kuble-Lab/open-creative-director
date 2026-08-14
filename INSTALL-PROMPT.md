# Install prompt / Installations-Prompt

Copy the block below into **Claude Code**, **Codex** or any other coding agent running on your computer — the agent will install and start Open Creative Director for you. / Kopiere den Block unten in **Claude Code**, **Codex** oder einen anderen Coding-Agenten auf deinem Rechner — der Agent installiert und startet Open Creative Director für dich.

## English

```text
Install and run the open-source app "Open Creative Director" on this machine:

1. Check that Node.js >= 22 is installed (node --version). If not, install the current
   LTS version (macOS: `brew install node`, Windows: `winget install OpenJS.NodeJS.LTS`,
   Linux: package manager or nvm).
2. Clone https://github.com/Kuble-Lab/open-creative-director.git into a sensible
   projects folder and run `npm install` inside it.
3. Copy .env.example to .env. Then STOP and ask me for my OpenRouter API key
   (I can create one at https://openrouter.ai/keys). I will paste it into the .env
   file myself, or hand it to you to insert — never store it anywhere else and never
   echo it back.
4. Optional (ask me, don't assume): ELEVENLABS_API_KEY for text-to-speech.
   Everything else in .env.example is optional and can stay empty.
5. Start the app with `npm start` as a background process and confirm that
   http://localhost:3111 responds.
6. Open http://localhost:3111 in my browser. Give me a one-paragraph tour:
   how to start my first production in the chat, where the ✨ prompt presets are,
   and that ⚙️ Settings lets me add keys later and connect my Higgsfield account
   with one click (no API key needed).
7. If ffmpeg is missing, mention (don't install unless I say yes) that installing
   it enables automatic visual consistency checks on finished videos.
```

## Deutsch

```text
Installiere und starte die Open-Source-App «Open Creative Director» auf diesem Rechner:

1. Pruefe, ob Node.js >= 22 installiert ist (node --version). Falls nicht, installiere
   die aktuelle LTS-Version (macOS: `brew install node`, Windows:
   `winget install OpenJS.NodeJS.LTS`, Linux: Paketmanager oder nvm).
2. Klone https://github.com/Kuble-Lab/open-creative-director.git in einen sinnvollen
   Projektordner und fuehre darin `npm install` aus.
3. Kopiere .env.example nach .env. Dann STOPP: Frag mich nach meinem OpenRouter-API-Key
   (erstellbar auf https://openrouter.ai/keys). Ich trage ihn selbst in die .env ein
   oder gebe ihn dir zum Eintragen — speichere ihn nirgendwo sonst und gib ihn nie aus.
4. Optional (frag mich, nimm nichts an): ELEVENLABS_API_KEY fuer Text-to-Speech.
   Alles andere in .env.example ist optional und darf leer bleiben.
5. Starte die App mit `npm start` als Hintergrundprozess und pruefe, dass
   http://localhost:3111 antwortet.
6. Oeffne http://localhost:3111 in meinem Browser. Gib mir eine kurze Tour:
   wie ich im Chat meine erste Produktion starte, wo die ✨-Prompt-Vorlagen sind,
   und dass ich in den ⚙️ Einstellungen spaeter Keys ergaenzen und mein
   Higgsfield-Konto mit einem Klick verbinden kann (kein API-Key noetig).
7. Falls ffmpeg fehlt: Erwaehne (aber installiere nur nach meinem Ja), dass es
   automatische Konsistenz-Checks auf fertigen Videos aktiviert.
```
