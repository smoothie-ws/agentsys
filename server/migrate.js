'use strict';
// One-way, conservative migration from the server-plugin era.
//
// - Nothing is deleted. The plugin folder is copied to data/backups/ before anything is written.
// - Provider configurations become records of the generic `providers` collection; API keys become server
//   secrets and only a {{secret:name}} reference is stored in the collection.
// - Other plugin data and client modules are preserved under data/plugins-migrated/ for inspection.
// - A server plugin is never converted into executable server code. There is no equivalent for arbitrary
//   routes, so those are reported, not guessed.
const fs = require('node:fs');
const path = require('node:path');
const {createServer} = require('../server');
const Protocol = require('../shared/protocol');

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.cpSync(from, to, {recursive: true, force: false, errorOnExist: false});
  return true;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const providerSchema = {
  type: 'object',
  properties: {
    providerId: {type: 'string', maxLength: 100},
    name: {type: 'string', maxLength: 200},
    baseURL: {type: 'string', maxLength: 2000},
    model: {type: 'string', maxLength: 200},
    apiKey: {type: 'string', maxLength: 1000},
  },
  required: ['providerId', 'baseURL'],
  additionalProperties: true,
};

/**
 * Migrates one data folder. `dryRun` reads and reports without writing.
 * Resolves with a report that lists what was preserved, migrated and left to a person.
 */
async function migrateData({dataDir, dryRun = false, log = () => {}} = {}) {
  const DATA = path.resolve(dataDir || 'data');
  if (!fs.existsSync(DATA)) throw new Error(`Data folder not found: ${DATA}`);
  const pluginsDir = path.join(DATA, 'plugins');
  const report = {
    data_dir: DATA,
    dry_run: !!dryRun,
    protocol: Protocol.PROTOCOL,
    backup: null,
    plugins: [],
    migrated: {collections: [], records: 0, secrets: []},
    preserved: [],
    warnings: [],
  };
  const index = readJSON(path.join(pluginsDir, 'index.json'), []);
  const entries = [];
  if (fs.existsSync(pluginsDir)) {
    for (const entry of fs.readdirSync(pluginsDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const main = path.join(pluginsDir, entry.name, 'main.js');
      if (!fs.existsSync(main)) continue;
      const indexed = Array.isArray(index) ? index.find(item => item.id === entry.name) : null;
      entries.push({
        id: entry.name,
        indexed,
        main: fs.readFileSync(main, 'utf8'),
        client: fs.existsSync(path.join(pluginsDir, entry.name, 'client.js'))
          ? fs.readFileSync(path.join(pluginsDir, entry.name, 'client.js'), 'utf8')
          : null,
        readme: fs.existsSync(path.join(pluginsDir, entry.name, 'README.md'))
          ? fs.readFileSync(path.join(pluginsDir, entry.name, 'README.md'), 'utf8')
          : '',
        data: readJSON(path.join(pluginsDir, entry.name, 'data.json'), null),
      });
    }
  }
  for (const plugin of entries) {
    const hasRoutes = /\.route\s*\(/.test(plugin.main);
    const hasLibrary = /\.library\./.test(plugin.main);
    report.plugins.push({
      id: plugin.id,
      title: plugin.indexed?.manifest?.name || plugin.id,
      version: plugin.indexed?.manifest?.version || '',
      installed: plugin.indexed?.installed ? true : false,
      has_server_routes: hasRoutes,
      has_library_contributions: hasLibrary,
      has_client_module: !!plugin.client,
      status: 'preserved',
    });
    if (hasRoutes) report.warnings.push(`Plugin "${plugin.id}" registered server routes; there is no automatic client equivalent. Its data is preserved and its custom routes are not served.`);
    if (plugin.client) report.warnings.push(`Plugin "${plugin.id}" carried client.js; it was copied but not activated. Port it to the sandboxed client plugin API (docs/plugins.md).`);
  }

  // Provider configurations: the one plugin data shape that has a documented, lossless mapping.
  const ai = entries.find(plugin => plugin.id === 'ai' && plugin.data && Array.isArray(plugin.data.providers));
  if (ai) report.migrated.collections.push('providers');

  // Workflows can call plugin routes from a Script. Those calls cannot be preserved automatically: scan them
  // and report the files so a person can replace the call with a normal API or a generic collection.
  const pluginCallers = [];
  const scan = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['backups', 'plugins-migrated', 'client-migration'].includes(entry.name)) scan(file, depth + 1);
        continue;
      }
      if (!/\.(?:json|js)$/.test(entry.name) || file.startsWith(pluginsDir)) continue;
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (/\bplugins\/[A-Za-z0-9_-]+\//.test(text))
          pluginCallers.push(path.relative(DATA, file));
      } catch {}
    }
  };
  scan(DATA);
  if (pluginCallers.length) {
    report.plugin_callers = pluginCallers;
    report.warnings.push(
      `${pluginCallers.length} workflow or Library file(s) call a server plugin route (plugins/…) that no longer exists. ` +
        'The data is preserved; replace those calls with the standard API or a generic collection.'
    );
  }

  const backupDir = path.join(DATA, 'backups', 'pre-platform-' + timestamp());
  if (!dryRun) {
    fs.mkdirSync(backupDir, {recursive: true});
    const copied = {
      plugins: copyIfExists(pluginsDir, path.join(backupDir, 'plugins')),
      settings: copyIfExists(path.join(DATA, 'settings.json'), path.join(backupDir, 'settings.json')),
      ui_state: copyIfExists(path.join(DATA, 'other', 'ui-state.json'), path.join(backupDir, 'ui-state.json')),
      library: copyIfExists(path.join(DATA, 'library'), path.join(backupDir, 'library')),
    };
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify({at: new Date().toISOString(), from: 'server-plugin architecture', items: copied}, null, 2) + '\n'
    );
    report.backup = backupDir;
    log(`Backup: ${backupDir}`);
  }

  // Preserve every plugin's sources and raw data under a folder the server never executes.
  if (!dryRun && entries.length) {
    const preservedDir = path.join(DATA, 'plugins-migrated');
    for (const plugin of entries) {
      const target = path.join(preservedDir, plugin.id);
      fs.mkdirSync(target, {recursive: true});
      fs.writeFileSync(path.join(target, 'main.js'), plugin.main);
      if (plugin.client) fs.writeFileSync(path.join(target, 'client.js'), plugin.client);
      if (plugin.readme) fs.writeFileSync(path.join(target, 'README.md'), plugin.readme);
      if (plugin.data) fs.writeFileSync(path.join(target, 'data.json'), JSON.stringify(plugin.data, null, 2) + '\n');
      fs.writeFileSync(
        path.join(target, 'migration.json'),
        JSON.stringify({id: plugin.id, at: new Date().toISOString(), note: 'Preserved from data/plugins. Not executed.'}, null, 2) + '\n'
      );
      report.preserved.push(path.relative(DATA, path.join(target, 'data.json')));
    }
  }

  if (!dryRun) {
    const app = createServer({dataDir: DATA, serveClient: false, legacyStorage: false});
    if (!app.api) {
      await app.close().catch(() => {});
      throw new Error('The backend could not be loaded for migration.');
    }
    const request = async (method, path, body, query = {}) => {
      const result = await app.api.request(method, path, {body: body ?? {}, query});
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    };
    try {
      if (ai) {
        await request('PUT', 'collections/providers', {
          title: 'Providers',
          description: 'Migrated from the AI server plugin. Keys are references to server secrets.',
          schema: providerSchema,
        });
        for (const provider of ai.data.providers) {
          if (!provider || typeof provider !== 'object') continue;
          const sourceId = /^[A-Za-z0-9_-]{1,80}$/.test(provider.id || '') ? provider.id : 'provider-' + report.migrated.records;
          const secretName = 'provider-' + sourceId.replace(/[^A-Za-z0-9_-]/g, '-') + '-api-key';
          const data = {
            providerId: String(provider.providerId || provider.id || sourceId),
            name: String(provider.name || provider.providerId || ''),
            baseURL: String(provider.baseURL || ''),
            model: String(provider.model || ''),
          };
          if (provider.apiKey) {
            await request('PUT', 'secrets/' + secretName, {value: String(provider.apiKey)});
            data.apiKey = `{{secret:${secretName}}}`;
            report.migrated.secrets.push(secretName);
          }
          try {
            const existing = await request('GET', 'collections/providers/records', undefined, {limit: 500});
            const duplicate = existing.records.find(record => record.data.providerId === data.providerId);
            if (duplicate) {
              // A later record without a key must not erase the reference migrated from the earlier one.
              if (!data.apiKey && duplicate.data.apiKey) data.apiKey = duplicate.data.apiKey;
              await request('PUT', 'collections/providers/records/' + duplicate.id, {data});
            } else await request('POST', 'collections/providers/records', {data});
            report.migrated.records++;
          } catch (error) {
            report.warnings.push(`Provider ${data.providerId} was not migrated: ${error.message}`);
          }
        }
        log(`Migrated ${report.migrated.records} provider(s); ${report.migrated.secrets.length} key(s) moved to secrets.`);
      }
    } finally {
      // Even a migration that failed halfway must release the folder lock before the process reports the error.
      await app.close().catch(() => {});
    }
  }

  const exportDir = path.join(DATA, 'client-migration');
  if (!dryRun) {
    fs.mkdirSync(exportDir, {recursive: true});
    fs.writeFileSync(
      path.join(exportDir, 'migration-report.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
    if (fs.existsSync(path.join(DATA, 'other', 'ui-state.json')))
      copyIfExists(path.join(DATA, 'other', 'ui-state.json'), path.join(exportDir, 'ui-state.json'));
    fs.writeFileSync(
      path.join(exportDir, 'README.txt'),
      'The new client keeps interface preferences in this browser. ui-state.json is the old server-side state; ' +
        'Settings → Import old UI state can read it once from the server.\n'
    );
  }
  report.warnings.push(
    'The browser-only mode is gone: open the client, add this server as an environment, and use it over the API.'
  );
  return report;
}

module.exports = {migrateData, providerSchema};
