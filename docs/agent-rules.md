# Rules for agents and contributors

Short rules that keep the interface and its documentation in step.

## Help page

- `public/help.html` documents every function for people, in **German, English and Spanish**. It has three complete language blocks with the **same sections** (same `data-section` ids, same order).
- Whoever changes a function (a button, a menu entry, a dialog, a rule about who may do what) updates the help in **all three blocks** in the same change.
- `scripts/test-help.js` checks that the blocks match and that no sharp s (ß) is used. Run it with the other tests.
- Teams and budget have their own sections (`teams` for admins, `budget` for participants) right after `sharing`. A change to the teams interface, the budget rules or the sharing modes updates them (and the bullets in `sharing`, `account`, `settings` and `monitoring`).

## Texts

- All interface texts live in `public/i18n.js` and `public/nodes/i18n-nodes.js`, in DE, EN and ES. Swiss spelling (no ß). `scripts/test-i18n.js` and `scripts/test-nodes-i18n.js` check this.
- No `innerHTML` with data that comes from people or the server, no native dialogs (`alert`, `confirm`, `prompt`) in new code.

## Interface structure

- One frame for both views: the header of the chat and the top bar of the node view share the view switch (*Chat | Nodes*) and the menu behind the avatar (`public/shell.js`). A new menu entry goes there: `OCShell.addSection('account' | 'workspace' | 'system', builder)`. The section `account` holds the teams entry (`public/teams-ui.js`).
- The settings dialog is divided into groups (`data-settings-group`: services, people, rendering). A new section is a `<section>` inside its group. The teams interface (`public/teams-ui.js`, `OCTeams.mount`) lives in the slot `#settingsTeamsSlot` of the group *people*; the paste box for several addresses (`OCTeams.pasteBox`, parser `public/email-list.js`) is shared by teams and the team list.
- The side menu orders projects by their newest chat (`lastActivity` of `GET /api/folders`); `GET /api/sessions?folder=` lists the chats of one project.
