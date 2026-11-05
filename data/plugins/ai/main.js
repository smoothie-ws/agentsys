'use strict';
const {randomUUID} = require('node:crypto');
exports.title = 'AI';
exports.icon = 'sparkles';
exports.description = 'Configure AI providers in the Library.';

const invalid = message => Object.assign(new Error(message), {code: 'invalid_request', status: 400});
const missing = () => Object.assign(new Error('Provider not found'), {code: 'not_found', status: 404});
const publicProvider = ({apiKey, ...provider}) => ({...provider, hasApiKey: !!apiKey});

exports.start = api => {
  api.library.addSection({
    id: 'providers',
    title: 'Providers',
    icon: 'sparkles',
    route: 'providers',
    description: 'Configure AI provider endpoints and models.',
    fields: [
      {key: 'providerId', label: 'Provider ID', required: true},
      {key: 'name', label: 'Name'},
      {key: 'baseURL', label: 'Base URL', required: true},
      {key: 'model', label: 'Default model'},
      {key: 'apiKey', label: 'API key', type: 'password'},
    ],
  });
  // Serialize edits so simultaneous requests cannot overwrite each other's providers.
  let pending = Promise.resolve();
  const read = async () => (await api.data.get()) || {providers: []};
  api.route('GET', 'providers', async () => ((await read()).providers || []).map(publicProvider));
  for (const method of ['POST', 'PUT', 'DELETE'])
    api.route(method, 'providers', ({body, query}) => {
      const result = pending.then(async () => {
        const data = await read();
        const providers = (data.providers ||= []);
        const index = providers.findIndex(p => p.id === (body.id || query.id));
        if (method !== 'POST' && index < 0) throw missing();
        if (method === 'DELETE') {
          providers.splice(index, 1);
          await api.data.set(data);
          return {deleted: true};
        }
        const providerId = String(body.providerId || '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(providerId))
          throw invalid('Provider ID must contain letters, digits, _ or -');
        if (providers.some((p, i) => i !== index && p.providerId === providerId))
          throw invalid('Provider ID already exists');
        const baseURL = String(body.baseURL || '').trim();
        let url;
        try {
          url = new URL(baseURL);
        } catch {
          throw invalid('Base URL must be an HTTP or HTTPS URL');
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Base URL must be an HTTP or HTTPS URL');
        const previous = index < 0 ? {} : providers[index];
        const provider = {
          id: previous.id || randomUUID(),
          providerId,
          baseURL,
          name: String(body.name || providerId).trim(),
          model: String(body.model || '').trim(),
          apiKey: body.apiKey === null ? '' : String(body.apiKey || previous.apiKey || ''),
        };
        if (index < 0) providers.push(provider);
        else providers[index] = provider;
        await api.data.set(data);
        return publicProvider(provider);
      });
      pending = result.catch(() => {});
      return result;
    });
};
