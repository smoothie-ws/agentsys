// The public client plugin contract: package format, manifest, semantic versions, dependencies and compatibility.
//
// This module is deliberately free of the DOM, the network and storage so the same rules are used by the client,
// by the package tool (tools/plugin-pack.js) and by the tests. A plugin package is untrusted input: every field is
// bounded and checked here before PluginStore keeps it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PluginManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const API_VERSION = 2; // the plugin API this client implements
  const MIN_API = 1;
  const FORMAT_VERSION = 2; // the package format this client reads (1 = the original single-source package)
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
  const ICON = /^[a-z][a-z0-9-]{0,39}$/;
  const MAX_FILES = 64;
  const MAX_FILE = 400000;
  const MAX_TOTAL = 900000;
  const MAX_ASSETS = 24;
  const MAX_ASSET = 200000;
  const MAX_CAPABILITIES = 50;
  const MAX_DEPENDENCIES = 20;
  const MAX_LIBRARY = 50;
  const MAX_WORKFLOWS = 20;
  const MAX_COLLECTIONS = 20;
  const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

  const fail = (message, code = 'invalid_request') => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  // ----- semantic versions -----
  function parseVersion(value) {
    const match = VERSION.exec(String(value ?? '').trim());
    if (!match) return null;
    return {
      raw: String(value).trim(),
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      pre: match[4] ? match[4].split('.') : [],
    };
  }
  function compareVersions(a, b) {
    const left = typeof a === 'string' ? parseVersion(a) : a,
      right = typeof b === 'string' ? parseVersion(b) : b;
    if (!left) throw fail('Invalid version: ' + String(a));
    if (!right) throw fail('Invalid version: ' + String(b));
    for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
    // A prerelease sorts before the release it leads to (`1.0.0-beta` < `1.0.0`).
    if (!left.pre.length && right.pre.length) return 1;
    if (left.pre.length && !right.pre.length) return -1;
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
      const x = left.pre[i],
        y = right.pre[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const nx = /^\d+$/.test(x),
        ny = /^\d+$/.test(y);
      if (nx && ny && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      if (nx !== ny) return nx ? -1 : 1;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  const numeric = part => (/^\d+$/.test(part) ? Number(part) : null);
  function oneTest(version, token) {
    const text = String(token || '').trim();
    if (!text || text === '*' || text === 'x' || text === 'X') return true;
    const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(text);
    if (!match) throw fail('Invalid version range: ' + text);
    const operator = match[1] || '=',
      raw = match[2].trim(),
      parts = raw.split('.'),
      lower = parseVersion(raw.replace(/\.(?:x|X|\*)$/, '.0').replace(/\.(?:x|X|\*)/g, '.0'));
    if (!lower) throw fail('Invalid version range: ' + text);
    if (operator === '^') {
      const upper = {major: lower.major, minor: lower.minor, patch: lower.patch, pre: []};
      if (lower.major > 0) {
        upper.major++;
        upper.minor = 0;
        upper.patch = 0;
      } else if (lower.minor > 0) {
        upper.minor++;
        upper.patch = 0;
      } else upper.patch++;
      return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
    }
    if (operator === '~') {
      const upper = {major: lower.major, minor: lower.minor + 1, patch: 0, pre: []};
      return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
    }
    if (parts.length === 2 && (parts[0] === 'x' || parts[1] === 'x')) return true;
    const cmp = compareVersions(version, lower);
    if (operator === '>=') return cmp >= 0;
    if (operator === '<=') return cmp <= 0;
    if (operator === '>') return cmp > 0;
    if (operator === '<') return cmp < 0;
    return cmp === 0;
  }
  /** `satisfies('1.2.3', '>=1.0.0 <2.0.0')`, with `||` alternatives and space-separated AND clauses. */
  function satisfies(version, range) {
    if (!parseVersion(version)) return false;
    if (range === undefined || range === null || String(range).trim() === '') return true;
    const alternatives = String(range).split('||');
    for (const alternative of alternatives) {
      const tokens = alternative.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return true;
      // A hyphen range (`1.2.3 - 2.0.0`) is read as two comparisons.
      const hyphen = /^(.+)\s+-\s+(.+)$/.exec(alternative.trim());
      if (hyphen) {
        const hi = String(hyphen[2]).trim();
        if (compareVersions(version, parseVersion(hi)) > 0) continue;
        if (compareVersions(version, parseVersion(String(hyphen[1]).trim())) < 0) continue;
        return true;
      }
      if (tokens.every(token => oneTest(version, token))) return true;
    }
    return false;
  }

  // ----- files and package fields -----
  const safePath = value => {
    const text = String(value ?? '');
    if (!text || text.length > 200 || text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text))
      throw fail('A package file path must be relative and use "/": ' + text.slice(0, 80));
    if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.split('/').some(part => !part || part === '.' || part === '..' || RESERVED.has(part)))
      throw fail('A package file path is not safe: ' + text.slice(0, 80));
    return text;
  };
  const safeKey = value => {
    const text = String(value ?? '');
    if (!text || text.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(text) || RESERVED.has(text))
      throw fail('A package key is not valid: ' + text.slice(0, 80));
    return text;
  };
  function normalizeAssets(value) {
    if (value === undefined) return {};
    if (!isObject(value)) throw fail('assets must be an object of images');
    const keys = Object.keys(value);
    if (keys.length > MAX_ASSETS) throw fail(`A package has at most ${MAX_ASSETS} assets`);
    const out = {};
    for (const key of keys) {
      const name = safeKey(key),
        asset = value[key];
      let uri;
      if (typeof asset === 'string') uri = asset;
      else if (isObject(asset) && typeof asset.data === 'string') {
        const type = String(asset.type || 'image/png').toLowerCase();
        if (!ASSET_TYPES.has(type)) throw fail('An asset must be a PNG, JPEG, GIF or WebP image');
        uri = `data:${type};base64,${asset.data}`;
      } else throw fail('An asset is a data URI or {type, data}');
      if (uri.length > MAX_ASSET) throw fail('An asset is too large (200 KB maximum)');
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(uri))
        throw fail('An asset must be a base64 PNG, JPEG, GIF or WebP data URI');
      out[name] = uri;
    }
    return out;
  }
  function normalizeCapabilities(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw fail('capabilities must be a list');
    if (value.length > MAX_CAPABILITIES) throw fail(`A plugin declares at most ${MAX_CAPABILITIES} capabilities`);
    if (value.some(item => typeof item !== 'string' || !item || item.length > 120))
      throw fail('Every capability must be a short string');
    return [...new Set(value)];
  }
  function normalizeDependencies(value) {
    if (value === undefined) return {};
    if (!isObject(value)) throw fail('dependencies must be an object of plugin id to version range');
    const entries = Object.entries(value);
    if (entries.length > MAX_DEPENDENCIES) throw fail(`A plugin has at most ${MAX_DEPENDENCIES} dependencies`);
    const out = {};
    for (const [id, range] of entries) {
      if (!ID.test(id)) throw fail('A dependency id is not valid: ' + id.slice(0, 80));
      if (typeof range !== 'string' || range.length > 120) throw fail('A dependency version range must be a string');
      // Validate the range now rather than when a user tries to enable the plugin.
      if (!['*', ''].includes(range.trim())) satisfies('0.0.0', range);
      out[id] = range.trim() || '*';
    }
    return out;
  }
  function normalizeEngines(value) {
    if (value === undefined) return {agentsys: '>=0.3.0'};
    if (!isObject(value)) throw fail('engines must be an object');
    const agentsys = value.agentsys === undefined ? '>=0.3.0' : String(value.agentsys);
    if (agentsys.length > 120) throw fail('engines.agentsys is too long');
    if (!['*', ''].includes(agentsys.trim())) satisfies('0.0.0', agentsys);
    return {agentsys};
  }
  function normalizeContributes(value) {
    if (value === undefined) return {collections: [], library: [], workflows: []};
    if (!isObject(value)) throw fail('contributes must be an object');
    const collections = value.collections === undefined ? [] : value.collections;
    const library = value.library === undefined ? [] : value.library;
    const workflows = value.workflows === undefined ? [] : value.workflows;
    for (const [name, list, max] of [
      ['collections', collections, MAX_COLLECTIONS],
      ['library', library, MAX_LIBRARY],
      ['workflows', workflows, MAX_WORKFLOWS],
    ]) {
      if (!Array.isArray(list) || list.length > max) throw fail(`contributes.${name} must be a list of at most ${max}`);
    }
    const collectionNames = new Set();
    for (const item of collections) {
      if (!isObject(item) || !/^[a-z][a-z0-9-]{0,63}$/.test(String(item.name || '')))
        throw fail('A contributed collection needs a lower-case name');
      if (collectionNames.has(item.name)) throw fail('Two contributed collections share the name ' + item.name);
      collectionNames.add(item.name);
      if (item.schema !== undefined && !isObject(item.schema)) throw fail('A collection schema must be an object');
      if (JSON.stringify(item).length > 100000) throw fail('A contributed collection is too large');
    }
    const nodeNames = new Set();
    for (const item of library) {
      if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)
        throw fail('A contributed Library node needs a name of 1 to 100 characters');
      if (nodeNames.has(item.name)) throw fail('Two contributed Library nodes share the name ' + item.name);
      nodeNames.add(item.name);
      if (typeof item.code !== 'string' || !item.code.trim() || item.code.length > 200000)
        throw fail('A contributed Library node needs Script code (up to 200000 characters)');
      for (const key of ['inputs', 'outputs'])
        if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].length > 64))
          throw fail(`A contributed node has at most 64 ${key}`);
      if (item.grants !== undefined && (!Array.isArray(item.grants) || item.grants.some(v => typeof v !== 'string')))
        throw fail('A contributed node grants must be a list of capability names');
    }
    for (const item of workflows) {
      if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)
        throw fail('A contributed workflow needs a name of 1 to 100 characters');
      if (item.project !== undefined && (typeof item.project !== 'string' || !item.project.trim() || item.project.length > 100))
        throw fail('A contributed workflow project name has 1 to 100 characters');
      if (item.nodes !== undefined && (!Array.isArray(item.nodes) || item.nodes.length > 100))
        throw fail('A contributed workflow has at most 100 nodes');
      for (const node of item.nodes || []) {
        if (!isObject(node) || typeof node.library !== 'string' || !nodeNames.has(node.library))
          throw fail(`A workflow node must name a contributed Library node (${String(node?.library).slice(0, 80)})`);
      }
    }
    return {collections: clone(collections), library: clone(library), workflows: clone(workflows)};
  }

  /**
   * Reads a package (format 1 or 2) into the record PluginStore keeps. Throws an actionable error on bad input.
   * `hostVersion` is the AgentSys version; `apiVersion` is the plugin API this client implements.
   */
  function normalizePackage(value, {hostVersion = '0.3.0', apiVersion = API_VERSION, allowSource = true} = {}) {
    if (!isObject(value)) throw fail('A plugin package must be a JSON object.');
    const v2 =
      isObject(value.manifest) ||
      value.format === 2 ||
      value.formatVersion === FORMAT_VERSION ||
      (isObject(value.files) && !value.source);
    const manifest = v2 ? value.manifest || {} : value;
    if (!isObject(manifest)) throw fail('manifest must be an object');
    const id = String(manifest.id ?? value.id ?? '');
    if (!ID.test(id)) throw fail('Plugin id must be letters, digits, ".", "_" or "-" (at most 80).');
    const title = String(manifest.name ?? manifest.title ?? value.title ?? '').trim();
    if (!title || title.length > 120) throw fail('A plugin needs a name of 1 to 120 characters.');
    const version = String(manifest.version ?? value.version ?? '0.0.0');
    if (!parseVersion(version)) throw fail('A plugin version must be semantic, such as 1.2.0 (' + version.slice(0, 40) + ').');
    const api = Number(manifest.api ?? value.api ?? (v2 ? API_VERSION : MIN_API));
    if (!Number.isInteger(api) || api < MIN_API || api > apiVersion)
      throw fail(`This client runs client plugin API ${apiVersion}, not ${api}.`, 'incompatible_protocol');
    const engines = normalizeEngines(manifest.engines ?? value.engines);
    if (!satisfies(String(hostVersion), engines.agentsys))
      throw fail(
        `This plugin needs AgentSys ${engines.agentsys}; this client is ${hostVersion}.`,
        'incompatible_protocol'
      );
    const dependencies = normalizeDependencies(manifest.dependencies ?? value.dependencies);
    if (Object.hasOwn(dependencies, id)) throw fail('A plugin cannot depend on itself');

    const main = v2 ? safePath(value.main || 'main.js') : 'plugin.js';
    const files = {};
    if (v2) {
      if (value.files !== undefined && !isObject(value.files)) throw fail('files must be an object of path to text');
      const entries = Object.entries(value.files || {});
      if (entries.length > MAX_FILES) throw fail(`A package has at most ${MAX_FILES} files`);
      let total = 0;
      for (const [path, text] of entries) {
        const clean = safePath(path);
        if (!/\.(?:js|json)$/i.test(clean)) throw fail('A package file must be JavaScript or JSON: ' + clean);
        if (typeof text !== 'string') throw fail('A package file must be text: ' + clean);
        if (text.length > MAX_FILE) throw fail('A package file is too large: ' + clean);
        total += text.length;
        if (total > MAX_TOTAL) throw fail('The plugin package is too large (900 KB maximum)');
        if (RESERVED.has(clean)) throw fail('A package file name is reserved: ' + clean);
        files[clean] = text;
      }
    }
    let source = value.source;
    if (v2) {
      const fromFiles = files[main];
      if (fromFiles !== undefined) source = fromFiles;
      else if (typeof source !== 'string') throw fail('The package main file "' + main + '" is missing from files.');
      delete files[main];
    }
    if (allowSource) {
      if (typeof source !== 'string' || !source.trim()) throw fail('A plugin needs JavaScript source.');
      if (source.length > MAX_FILE) throw fail('The plugin source is too large (400 KB maximum).');
      if (!/\bactivate\b/.test(source)) throw fail('The plugin source must export activate(api).');
    } else source = typeof source === 'string' ? source : '';
    const assetMap = normalizeAssets(value.assets);
    const contributes = normalizeContributes(value.contributes ?? manifest.contributes);
    const icon = ICON.test(String(manifest.icon || '')) ? String(manifest.icon) : 'plug';

    return {
      formatVersion: v2 ? FORMAT_VERSION : 1,
      id,
      title,
      name: title,
      description: String(manifest.description ?? value.description ?? '').slice(0, 2000),
      icon,
      version,
      api,
      engines,
      dependencies,
      capabilities: normalizeCapabilities(manifest.capabilities ?? value.capabilities),
      author: String(manifest.author ?? value.author ?? '').slice(0, 120),
      license: String(manifest.license ?? value.license ?? '').slice(0, 60),
      homepage: String(manifest.homepage ?? value.homepage ?? '').slice(0, 300),
      main,
      source,
      files,
      assets: assetMap,
      contributes,
      // These are set by the store, not by a package.
      enabled: value.enabled !== false,
      builtin: !!value.builtin,
      origin: String(value.origin || 'installed').slice(0, 80),
      installedAt: Number(value.installedAt) || 0,
      updatedAt: Number(value.updatedAt) || 0,
      activatedVersion: String(value.activatedVersion || ''),
      dataVersion: Number(value.dataVersion) || 0,
      checksum: String(value.checksum || ''),
    };
  }

  /** The dependency and version state of one plugin against the packages installed beside it. */
  function checkDependencies(plugin, plugins, {requireEnabled = false} = {}) {
    const list = (plugins || []).filter(item => item && item.id);
    const byId = new Map(list.map(item => [item.id, item]));
    const errors = [];
    for (const [id, range] of Object.entries(plugin?.dependencies || {})) {
      const found = byId.get(id);
      if (!found) {
        errors.push({code: 'missing_dependency', id, message: `Needs the plugin "${id}" ${range}.`});
        continue;
      }
      if (!satisfies(found.version || '0.0.0', range))
        errors.push({
          code: 'incompatible_dependency',
          id,
          message: `${id} ${found.version} does not satisfy ${range}.`,
        });
      else if (requireEnabled && found.enabled === false)
        errors.push({code: 'disabled_dependency', id, message: `The plugin "${id}" it needs is turned off.`});
    }
    return {ok: !errors.length, errors};
  }

  /**
   * Activation order: dependencies first, remaining plugins by id. Cycles and missing dependencies are reported
   * rather than silently activated in an arbitrary order.
   */
  function activationOrder(plugins) {
    const list = (plugins || []).filter(item => item && item.id);
    const byId = new Map(list.map(item => [item.id, item]));
    const state = new Map(),
      order = [],
      errors = [];
    const visit = (plugin, trail) => {
      if (state.get(plugin.id) === 'done') return;
      if (state.get(plugin.id) === 'visiting') {
        errors.push({code: 'dependency_cycle', id: plugin.id, message: `Dependency cycle: ${[...trail, plugin.id].join(' → ')}`});
        return;
      }
      state.set(plugin.id, 'visiting');
      for (const id of Object.keys(plugin.dependencies || {})) {
        const next = byId.get(id);
        if (!next) {
          errors.push({code: 'missing_dependency', id: plugin.id, message: `Needs the plugin "${id}", which is not installed.`});
          continue;
        }
        visit(next, [...trail, plugin.id]);
      }
      state.set(plugin.id, 'done');
      order.push(plugin);
    };
    for (const plugin of [...list].sort((a, b) => a.id.localeCompare(b.id))) visit(plugin, []);
    return {order, errors};
  }

  /** A deterministic, non-cryptographic checksum for change detection and package identity. */
  function fingerprint(record) {
    const text = JSON.stringify([
      record.id,
      record.version,
      record.main,
      record.source,
      Object.keys(record.files || {}).sort().map(key => [key, record.files[key]]),
      record.assets || {},
      record.contributes || {},
      record.capabilities || [],
      record.dependencies || {},
    ]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv1a-' + hash.toString(16).padStart(8, '0');
  }

  /** The distributable form: format 2, the main file inside files, and the checksum. */
  function exportPackage(record) {
    const clean = normalizePackage(record, {allowSource: true});
    const files = {...clean.files, [clean.main]: clean.source};
    return {
      format: FORMAT_VERSION,
      manifest: {
        id: clean.id,
        name: clean.title,
        version: clean.version,
        description: clean.description,
        icon: clean.icon,
        api: clean.api,
        engines: clean.engines,
        capabilities: clean.capabilities || [],
        dependencies: clean.dependencies,
        author: clean.author,
        license: clean.license,
        homepage: clean.homepage,
      },
      main: clean.main,
      files,
      assets: clean.assets,
      contributes: clean.contributes,
      checksum: fingerprint(clean),
    };
  }

  /** Reads a stored record from an older client, or a current one, into the current shape. */
  function migrateRecord(value) {
    if (!isObject(value)) throw fail('A stored plugin is not an object');
    if (value.formatVersion === FORMAT_VERSION && value.source) {
      const record = normalizePackage(exportPackage(value), {
        hostVersion: '0.3.0',
        apiVersion: Math.max(API_VERSION, Number(value.api) || API_VERSION),
      });
      return {
        ...record,
        enabled: value.enabled !== false,
        builtin: !!value.builtin,
        origin: value.origin || 'installed',
        installedAt: Number(value.installedAt) || 0,
        updatedAt: Number(value.updatedAt) || 0,
        activatedVersion: value.activatedVersion || '',
        dataVersion: Number(value.dataVersion) || 0,
        checksum: value.checksum || fingerprint(record),
      };
    }
    // Format 1: {id,title,source,api,capabilities,...}. It remains readable and is written back as format 2.
    const record = normalizePackage(value, {
      hostVersion: '0.3.0',
      apiVersion: Math.max(API_VERSION, Number(value.api) || API_VERSION),
    });
    return {...record, checksum: fingerprint(record)};
  }

  return {
    API_VERSION,
    MIN_API,
    FORMAT_VERSION,
    ID,
    VERSION,
    MAX_FILES,
    MAX_FILE,
    MAX_TOTAL,
    MAX_ASSETS,
    MAX_ASSET,
    MAX_CAPABILITIES,
    MAX_DEPENDENCIES,
    parseVersion,
    compareVersions,
    satisfies,
    safePath,
    normalizePackage,
    normalizeAssets,
    normalizeCapabilities,
    normalizeDependencies,
    normalizeContributes,
    checkDependencies,
    activationOrder,
    fingerprint,
    exportPackage,
    migrateRecord,
  };
});
