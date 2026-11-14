'use strict';
// The server runtime is a fixed, documented set of files. It is deliberately not read from index.html: the
// client and the server are separate programs, and a client asset can never add server code.
//
// Order matters: shared helpers, storage, the graph model, then the API surface.
const FILES = [
  'shared/core.js',
  'js/storage/db.js',
  'js/storage/format.js',
  'js/model/schema.js',
  'js/model/types.js',
  'js/model/snapshot.js',
  'js/model/documents.js',
  'js/model/editor.js',
  'js/model/evaluate.js',
  'js/model/executor.js',
  'js/backend/settings.js',
  'js/backend/resources.js',
  'js/backend/permissions.js',
  'js/backend/scripts.js',
  'js/backend/runtime.js',
  'js/backend/routes-app.js',
  'js/backend/routes-projects.js',
  'js/backend/execution.js',
  'js/backend/routes-workflow.js',
  'js/backend/routes-library.js',
  'js/backend/routes-permissions.js',
  'js/backend/routes-exchange.js',
  'js/backend/routes-notifications.js',
  'js/backend/routes-collections.js',
  'js/backend/builtin-nodes.js',
  'js/backend/graph-nodes.js',
  'js/backend/routes-builtin.js',
];

/** Server-only files: the client server and the combined local server never send these to a browser. */
const SERVER_ONLY =
  /^(?:server\.js$|js\/storage\/db\.js$|js\/model\/executor\.js$|js\/backend\/|server\/|bin\/|legacy\/|headless\.js$)/;

module.exports = {FILES, SERVER_ONLY};
