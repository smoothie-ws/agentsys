// Reference Plugin E: a hostile plugin that must stay harmless. It only declares graph.read; every write, secret,
// token, authentication, cross-plugin and sandbox-escape attempt below has to be refused.
'use strict';

const results = {};
const attempt = async (name, work) => {
  try {
    const value = await work();
    results[name] = {ok: true, value: value === undefined ? null : String(value).slice(0, 300)};
  } catch (error) {
    results[name] = {ok: false, error: String(error?.message || error).slice(0, 300)};
  }
};

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);

async function runAttacks() {
  await attempt('write-project', () => api.request('POST', 'projects', {name: 'injected by the security test'}));
  await attempt('write-collection', () => api.request('PUT', 'collections/security-injected', {title: 'x'}));
  await attempt('read-foreign-secret', () => api.request('GET', 'secrets/reference-demo'));
  await attempt('use-foreign-secret', () => api.request('POST', 'net', {url: 'http://127.0.0.1:1/', headers: {Authorization: '{{secret:reference-demo}}'}}));
  await attempt('auth-endpoint', () => api.request('GET', 'auth/session'));
  await attempt('path-traversal', () => api.request('GET', 'projects/../auth/session'));
  await attempt('foreign-command', () => api.commands.execute('reference-ui-showcase:hello'));
  await attempt('notify-without-capability', () => api.ui.notify({title: 'injected'}));
  await attempt('direct-fetch', () => fetch('http://127.0.0.1:1/leak'));
  await attempt('top-document', () => parent.document.title);
  await attempt('top-storage', () => localStorage.getItem('agentsys-client-plugins'));
  await attempt('session-storage', () => sessionStorage.getItem('agentsys-token:local'));
  await attempt('forge-result', () => {
    parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: 999999, value: 'forged'}, '*');
    return 'posted';
  });
  await attempt('style-import', () => api.ui.addStyles('@import url("http://127.0.0.1:1/x.css");'));
  await attempt('open-window', () => {
    const opened = open('http://127.0.0.1:1/');
    if (opened) throw new Error('a popup was opened');
    return 'blocked by the sandbox';
  });
  await attempt('read-projects', () => api.request('GET', 'projects').then(list => list.length));
  results.at = Date.now();
  await api.storage.set('results', results);
  return results;
}

exports.activate = async pluginApi => {
  const api = pluginApi;
  await api.storage.set('installed', {version: api.version});
  api.ui.addPage({
    id: 'report',
    title: 'Security report',
    description: 'Every forbidden operation this plugin attempted and why it was refused.',
    icon: 'lock',
    render: () => renderReport(),
  });
  api.ui.addSettingsSection({
    id: 'security',
    title: 'Security Test',
    description: 'Deliberately hostile reference plugin.',
    render: () => renderReport(),
  });
  api.commands.register('run', async () => {
    await runAttacks();
    api.ui.refresh();
    return results;
  }, {title: 'Run security attempts'});
  await runAttacks();
  // The host must also refuse work queued for after the plugin is switched off. The sandbox is gone by then.
  setTimeout(() => api.request('POST', 'projects', {name: 'after disable'}).catch(() => {}), 700);
};

async function renderReport() {
  const stored = await api.storage.get('results', results);
  const rows = Object.entries(stored)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([name, value]) => `<tr><td>${escape(name)}</td><td>${value.ok ? '<strong class="oc-badge" data-tone="error">ALLOWED</strong>' : '<strong class="oc-badge" data-tone="success">refused</strong>'}</td><td>${escape(value.error || value.value || '')}</td></tr>`)
    .join('');
  return `<h2>Security report</h2>
    <p class="muted">This plugin declares only <code>graph.read</code>. An “ALLOWED” row in a write, secret, auth,
    cross-plugin or sandbox row is a defect in AgentSys, not in this plugin.</p>
    <div class="oc-table"><table><thead><tr><th>Attempt</th><th>Result</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>
    <button type="button" data-command="run">Run again</button>`;
}
