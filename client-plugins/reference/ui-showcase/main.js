// Reference Plugin A: one plugin, every client extension point. Installed in this browser only.
'use strict';

const render = require('./lib/render');

let greetings = 0;

exports.onInstall = async api => {
  await api.storage.set('installed', {version: api.version, at: Date.now()});
};

exports.onUpdate = async (api, context) => {
  await api.storage.set('updated', {from: context.from, to: context.to, at: Date.now()});
  return context.to;
};

exports.activate = async api => {
  api.commands.register('hello', async (who = {}) => {
    greetings++;
    const settings = await api.settings.get();
    const name = String(who?.name || 'there');
    await api.storage.set('last', {name, count: greetings, at: Date.now()});
    api.ui.toast(`${settings.greeting || 'Hello'}, ${name}!`);
    return {name, count: greetings};
  }, {title: 'Say hello', icon: 'sparkles'});

  api.commands.register('notify', async () => {
    const settings = await api.settings.get();
    if (settings.notifications === false) return {skipped: true};
    await api.ui.notify({title: 'UI Showcase', body: 'A notification posted through notifications.write.', level: 'info'});
    return {posted: true};
  }, {title: 'Send notification'});

  api.commands.register('rotate-settings', async () => {
    const settings = await api.settings.get();
    const greetingsList = ['Hello', 'Hi', 'Welcome', 'Good to see you'];
    const next = greetingsList[(greetingsList.indexOf(settings.greeting || 'Hello') + 1) % greetingsList.length];
    await api.settings.set({...settings, greeting: next});
    api.ui.toast(`Greeting is now “${next}”.`);
    api.ui.refresh();
    return next;
  }, {title: 'Rotate greeting'});

  api.ui.addToolbarButton({id: 'hello', command: 'hello', title: 'Say hello', icon: 'sparkles'});
  api.ui.addContextMenu({label: 'Say hello to the selection', command: 'hello', args: [{name: 'selection'}], order: 40});
  api.ui.addMenuItem('section:plugins', {label: 'Say hello', command: 'hello', icon: 'sparkles', order: 40});

  api.ui.addPage({id: 'showcase', title: 'UI Showcase', description: 'Every interface extension point.', icon: 'palette', render: context => render.page(api, context)});
  api.ui.addHomeCard({id: 'showcase', title: 'UI Showcase', icon: 'palette', render: () => render.card(api)});
  api.ui.addSettingsSection({id: 'showcase', title: 'UI Showcase', description: 'Settings owned by a plugin.', render: () => render.settings(api)});
  api.ui.addInspectorSection({id: 'showcase', title: 'UI Showcase', when: 'any', render: context => render.inspector(api, context)});
};

exports.deactivate = async api => {
  api.log('UI Showcase deactivated; its interface and token are gone.');
};
