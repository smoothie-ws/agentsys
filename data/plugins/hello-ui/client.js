'use strict';
// The interface half of the Hello UI example. It runs in the page and uses only the official tools of the
// extension host (js/app/extensions.js); see docs/plugins.md for the API.
exports.activate = api => {
  api.ui.addStyles(`
    .plugin-hello-ui .hello-panel { display: grid; gap: 1rem; }
    .plugin-hello-ui .hello-tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.75rem; }
    .plugin-hello-ui .hello-tool {
      padding: 0.85rem 1rem;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--card);
    }
    .plugin-hello-ui .hello-tool h3 { margin: 0 0 0.25rem; font-size: 0.9rem; }
    .plugin-hello-ui .hello-tool p { margin: 0; color: var(--muted); font-size: 0.82rem; }
    .plugin-hello-ui .hello-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
    .plugin-hello-ui .hello-actions input { min-width: 11rem; }
  `);

  const greeting = async () => (await api.settings.get().catch(() => ({}))).greeting || 'Hello';
  const say = async name => {
    const result = await api.request('POST', 'plugins/hello-ui/greet', {name});
    const message = `${await greeting()}, ${result.name}! ${result.greetings} greeting${result.greetings === 1 ? '' : 's'} saved.`;
    api.ui.toast(message);
    return message;
  };

  // A command: the command palette (Search) and the Plugins section menu both run it.
  api.commands.register('greet', () => say('AgentSys'), {title: 'Hello UI: say hello', icon: 'sparkles'});
  api.ui.addToolbarButton({id: 'greet', title: 'Say hello (Hello UI)', icon: 'sparkles', command: 'greet'});
  api.ui.addMenuItem('section:plugins', {label: 'Say hello (Hello UI)', icon: 'sparkles', command: 'greet'});

  // A page, registered as a sidebar section of its own.
  api.ui.addPage({
    id: 'hello',
    title: 'Hello',
    icon: 'sparkles',
    description: 'Every interface tool of a plugin on one page.',
    order: 10,
    render: async root => {
      const count = api.ui.el('strong', {}, '0');
      const name = api.ui.el('input', {
        type: 'text',
        value: 'AgentSys',
        placeholder: 'Your name',
        'aria-label': 'Your name',
      });
      const status = api.ui.el('p', {class: 'muted'}, 'Ready.');
      const button = api.ui.el(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            button.disabled = true;
            try {
              status.textContent = await say(name.value.trim() || 'there');
            } catch (error) {
              status.textContent = error.message;
            } finally {
              button.disabled = false;
            }
          },
        },
        'Say hello'
      );
      const refresh = async () => {
        const data = await api.request('GET', 'plugins/hello-ui/greet').catch(() => ({greetings: 0}));
        count.textContent = String(data.greetings || 0);
      };
      root.replaceChildren(
        api.ui.el(
          'div',
          {class: 'hello-panel'},
          api.ui.el(
            'div',
            {class: 'hello-actions'},
            name,
            button,
            api.ui.el('span', {class: 'muted'}, ['Saved greetings: ', count])
          ),
          status,
          api.ui.el(
            'div',
            {class: 'hello-tools'},
            tool('This page', 'api.ui.addPage and its sidebar entry'),
            tool('Top strip', 'api.ui.addToolbarButton with the sparkle icon'),
            tool('Search and menus', 'api.commands.register and api.ui.addMenuItem'),
            tool('Dashboard', 'api.ui.addHomeCard'),
            tool('Styles', 'api.ui.addStyles, scoped by the plugin-hello-ui body class'),
            tool('Data', 'api.request calls main.js; api.onDidChange keeps the count fresh')
          )
        )
      );
      await refresh();
      return api.onDidChange(keys => {
        if (keys.includes('plugins/hello-ui/data')) refresh().catch(() => {});
      });
    },
  });

  // A card on the dashboard, beside the projects.
  api.ui.addHomeCard({
    id: 'hello',
    title: 'Hello UI',
    icon: 'sparkles',
    render: root =>
      root.append(
        api.ui.el('p', {class: 'muted'}, 'A plugin page, a toolbar button and a command, all from client.js.'),
        api.ui.el(
          'p',
          {},
          api.ui.el('a', {href: '/ext/hello-ui/hello', 'data-link': true}, 'Open the plugin page')
        )
      ),
  });

  function tool(title, text) {
    return api.ui.el(
      'div',
      {class: 'hello-tool'},
      api.ui.el('h3', {}, title),
      api.ui.el('p', {}, text)
    );
  }
};
