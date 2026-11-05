// Plugins: the list, turning one off or on, reloading the folder, and the routes plugins register. The host is the server's
// (plugin-host.js); in a browser without a server there is none, and the list is empty.
'use strict';

const pluginHost = () => (typeof PLUGIN_HOST === 'undefined' ? null : PLUGIN_HOST);

route('GET', 'plugins', 'List the installed plugins', async () => pluginHost()?.list() ?? [], {unlocked: true});
route(
  'POST',
  'plugins/reload',
  'Reload the plugins folder',
  async () => {
    await pluginHost()?.reload();
    return pluginHost()?.list() ?? [];
  },
  {unlocked: true, needs: {POST: ['system.admin']}}
);
route(
  'GET PUT',
  'plugins/{id}',
  'Read a plugin, or turn it on or off',
  async (c, {id}) => {
    if (c.method === 'GET') {
      const found = await pluginHost()?.detail(id);
      if (!found) throw missing('Plugin not found');
      return found;
    }
    if (typeof c.body.enabled !== 'boolean') throw bad('enabled is true or false');
    const host = pluginHost();
    if (!host) throw missing('Plugins need the server');
    try {
      return await host.setEnabled(id, c.body.enabled);
    } catch (error) {
      if (error.code === 'not_found') throw missing(error.message);
      throw error;
    }
  },
  {unlocked: true, needs: {GET: ['system.admin'], PUT: ['system.admin']}, body: {enabled: true}}
);
route(
  'PUT',
  'plugins/{id}/settings',
  'Save the settings a plugin declares',
  async (c, {id}) => {
    const host = pluginHost();
    if (!host) throw missing('Plugins need the server');
    try {
      return await host.setSettings(id, c.body.values);
    } catch (error) {
      if (error.code === 'not_found') throw missing(error.message);
      if (error.code === 'invalid_request') throw bad(error.message);
      throw error;
    }
  },
  {unlocked: true, needs: {PUT: ['system.admin']}, body: {values: {}}}
);
route(
  'GET POST PUT DELETE',
  'plugins/{id}/{name}',
  'Call a route a plugin registered',
  async (c, {id, name}) => {
    const {signal, project_id, workflow_id, node_id} = c.scriptContext ?? {};
    const caller = c.scriptContext ? {project_id, workflow_id, node_id} : undefined;
    const result = await pluginHost()?.call(id, name, c.method, c.body, c.query, {signal, caller});
    if (result === undefined) throw missing('The plugin has no such route');
    return result;
  },
  {unlocked: true}
);

route(
  'GET',
  'library/sections',
  'List Library sections registered by running plugins',
  async () => pluginHost()?.sections() ?? []
);
