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
- The agent access dialog (`public/mcp-ui.js`, `#mcpModal`, API `/api/mcp/keys`) opens from the `account` section of the menu for admins, internal people and participants with an enabled participant policy. Guests have no agent access; the team budget always applies to participant runs. Admins configure the participant policy in this dialog (`GET`/`PUT /api/mcp/policy`). It is not part of the settings dialog, which only admins can open. A change to the keys, their rights or limits updates the dialog, the `mcp` section of the help and the README section *Agent access (MCP)*.
- The side menu orders projects by their newest chat (`lastActivity` of `GET /api/folders`); `GET /api/sessions?folder=` lists the chats of one project.

## MCP OAuth

- OAuth public metadata, registration, token and revocation routes mount before whoami/body parsers; GET/POST authorization mounts after whoami and the unconfirmed guard. Never release authorization from the reverse-proxy login.
- Use `lib/mcp/urls.js` for issuer/resource URLs, preserving `PUBLIC_BASE_URL` path prefixes. Keep the four app discovery paths and document host-root nginx aliases in both READMEs. OAuth is off without user management, on insecure public HTTP or with `MCP_OAUTH=off`.
- OAuth connections share the key store, live owner/policy checks, combined per-owner maximum, accounting and revocation semantics. Repeat consent reuses an active owner/client connection ID, resets role defaults and discards its earlier tokens/codes. Refresh scope narrowing must never broaden later grants. Never issue a bearer-key secret for an OAuth connection.
- Credentials are opaque random values, persisted only as SHA-256 digests. Codes are memory-only, 60 seconds and single-use; access tokens last at most one hour (at most five per connection); rotating refresh tokens expire with the connection. Retain only the latest 20 consumed refresh digests per connection for replay detection. The persistent HMAC signing key is the sole OAuth server secret file (0600). Never log credentials, verifiers or redirect query strings.
- CIMD is fetched only for confirmed people: validate every DNS address, pin the built-in transport to them, reject redirects/private ranges, enforce 5 seconds/64 KB, cache at most one hour. Coalesce in-flight URLs, allow at most four concurrent fetches and negative-cache failures for 60 seconds (each cache at most 500 entries). Limit authorization GET/POST per person to 30/10 per minute and refresh per connection to 30 per hour; return 429 with Retry-After before consuming a limited refresh token. All dependencies remain Node/Express only.
- Consent uses the shared DE/EN/ES dictionary, escaped server-rendered HTML, signed person/request-bound CSRF, same-origin POST and security headers. Change UI, all three help blocks and both READMEs together. Run `node scripts/run-tests.js mcp help i18n access --jobs=4`, then `npm test -- --jobs=4`.

## Assistant and agent access share tools

- `lib/mcp/index.js` exports `buildTools(deps)`: the same ordered definitions and handlers serve MCP, the node assistant and the chat Director through `lib/app-tools.js`. Every new MCP tool needs exactly one entry in `POLICY` or `EXCEPTIONS` (with an English reason) in `lib/nodes/assistant-tools.js`. The chat classifies every MCP tool in `lib/chat-workflow-tools.js` as shared, a chat counterpart, or an exception with an English reason. Its only schema adaptation removes the server-owned edit revision. Run `node scripts/run-tests.js chat-workflow-tools agent-parity`.
- The app context is explicit (`app: true`, viewer, no key); role, ownership and participant budget remain service checks. Key accounting and signed MCP file links apply only to key access. The assistant keeps the app's provider rules (`agent: false` for edits), including role-based Higgsfield access.
- Requests without `tools: true` keep the legacy insert-only contract. Tool requests include `steps`, `edit`, `run` and `confirm`; saved edits require the browser revision, runs only prepare a card, external writes/deletions require a single-use, person/workflow-bound confirmation (15 minutes). Never log content or tool arguments/results.
- Effect checks use the offered assistant definitions: `edit_workflow` is reversible with app undo; `run_workflow` only prepares a card. Their MCP destructive/open-world annotations remain unchanged for external agents. Every other destructive/open-world tool must use confirmation; start tools can never be read tools.

- Chat edits use the live server revision and session receipts (`lib/workflow-edits.js`); snapshots contain only graph/app, never go to the model/client, and are limited to 20 per chat and 1 MB each. Undo rechecks live workflow access, revision and active runs, then uses `saveGraph` with a revision check. Creating/duplicating cannot undo (no implicit deletion). Chat `list_workflows` and `run_workflow` stay on their own path; estimates never authorize a run or quote future amounts.
