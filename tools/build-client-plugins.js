'use strict';
// Writes client-plugins/index.json, the catalog of plugins bundled with the client. The client ships no bundled
// plugins: the Plugins page installs packages in this browser, and the sandboxed host API is still available.
const fs = require('node:fs');
const path = require('node:path');

const catalog = [];
fs.mkdirSync(path.join(__dirname, '..', 'client-plugins'), {recursive: true});
fs.writeFileSync(path.join(__dirname, '..', 'client-plugins', 'index.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log('Wrote client-plugins/index.json (no bundled plugins)');
