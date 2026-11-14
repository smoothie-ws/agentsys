// Reference Plugin B: a Library section backed by ordinary server data. The nodes it deploys are saved Script
// graphs and run on the server without this plugin.
'use strict';

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);

async function section(api) {
  const resources = await api.library.list();
  const ours = resources.filter(item => item.payload?.plugin?.id === api.id);
  const notes = await api.collections.records('pack-notes', {limit: 5}).catch(() => ({total: 0, records: []}));
  return `<h2>Library Pack</h2>
    <p class="muted">A Library section is a plugin page that reads normal server data. Deploy the package from the
    Plugins page once; after that the nodes belong to the server.</p>
    <dl class="page-facts">
      <div><dt>Nodes</dt><dd>${ours.length}</dd></div>
      <div><dt>Notes</dt><dd>${notes.total}</dd></div>
    </dl>
    <h3>Nodes</h3>
    ${ours.length ? `<ul class="plugin-contributions">${ours.map(item => `<li><a href="/library/nodes/${encodeURIComponent(item.id)}" data-link>${escape(item.name)}</a> <span class="muted">${escape(item.payload.description || '')}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing deployed on this server yet.</p>'}
    <h3>Recent notes</h3>
    ${notes.records.length ? `<ul class="plugin-contributions">${notes.records.map(item => `<li>${escape(item.data.text)} <span class="muted">#${escape(item.id.slice(0, 8))}</span></li>`).join('')}</ul>` : '<p class="muted">No notes yet.</p>'}
    <p class="muted small">Switching servers shows that server's resources, never the previous one's.</p>`;
}

exports.activate = async api => {
  api.ui.addLibrarySection({
    id: 'pack',
    title: 'Library Pack',
    description: 'Nodes, a collection and a workflow template that live on the server.',
    icon: 'library',
    nav: false,
    render: () => section(api),
  });
  api.ui.addSettingsSection({
    id: 'pack',
    title: 'Library Pack',
    description: 'Read-only status of the deployed resources.',
    render: async () => {
      const resources = await api.library.list();
      const ours = resources.filter(item => item.payload?.plugin?.id === api.id);
      return `<p class="muted">This server has <strong>${ours.length}</strong> Library Pack node(s).</p>
        <button type="button" data-command="open-pack">Open the Library Pack section</button>`;
    },
  });
  api.commands.register('open-pack', () => api.ui.navigate('/ext/reference-library-pack/pack'), {title: 'Open Library Pack'});
};
