// Shared registry access. Version 1 packages are adapted here; new manifests contain metadata only.
'use strict';
const EMPTY_PLUGIN_CONTRIBUTIONS = {
  library: [], nodes: [], templates: [], pages: [], tiles: [], commands: [], endpoints: [], settings: {fields: []},
};
const pluginContributions = plugin => plugin?.contributions ?? plugin?.manifest?.contributes ?? EMPTY_PLUGIN_CONTRIBUTIONS;
const pluginCapabilities = plugin => plugin?.manifest?.permissions ?? plugin?.permissions ?? plugin?.manifest?.capabilities ?? [];
const pluginSecrets = plugin => plugin?.manifest?.secrets ?? [];
const pluginAuthors = manifest => manifest.authors?.map(author => typeof author === 'string' ? author : author.name).join(', ') || manifest.author || '';

const STATE_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const utf8Bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const stateKey = key => {
  if (!STATE_KEY.test(key) || ['__proto__', 'constructor', 'prototype', '.', '..'].includes(key))
    throw bad('A state key has 1 to 100 characters: letters, digits and _ . : -');
  return key;
};
function jsonData(value) {
  return JSON.parse(
    JSON.stringify(value, (_, item) => {
      if (
        ['function', 'symbol', 'bigint'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw bad('Value must be JSON data');
      return item;
    })
  );
}
