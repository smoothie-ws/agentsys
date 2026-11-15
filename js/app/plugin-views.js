// Declarative plugin views. One registration owns its page, navigation and section projections.
// The host supplies only the sandbox's checked request and invocation capabilities.
'use strict';

class PluginViews {
  constructor() {
    this.entries = [];
  }
  static href(plugin, id) {
    return `/ext/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;
  }
  list(kind, plugin) {
    return this.entries
      .filter(item => (!kind || item.kind === kind) && (!plugin || item.plugin === plugin))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map(item => ({...item}));
  }
  pages(plugin) {
    return this.list(null, plugin).filter(item => item.page).map(item => ({
      ...item,
      id: item.page,
      ...(item.kind === 'library' ? {section: 'library'} : {}),
      ...(item.kind === 'resource' ? {
        resourceView: item.id,
        description: item.description || `Records of ${item.collection}`,
      } : {}),
    }));
  }
  page(plugin, id) {
    return this.pages(plugin).find(item => item.id === id);
  }
  sidebar() {
    return this.list().filter(item => item.page && item.nav).map(item => ({
      plugin: item.plugin, id: 'nav:' + item.page, page: item.page,
      href: item.href, title: item.title, icon: item.icon, order: item.order,
      ...(item.kind === 'library' ? {section: 'library'} : {}),
    }));
  }
  remove(plugin) {
    this.entries = this.entries.filter(item => item.plugin !== plugin);
  }
  add(kind, spec, sandbox) {
    const {plugin} = sandbox;
    const labels = {
      page: 'page', library: 'Library section', home: 'dashboard card',
      settings: 'settings section', inspector: 'inspector section', resource: 'resource view',
    };
    const label = labels[kind];
    if (!label) throw new Error('Unknown plugin view: ' + kind);
    if (typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(spec.id))
      throw new Error(`${label} id must be letters, digits, ".", "_" or "-"`);
    if (!spec.hasRender) throw new Error(`A ${label} needs a render() function`);
    if (kind === 'resource' && !/^[a-z][a-z0-9-]{0,63}$/.test(String(spec.collection || '')))
      throw new Error('A resource view needs a collection name');
    const page = ['page', 'library', 'resource'].includes(kind)
      ? (kind === 'resource' ? 'view-' : '') + spec.id : null;
    if (page && this.page(plugin.id, page)) throw new Error(`The page "${page}" is already registered`);
    const collection = kind === 'resource' ? String(spec.collection) : undefined;
    const item = {
      kind, plugin: plugin.id, id: spec.id,
      title: String(spec.title || (kind === 'home' || kind === 'settings' || kind === 'inspector'
        ? plugin.title : collection || spec.id)).slice(0, 120),
      description: String(spec.description || '').slice(0, kind === 'settings' || kind === 'inspector' ? 500 : 2000),
      icon: spec.icon || (kind === 'library' || kind === 'resource' ? 'database' : plugin.icon || 'plug'),
      order: Number(spec.order) || 0,
      page,
      href: page ? PluginViews.href(plugin.id, page) : undefined,
      nav: kind === 'resource' ? spec.sidebar === true : spec.nav !== false,
      ...(collection ? {collection} : {}),
      ...(kind === 'inspector' ? {when: ['any', 'node', 'complex'].includes(spec.when) ? spec.when : 'any'} : {}),
      render: async (root, context) => {
        let args = ['home', 'settings'].includes(kind) ? [] : [clone(context || {})];
        if (kind === 'resource') {
          const answer = await sandbox.checkedRequest('GET', `collections/${encodeURIComponent(collection)}/records`, undefined, {limit: 200});
          args = [{collection, records: clone(answer?.records || []), total: answer?.total || 0, page: clone(context || {})}];
        }
        root.innerHTML = PluginContent.decorate(await sandbox.invoke(kind + ':' + spec.id, args), plugin.id);
      },
    };
    this.entries.push(item);
    return true;
  }
}
