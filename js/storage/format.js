'use strict';
const TextGraph = (() => {
  const FORMAT = 'agentsys.text/1';
  const sortedCollections = new Set(['nodes', 'records', 'groups', 'complex', 'port_edges', 'types']);
  const stringify = value => JSON.stringify(value, null, 2) + '\n';
  const sort = (value, field = '') => {
    if (Array.isArray(value)) {
      const array = value.map(v => sort(v));
      return sortedCollections.has(field)
        ? array.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'))
        : array;
    }
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(k => [k, sort(value[k], k)])
      );
    return value;
  };
  const scriptPath = path => 'scripts/' + path.map(x => encodeURIComponent(x).replaceAll('%', '_')).join('-') + '.js';
  function encode(value) {
    const files = {},
      layouts = {};
    const walk = (v, path) => {
      if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
      if (!v || typeof v !== 'object') return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (['layout', 'positions'].includes(k) && x && typeof x === 'object' && !Array.isArray(x)) {
          layouts[JSON.stringify([...path, k])] = sort(x);
          continue;
        }
        if (k === 'default' && v.id === 'script' && typeof x === 'string') {
          const file = scriptPath([...path, k]);
          files[file] = x;
          out[k] = {$script: file};
        } else out[k] = walk(x, [...path, k]);
      }
      return out;
    };
    // Sort before extraction so file paths are stable when record order changes.
    const canonical = walk(sort(value), ['value']);
    files['graph.json'] = stringify(sort({format: FORMAT, value: canonical}));
    files['layout.json'] = stringify(sort(layouts));
    return {format: FORMAT, files: sort(files)};
  }
  function decode(packet) {
    if (
      !packet ||
      packet.format !== FORMAT ||
      !packet.files ||
      typeof packet.files !== 'object' ||
      Array.isArray(packet.files)
    )
      throw new Error('Expected agentsys.text/1 files');
    const files = packet.files;
    for (const [path, text] of Object.entries(files))
      if (!/^(graph\.json|layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/.test(path) || typeof text !== 'string')
        throw new Error('Invalid text file: ' + path);
    const graph = JSON.parse(files['graph.json']),
      layouts = JSON.parse(files['layout.json']);
    if (graph.format !== FORMAT || !Object.hasOwn(graph, 'value')) throw new Error('Invalid graph format');
    const used = new Set(['graph.json', 'layout.json']);
    const walk = value => {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== 'object') return value;
      if (Object.hasOwn(value, '$script')) {
        if (
          Object.keys(value).length !== 1 ||
          !Object.hasOwn(files, value.$script) ||
          !/^scripts\/[A-Za-z0-9_-]+\.js$/.test(value.$script)
        )
          throw new Error('Missing or invalid script reference');
        used.add(value.$script);
        return files[value.$script];
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    };
    const root = {value: walk(graph.value)};
    for (const [text, value] of Object.entries(layouts)) {
      const parts = JSON.parse(text);
      if (
        !Array.isArray(parts) ||
        parts[0] !== 'value' ||
        parts.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))
      )
        throw new Error('Invalid layout path');
      let target = root;
      for (const k of parts.slice(0, -1)) {
        if (!Object.hasOwn(target, k)) throw new Error('Invalid layout parent');
        target = target[k];
      }
      if (!['layout', 'positions'].includes(parts.at(-1))) throw new Error('Invalid layout key');
      target[parts.at(-1)] = value;
    }
    if (Object.keys(files).some(k => !used.has(k))) throw new Error('Unreferenced text file');
    return root.value;
  }
  return {FORMAT, encode, decode, canonical: value => JSON.stringify(encode(value))};
})();
if (typeof module !== 'undefined') module.exports = TextGraph;
