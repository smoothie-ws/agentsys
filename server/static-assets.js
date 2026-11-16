'use strict';
// Public-file boundary for the static Client. Never classify an unchecked Windows spelling or symlink.
const fs = require('node:fs/promises');
const path = require('node:path');
const {SERVER_ONLY} = require('./manifest');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};
const CLIENT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'",
};
const inside = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const publicFile = relative => {
  const name = relative.split(path.sep).join('/').toLowerCase();
  return /^(?:index\.html$|(?:js|css|docs|shared|client-plugins)\/)/.test(name) &&
    !SERVER_ONLY.test(name) && !/(?:^|\/)(?:\.|node_modules(?:\/|$))/.test(name);
};

/** Input is an already decoded URL path. The fallback is for application routes, never forbidden assets. */
async function resolveAsset(root, pathname, {dataDir, fallback = false} = {}) {
  if (/[:\\\0]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.' ||
      (process.platform === 'win32' && (/[. ]$/.test(part) || /~[0-9]/.test(part))))) return null;
  let file = path.join(root, pathname);
  if (!inside(file, root) || (dataDir && inside(file, dataDir))) return null;
  // Refuse server files before applying SPA fallback.
  if (SERVER_ONLY.test(path.relative(root, file).split(path.sep).join('/').toLowerCase())) return null;
  try {
    if (!(await fs.stat(file)).isFile()) file = fallback ? path.join(root, 'index.html') : file;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    if (fallback) file = path.join(root, 'index.html');
    else return null;
  }
  if (!publicFile(path.relative(root, file))) return null;
  try {
    const real = await fs.realpath(file), realRoot = await fs.realpath(root);
    if (!inside(real, realRoot) || !publicFile(path.relative(realRoot, real))) return null;
    if (dataDir && inside(real, await fs.realpath(dataDir))) return null;
    return real;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

module.exports = {resolveAsset, TYPES, CLIENT_HEADERS};
