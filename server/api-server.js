'use strict';
// An API-only AgentSys Server: no GUI assets, no browser storage endpoint, no plugin loader.
const {createServer} = require('../server');

/**
 * Creates the server program. Options are the same as createServer's storage/auth options:
 * {dataDir, host, token, allowedHosts, allowedOrigins, tls, name, serverVersion, sessionTtlMs}.
 */
function createApiServer(options = {}) {
  return createServer({
    ...options,
    serveClient: false,
    legacyStorage: false,
  });
}

module.exports = {createApiServer};
