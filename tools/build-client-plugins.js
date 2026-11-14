'use strict';
// Writes client-plugins/index.json, the catalog of plugins bundled with the client. Each plugin runs in the
// sandboxed client host; these examples show the declarative UI API and the ordinary server API.
const fs = require('node:fs');
const path = require('node:path');

const hello = `exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello from a client plugin.'), {title: 'Say hello', icon: 'sparkles'});
  api.ui.addToolbarButton({id: 'hello', title: 'Say hello', command: 'hello', icon: 'sparkles'});
  api.ui.addPage({
    id: 'overview',
    title: 'Hello',
    icon: 'sparkles',
    description: 'A page drawn by a client plugin, using the ordinary server API.',
    render: async () => {
      const projects = await api.request('GET', 'projects');
      const env = await api.env.info();
      return '<h2>Hello from a plugin</h2>' +
        '<p class="muted">Server: <code>' + api.ui.escape(env.name || '') + '</code> · ' + projects.length + ' project(s).</p>' +
        '<p>This HTML is returned from a sandboxed iframe; the host sanitizes it before showing it.</p>' +
        '<ul>' + projects.map(project => '<li>' + api.ui.escape(project.name) + '</li>').join('') + '</ul>';
    },
  });
  api.ui.addHomeCard({
    id: 'hello',
    title: 'Hello plugin',
    render: async () => '<p class="muted">This card comes from a client plugin. Its code never runs on the server.</p>',
  });
};`;

const nodes = `exports.activate = async api => {
  api.commands.register('make-greeting', async () => {
    try {
      const item = await api.request('POST', 'library/script-nodes', {
        name: 'Greeting',
        description: 'Created by the Script Node Builder client plugin.',
        code: 'node.output.text = "Hello from a Library node";',
        inputs: [],
        outputs: ['text'],
        grants: ['graph.read'],
      });
      await api.ui.toast('Library node "' + item.name + '" is on the server.');
      await api.ui.refresh();
    } catch (error) {
      await api.ui.toast('Could not create the node: ' + error.message, true);
    }
  }, {title: 'Create Greeting node', icon: 'code'});
  api.ui.addPage({
    id: 'script-nodes',
    title: 'Script nodes',
    icon: 'code',
    description: 'Creates a normal Library node through the server API.',
    render: async () => {
      const list = await api.request('GET', 'resources');
      const made = list.filter(item => item.name === 'Greeting');
      return '<h2>Script Node Builder</h2>' +
        '<p class="muted">The button below calls <code>POST /api/library/script-nodes</code>. The created node is ordinary Library data and keeps working without this plugin or this client.</p>' +
        '<p>' + (made.length ? 'The Greeting node exists on this server.' : 'The Greeting node is not on this server yet.') + '</p>' +
        '<p class="muted small">Install or remove it from the Library page after it is created.</p>';
    },
  });
};`;

const catalog = [
  {
    id: 'hello-ui',
    title: 'Hello',
    version: '1.0.0',
    description: 'A small example of a client plugin: a page, a command, a toolbar button and a dashboard card.',
    icon: 'sparkles',
    api: 1,
    enabled: true,
    source: hello,
  },
  {
    id: 'script-node-builder',
    title: 'Script Node Builder',
    version: '1.0.0',
    description: 'Creates a standard Script-backed Library node through the server API.',
    icon: 'code',
    api: 1,
    enabled: true,
    source: nodes,
  },
];
fs.mkdirSync(path.join(__dirname, '..', 'client-plugins'), {recursive: true});
fs.writeFileSync(path.join(__dirname, '..', 'client-plugins', 'index.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log('Wrote client-plugins/index.json');
