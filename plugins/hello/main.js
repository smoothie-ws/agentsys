'use strict';
// A minimal plugin: folder `plugins/hello`, entry point `main.js`. See docs/plugins.md.
exports.title = 'Hello';
exports.description = 'Adds a Hello node to the Library and the route GET /api/plugins/hello/greet?name=...';

// A form on the plugin's page; the values are read with api.settings.get().
exports.settings = [{key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello'}];

exports.start = api => {
  api.library.addScriptNode({
    name: 'Hello',
    folder: 'Plugins',
    description: 'Writes a greeting for `name`.',
    inputs: ['name'],
    outputs: ['greeting'],
    code: "node.output.greeting = 'Hello, ' + (node.input.name || 'world') + '!';",
  });
  api.route('GET', 'greet', async ({query}) => {
    const {greeting} = await api.settings.get();
    return {text: greeting + ', ' + (query.name || 'world') + '!'};
  });
  api.log('started');
};

exports.stop = () => {};
