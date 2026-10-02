'use strict';

// Test support (not a test): the protection rule of every route of the app, shared by the tests of the user
// management (scripts/test-user-management.js) and of the teams (scripts/test-teams-api.js). A test fails when a route is
// added, removed or renamed without deciding here how it is protected, so a new route can never be forgotten.
//
// ROUTE_RULES: the rule for the roles admin, internal user and anonymous (the user management as it has been).
// PARTICIPANT_RULES: the decision for participants (people in an active team) and guests (no team, not internal),
// see lib/access.js. Both tables list the same routes.

// Every route of the app with its protection rule. The test fails when a route is added, removed or renamed
// without deciding here how it is protected, so a new route can never be forgotten.
//   public      answers the same for everybody, no data of a person (also without a login)
//   open        any caller of the app; the answer is filtered by what the caller may see, or holds nothing private
//   admin       admins (superadmins included); 403 for everybody else
//   superadmin  superadmins only; 404 for everybody else
//   identified  any identified person (403 for anonymous callers)
//   session     access rule of the chat: 404 unless usable; 403 if managing / sharing rights are missing
//   workflow    access rule of the workflow (same)
//   folder      the project folder: visible only with an entry the caller may see (404), rename / delete need
//               admin rights or that every entry is the caller's
const ROUTE_RULES = {
  'GET /refs/:file': 'public', // Seedance needs a public URL; the file name is an unguessable token
  'GET /api/prompt-presets': 'open',
  'POST /api/prompt-presets/custom': 'admin',
  'PUT /api/prompt-presets/custom/:id': 'admin',
  'DELETE /api/prompt-presets/custom/:id': 'admin',
  'GET /api/config': 'open',
  'GET /api/settings': 'admin',
  'PUT /api/settings': 'admin',
  'PUT /api/settings/preferences': 'admin',
  'GET /api/admins': 'admin',
  'POST /api/admins': 'admin',
  'DELETE /api/admins/:email': 'admin',
  'GET /api/me': 'public',
  'GET /api/team': 'identified',
  'GET /api/teams/mine': 'identified',
  'GET /api/teams': 'admin',
  'POST /api/teams': 'admin',
  'GET /api/teams/:id': 'admin',
  'PATCH /api/teams/:id': 'admin',
  'DELETE /api/teams/:id': 'admin',
  'POST /api/teams/:id/members': 'admin',
  'PATCH /api/teams/:id/members/:email': 'admin',
  'DELETE /api/teams/:id/members/:email': 'admin',
  'GET /api/users': 'admin',
  'POST /api/users': 'admin',
  'DELETE /api/users/:email': 'admin',
  'GET /api/rendernode/status': 'open',
  'GET /api/rendernodes': 'admin',
  'POST /api/rendernodes': 'admin',
  'PATCH /api/rendernodes/:id': 'admin',
  'DELETE /api/rendernodes/:id': 'admin',
  'GET /api/higgsfield/status': 'admin',
  'POST /api/higgsfield/connect': 'admin',
  'GET /api/higgsfield/oauth/callback': 'admin', // browser callback of the admin's own login
  'DELETE /api/higgsfield/auth': 'admin',
  'GET /api/chatgpt/status': 'admin',
  'POST /api/chatgpt/import': 'admin',
  'POST /api/chatgpt/disconnect': 'admin',
  'GET /api/costs/summary': 'open', // admins: everything; everybody else: only their own costs
  'GET /api/admin/monitoring': 'superadmin',
  'GET /api/admin/monitoring/export': 'superadmin',
  'GET /api/gts/search': 'open',
  'GET /api/brandings': 'open',
  'POST /api/brandings/import': 'admin',
  'GET /api/roles': 'open',
  'GET /api/roles/default': 'open',
  'POST /api/roles': 'admin',
  'PUT /api/roles/:id': 'admin',
  'DELETE /api/roles/:id': 'admin',
  'POST /api/roles/generate': 'admin',
  'GET /api/brandings/:id/export': 'open',
  'GET /api/brandings/:id/assets/:filename': 'open',
  'GET /api/brandings/:id': 'open',
  'DELETE /api/brandings/:id': 'admin',
  'GET /api/folders': 'folder',
  'POST /api/folders': 'open', // an empty project holds nothing private
  'PATCH /api/folders/:name': 'folder',
  'DELETE /api/folders/:name': 'folder',
  'GET /api/folders/:name/cast': 'folder',
  'DELETE /api/cast/:id': 'admin',
  'GET /api/folders/:name/profile': 'folder',
  'PUT /api/folders/:name/profile': 'admin',
  'POST /api/folders/:name/profile/context-files': 'admin',
  'DELETE /api/folders/:name/profile/context-files/:fileId': 'admin',
  'DELETE /api/folders/:name/profile/memory/:id': 'admin',
  'GET /api/sessions': 'session', // filtered list
  'GET /api/sessions/team-groups': 'admin', // WP22: the groups of the team view
  'POST /api/sessions': 'session', // creates a private chat
  'PATCH /api/sessions/:id': 'session',
  'PATCH /api/sessions/:id/share': 'session',
  'GET /api/sessions/:id': 'session',
  'GET /api/sessions/:id/jobs': 'session',
  'GET /api/sessions/:id/context': 'session',
  'POST /api/sessions/:id/context': 'session',
  'DELETE /api/sessions/:id/context/:brainId': 'session',
  'POST /api/sessions/:id/context-files': 'session',
  'DELETE /api/sessions/:id/context-files/:fileId': 'session',
  'DELETE /api/sessions/:id': 'session',
  'POST /api/sessions/:id/message': 'session',
  'POST /api/sessions/:id/video-model-requests/:requestId': 'session', // the click on a model of the picker card
  'POST /api/sessions/:id/video-model-requests/:requestId/cancel': 'session',
  'DELETE /api/sessions/:id/video-model-preference': 'session',
  'GET /api/nodes/registry': 'public',
  'GET /api/nodes/options/:source': 'open',
  'GET /api/nodes/higgsfield-models/:modelId': 'open',
  'GET /api/workflow-templates': 'public',
  'GET /api/workflow-templates/:id': 'open', // the document of one template
  'GET /api/workflows': 'workflow', // filtered list
  'POST /api/workflows': 'workflow', // creates a private workflow
  'POST /api/workflows/import': 'workflow',
  'POST /api/workflows/import-zip': 'workflow',
  'GET /api/workflows/:id': 'workflow',
  'PUT /api/workflows/:id': 'workflow',
  'PATCH /api/workflows/:id': 'workflow',
  'DELETE /api/workflows/:id': 'workflow',
  'POST /api/workflows/:id/duplicate': 'workflow',
  'GET /api/workflows/:id/export': 'workflow',
  'GET /api/workflows/:id/export-info': 'workflow',
  'GET /api/workflows/:id/export.zip': 'workflow',
  'PATCH /api/workflows/:id/share': 'workflow',
  'POST /api/workflows/:id/uploads': 'workflow',
  'POST /api/workflows/:id/import-asset': 'workflow',
  'GET /api/workflows/:id/assets': 'workflow',
  'GET /api/workflows/:id/send-to-chat/plan': 'workflow',
  'POST /api/workflows/:id/send-to-chat': 'workflow',
  'POST /api/workflows/:id/runs/plan': 'workflow',
  'POST /api/workflows/:id/runs': 'workflow',
  'GET /api/workflows/:id/runs': 'workflow',
  'GET /api/workflows/:id/outputs.zip': 'workflow',
  'GET /api/workflows/:id/runs/:runId': 'workflow',
  'POST /api/workflows/:id/runs/:runId/cancel': 'workflow',
  'PATCH /api/workflows/:id/results/:nodeId': 'workflow',
  'GET /api/workflows/:id/events': 'workflow',
  'GET *': 'public' // the single page app shell
};

// What participants and guests get on each route (the same decision for both unless GUEST_DIFFERENCES says otherwise).
//   same        the rule of ROUTE_RULES applies as it is (resources of the caller: chats, workflows and projects by the
//               access rules for participants; existing data without an owner is invisible for them)
//   admin       403, admins only
//   superadmin  404
//   public      answers as for everybody, no internal data
//   filtered    200 with the internal part removed (details are tested one by one)
//   empty       200 with an empty collection
//   notfound    404, the resource does not exist for them
//   forbidden   403 with the code FORBIDDEN_FOR_ROLE (internal resource, Higgsfield ...)
//   own         only their own data
const PARTICIPANT_RULES = {
  'GET /refs/:file': 'public',
  'GET /api/prompt-presets': 'filtered', // no custom (team) templates
  'POST /api/prompt-presets/custom': 'admin',
  'PUT /api/prompt-presets/custom/:id': 'admin',
  'DELETE /api/prompt-presets/custom/:id': 'admin',
  'GET /api/config': 'filtered', // no ChatGPT subscription models, no GTS
  'GET /api/settings': 'admin',
  'PUT /api/settings': 'admin',
  'PUT /api/settings/preferences': 'admin',
  'GET /api/admins': 'admin',
  'POST /api/admins': 'admin',
  'DELETE /api/admins/:email': 'admin',
  'GET /api/me': 'filtered', // adds participant, teams and budget
  'GET /api/team': 'filtered', // the members of their own teams
  'GET /api/teams/mine': 'own',
  'GET /api/teams': 'admin',
  'POST /api/teams': 'admin',
  'GET /api/teams/:id': 'admin',
  'PATCH /api/teams/:id': 'admin',
  'DELETE /api/teams/:id': 'admin',
  'POST /api/teams/:id/members': 'admin',
  'PATCH /api/teams/:id/members/:email': 'admin',
  'DELETE /api/teams/:id/members/:email': 'admin',
  'GET /api/users': 'admin',
  'POST /api/users': 'admin',
  'DELETE /api/users/:email': 'admin',
  'GET /api/rendernode/status': 'filtered', // totals without the names of the render nodes
  'GET /api/rendernodes': 'admin',
  'POST /api/rendernodes': 'admin',
  'PATCH /api/rendernodes/:id': 'admin',
  'DELETE /api/rendernodes/:id': 'admin',
  'GET /api/higgsfield/status': 'admin',
  'POST /api/higgsfield/connect': 'admin',
  'GET /api/higgsfield/oauth/callback': 'admin',
  'DELETE /api/higgsfield/auth': 'admin',
  'GET /api/chatgpt/status': 'admin',
  'POST /api/chatgpt/import': 'admin',
  'POST /api/chatgpt/disconnect': 'admin',
  'GET /api/costs/summary': 'own',
  'GET /api/admin/monitoring': 'superadmin',
  'GET /api/admin/monitoring/export': 'superadmin',
  'GET /api/gts/search': 'forbidden',
  'GET /api/brandings': 'empty',
  'POST /api/brandings/import': 'admin',
  'GET /api/roles': 'empty', // only the standard role (GET /api/roles/default)
  'GET /api/roles/default': 'public',
  'POST /api/roles': 'admin',
  'PUT /api/roles/:id': 'admin',
  'DELETE /api/roles/:id': 'admin',
  'POST /api/roles/generate': 'admin',
  'GET /api/brandings/:id/export': 'notfound',
  'GET /api/brandings/:id/assets/:filename': 'notfound',
  'GET /api/brandings/:id': 'notfound',
  'DELETE /api/brandings/:id': 'admin',
  'GET /api/folders': 'own', // projects they created or that hold something shared with them
  'POST /api/folders': 'own',
  'PATCH /api/folders/:name': 'own',
  'DELETE /api/folders/:name': 'own',
  'GET /api/folders/:name/cast': 'own', // the cast of a project they created
  'DELETE /api/cast/:id': 'admin',
  'GET /api/folders/:name/profile': 'filtered', // production profile only for a project they created
  'PUT /api/folders/:name/profile': 'admin',
  'POST /api/folders/:name/profile/context-files': 'admin',
  'DELETE /api/folders/:name/profile/context-files/:fileId': 'admin',
  'DELETE /api/folders/:name/profile/memory/:id': 'admin',
  'GET /api/sessions': 'same', // ?team= is for admins (403 for everybody else)
  'GET /api/sessions/team-groups': 'admin',
  'POST /api/sessions': 'same',
  'PATCH /api/sessions/:id': 'same',
  'PATCH /api/sessions/:id/share': 'same',
  'GET /api/sessions/:id': 'same',
  'GET /api/sessions/:id/jobs': 'same',
  'GET /api/sessions/:id/context': 'filtered', // no GTS titles
  'POST /api/sessions/:id/context': 'forbidden',
  'DELETE /api/sessions/:id/context/:brainId': 'same',
  'POST /api/sessions/:id/context-files': 'same',
  'DELETE /api/sessions/:id/context-files/:fileId': 'same',
  'DELETE /api/sessions/:id': 'same',
  'POST /api/sessions/:id/message': 'same', // plus the budget (402) and no ChatGPT models (403)
  'POST /api/sessions/:id/video-model-requests/:requestId': 'same', // plus the budget (402): an option over what is left is refused
  'POST /api/sessions/:id/video-model-requests/:requestId/cancel': 'same',
  'DELETE /api/sessions/:id/video-model-preference': 'same',
  'GET /api/nodes/registry': 'filtered', // Higgsfield nodes marked as not available
  'GET /api/nodes/options/:source': 'filtered', // Higgsfield sources 403, models without ChatGPT, library voices only
  'GET /api/nodes/higgsfield-models/:modelId': 'forbidden',
  'GET /api/workflow-templates': 'filtered', // no template with Higgsfield nodes
  'GET /api/workflow-templates/:id': 'filtered', // 403 for such a template
  'GET /api/workflows': 'same',
  'POST /api/workflows': 'same',
  'POST /api/workflows/import': 'same',
  'POST /api/workflows/import-zip': 'same',
  'GET /api/workflows/:id': 'same',
  'PUT /api/workflows/:id': 'same',
  'PATCH /api/workflows/:id': 'same',
  'DELETE /api/workflows/:id': 'same',
  'POST /api/workflows/:id/duplicate': 'same',
  'GET /api/workflows/:id/export': 'same',
  'GET /api/workflows/:id/export-info': 'same',
  'GET /api/workflows/:id/export.zip': 'same',
  'PATCH /api/workflows/:id/share': 'same',
  'POST /api/workflows/:id/uploads': 'same',
  'POST /api/workflows/:id/import-asset': 'same',
  'GET /api/workflows/:id/assets': 'same',
  'GET /api/workflows/:id/send-to-chat/plan': 'same',
  'POST /api/workflows/:id/send-to-chat': 'same',
  'POST /api/workflows/:id/runs/plan': 'same', // plus the budget and the blocked nodes in the plan
  'POST /api/workflows/:id/runs': 'same', // plus the budget (402) and no Higgsfield nodes (403)
  'GET /api/workflows/:id/runs': 'same',
  'GET /api/workflows/:id/outputs.zip': 'same',
  'GET /api/workflows/:id/runs/:runId': 'same',
  'POST /api/workflows/:id/runs/:runId/cancel': 'same',
  'PATCH /api/workflows/:id/results/:nodeId': 'same',
  'GET /api/workflows/:id/events': 'same',
  'GET *': 'public'
};

const PARTICIPANT_RULE_NAMES = ['same', 'admin', 'superadmin', 'public', 'filtered', 'empty', 'notfound', 'forbidden', 'own'];

module.exports = { ROUTE_RULES, PARTICIPANT_RULES, PARTICIPANT_RULE_NAMES };
