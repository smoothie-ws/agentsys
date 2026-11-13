'use strict';
// The server half of the Hello UI example. It owns one route; the interface half (client.js) calls it.
exports.title = 'Hello UI';
exports.description = 'An example of the interface tools: a page, a toolbar button, commands and styles.';
exports.icon = 'sparkles';

exports.settings = [
  {key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello', help: 'The word client.js shows.'},
];

exports.start = api => {
  const read = async () => (await api.data.get()) || {greetings: 0};
  api.route('GET', 'greet', async () => read());
  api.route('POST', 'greet', async ({body}) => {
    const data = await read();
    data.greetings = (Number(data.greetings) || 0) + 1;
    await api.data.set(data);
    return {name: String(body?.name || 'there').slice(0, 80), greetings: data.greetings};
  });
};
