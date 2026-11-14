// A minimal plugin: install this folder's generated package from Plugins → Install → Import JSON file.
'use strict';

exports.activate = async api => {
  api.commands.register(
    'count',
    async () => {
      const value = (await api.storage.get('count', 0)) + 1;
      await api.storage.set('count', value);
      api.ui.toast(`Count is ${value}`);
      return {count: value};
    },
    {title: 'Count', icon: 'plus'}
  );

  api.ui.addToolbarButton({id: 'count', command: 'count', title: 'Count', icon: 'plus'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello Agent',
    icon: 'sparkles',
    render: async () => {
      const count = await api.storage.get('count', 0);
      const environment = await api.env.info();
      return `<h2>Hello Agent</h2>
        <p class="muted">This page is drawn by a sandboxed plugin and runs against
        <strong>${api.escape(environment.name)}</strong>.</p>
        <dl class="page-facts"><div><dt>Count</dt><dd>${count}</dd></div></dl>
        <button type="button" data-command="count">Count one more</button>`;
    },
  });
};

exports.deactivate = async api => api.log('Hello Agent stopped');
