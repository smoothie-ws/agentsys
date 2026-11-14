// Helpers every layer uses. Loaded by the client (index.html) and by the server runtime (server/manifest.js),
// so it must not touch the DOM, the server filesystem or the browser storage APIs.
'use strict';

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || (code === 'not_found' ? 404 : code === 'invalid_request' ? 400 : 409);
  }
}
const bad = message => new ApiError('invalid_request', message, 400);
const missing = message => new ApiError('not_found', message, 404);

const uid = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hashText = async text =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

// Library folder paths are plain "A/B" strings on both sides of the API.
const parentPath = value => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '');
const underPath = (value, root) => value === root || value.startsWith(root + '/');

// Graph appearance limits: shared by the Settings page and the server's validation.
const GRAPH_RANGES = {node_radius: [0, 42], group_radius: [0, 54], wire_width: [1, 5], wire_curve: [10, 100]};
const WIRE_STYLE_IDS = ['bezier', 'linear', 'step', 'rounded'];

// A node's grants are checked in the editor as well as by the server. `plugins.call` remains accepted for
// projects made before the server plugin architecture was removed; no server route grants it now.
const CAPABILITY =
  /^(graph\.(read|write)|library\.(read|write)|collections\.(read|write)|net\.fetch:[A-Za-z0-9.*:\[\]-]+|run\.(read|start)|notifications\.(read|write)|plugins\.call|secrets\.use:[A-Za-z0-9_-]+)$/;
function checkManifest(manifest) {
  for (const field of ['grants'])
    if (
      manifest[field] !== undefined &&
      (!Array.isArray(manifest[field]) ||
        manifest[field].length > 50 ||
        manifest[field].some(value => typeof value !== 'string' || !CAPABILITY.test(value)))
    )
      throw bad(`Invalid ${field}`);
}
