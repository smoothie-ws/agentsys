// The contract between an AgentSys client and an AgentSys server. One protocol version covers the HTTP API,
// the event stream and the authentication handshake; the server reports it in /api/meta and every API answer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentSysProtocol = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const NAME = 'AgentSys';
  const PRODUCT = 'agentsys';
  // Bump when a client of the previous version can no longer work against this server.
  const PROTOCOL = 1;
  const VERSION = '0.3.0';
  const META_PATH = '/api/meta';
  const EVENTS_PATH = '/api/events';
  const SESSION_PATH = '/api/auth/session';
  const LOGOUT_PATH = '/api/auth/logout';
  const DEFAULT_PORT = 8080;
  const CLIENT_PORT = 8081;
  const SESSION_COOKIE = 'agentsys_session';
  const HEADER = 'x-agentsys-protocol';
  const CSRF_HEADER = 'x-agentsys';
  const CLIENT_HEADER = 'x-agentsys-client';

  /** True when this client can speak to a server that reports `protocol`. */
  const compatible = protocol => Number.isInteger(protocol) && protocol === PROTOCOL;

  /** A short human-readable reason for an incompatible server, or '' when it is compatible. */
  const incompatibility = protocol => {
    if (!Number.isInteger(protocol)) return 'The server did not report an AgentSys protocol version.';
    if (protocol < PROTOCOL) return `The server speaks protocol ${protocol}; this client needs ${PROTOCOL}. Update the server.`;
    return `The server speaks protocol ${protocol}; this client supports ${PROTOCOL}. Update the client.`;
  };

  return {
    NAME,
    PRODUCT,
    PROTOCOL,
    VERSION,
    META_PATH,
    EVENTS_PATH,
    SESSION_PATH,
    LOGOUT_PATH,
    DEFAULT_PORT,
    CLIENT_PORT,
    SESSION_COOKIE,
    HEADER,
    CSRF_HEADER,
    CLIENT_HEADER,
    compatible,
    incompatibility,
  };
});
