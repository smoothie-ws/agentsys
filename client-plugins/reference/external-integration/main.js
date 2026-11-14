// Reference Plugin D: allowed network access and a server secret, never visible to this iframe.
'use strict';

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);
const COLLECTION = 'external-demo';

async function endpoint() {
  const answer = await api.collections.records(COLLECTION, {limit: 1});
  return answer.records[0]?.data?.url || '';
}

async function section() {
  const url = await endpoint();
  const present = await api.secrets.present('reference-demo').catch(() => ({present: false}));
  return `<h2>External Integration</h2>
    <p class="muted">The plugin never receives the secret. It writes the placeholder
    <code>{{secret:reference-demo}}</code> into a request; the server replaces it and scrubs it from the answer.</p>
    <dl class="page-facts">
      <div><dt>Endpoint</dt><dd>${url ? escape(url) : 'not set'}</dd></div>
      <div><dt>Server secret</dt><dd>${present.present ? 'present' : 'missing'}</dd></div>
      <div><dt>Network grant</dt><dd>${escape(api.capabilities.filter(item => item.startsWith('net.fetch:')).join(', ') || 'none')}</dd></div>
    </dl>
    <div class="button-row"><button type="button" class="primary" data-command="edit-endpoint">Set endpoint…</button>
    <button type="button" data-command="check">Check endpoint</button></div>
    <p class="muted small">The deployed node “External: Local status” runs this call on the server, with no client or plugin.</p>`;
}

exports.activate = async pluginApi => {
  const api = pluginApi;
  api.ui.addResourceView({
    id: 'external-demo',
    title: 'External endpoint',
    description: 'The URL used by the External Integration reference node.',
    collection: COLLECTION,
    icon: 'globe',
    render: async () => {
      const url = await endpoint();
      return `<h2>External endpoint</h2><p>Current URL: <strong>${url ? escape(url) : 'not set'}</strong></p>
        <button type="button" data-command="edit-endpoint">Set endpoint…</button>`;
    },
  });
  api.ui.addSettingsSection({
    id: 'external',
    title: 'External Integration',
    description: 'Local endpoint and server secret status.',
    render: () => section(),
  });
  api.commands.register('edit-endpoint', async values => {
    const current = await endpoint();
    const answer = await api.ui.showDialog({
      title: 'External endpoint',
      body: `<label class="field"><span>Base URL</span><input name="url" value="${escape(values?.url || current || 'http://127.0.0.1:8791')}" placeholder="http://127.0.0.1:8791"></label>
        <p class="muted small">Only an http(s) URL is accepted, and the server's network policy still applies.</p>`,
      actions: [{id: 'save', label: 'Save', command: 'save-endpoint', variant: 'primary'}],
    });
    return answer;
  }, {title: 'Set endpoint'});
  api.commands.register('save-endpoint', async values => {
    const url = String(values?.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Enter an absolute http(s) URL.');
    const existing = await api.collections.records(COLLECTION, {limit: 1});
    const record = existing.records[0];
    if (record) await api.collections.update(COLLECTION, record.id, {url}, record.version);
    else await api.collections.create(COLLECTION, {url});
    api.ui.toast('Endpoint saved on the server.');
    api.ui.refresh();
    return {url};
  }, {title: 'Save endpoint'});
  api.commands.register('check', async () => {
    const url = await endpoint();
    if (!url) throw new Error('Set the endpoint first.');
    const answer = await api.net.fetch({url: url.replace(/\/+$/, '') + '/status', headers: {Authorization: '{{secret:reference-demo}}'}, timeout: 5000});
    api.ui.toast(`Endpoint answered ${answer.status}.`);
    return answer;
  }, {title: 'Check endpoint'});
};
