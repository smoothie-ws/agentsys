'use strict';
// The AI plugin keeps the original folder id so saved settings and existing calls keep working.
exports.title = 'AI';
exports.icon = 'sparkles';
exports.description = 'A plugin example with a Hello node and a configurable greeting.';

// A form on the plugin's page; the values are read with api.settings.get().
exports.settings = [{key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello'}];

exports.start = async api => {
  await api.library.addScriptNode({
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
