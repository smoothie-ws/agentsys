// Shared access to the registrations of executable plugins.
'use strict';
const EMPTY_PLUGIN_CONTRIBUTIONS = {
  library: [],
  nodes: [],
  templates: [],
  pages: [],
  tiles: [],
  commands: [],
  endpoints: [],
  settings: {fields: []},
};
const pluginContributions = plugin => plugin?.contributions ?? EMPTY_PLUGIN_CONTRIBUTIONS;
const pluginCapabilities = plugin => plugin?.manifest?.permissions ?? [];
const pluginSecrets = plugin => plugin?.manifest?.secrets ?? [];
const pluginAuthors = manifest => manifest.authors?.map(author => author.name).join(', ') || '';

const STATE_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const utf8Bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const stateKey = key => {
  if (
    typeof key !== 'string' ||
    !STATE_KEY.test(key) ||
    ['__proto__', 'constructor', 'prototype', '.', '..'].includes(key)
  )
    throw bad('A state key has 1 to 100 characters: letters, digits and _ . : -');
  return key;
};
function jsonData(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_, item) => {
        if (
          ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
          (typeof item === 'number' && !Number.isFinite(item))
        )
          throw bad('Value must be JSON data');
        return item;
      })
    );
  } catch (error) {
    if (error.code === 'invalid_request') throw error;
    throw bad('Value must be acyclic JSON data');
  }
}
