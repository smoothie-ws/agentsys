# AgentSys Plugin SDK

The SDK is a **contract**, not a runtime dependency. AgentSys injects the `api` object into `activate(api)`; a plugin
never imports application internals. Plain JavaScript runs directly in the sandboxed plugin host. TypeScript is
optional: point your editor at `agentsys-plugin.d.ts` for completion and checks, then publish the compiled JavaScript
as a package.

```js
// main.js — plain JavaScript, no build step
exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello'), {title: 'Say hello'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello',
    render: async () => `<h2>Hello</h2><p>${api.escape(api.id)}</p>`,
  });
};
```

For TypeScript:

```ts
import type {PluginModule} from '@agentsys/plugin-sdk';

const plugin: PluginModule = {
  async activate(api) {
    api.ui.addSidebarItem({id: 'hello', title: 'Hello', page: 'home'});
  },
};
export = plugin;
```

`activate` may return a cleanup function; it runs on disable, reload and uninstall just like `deactivate`.

- [Plugin SDK](../docs/plugin-sdk.md)
- [Manifest](../docs/plugin-manifest.md)
- [Lifecycle](../docs/plugin-lifecycle.md)
- [UI extensions](../docs/plugin-ui.md)
- [Library and collections](../docs/plugin-library.md)
- [Security model](../docs/plugin-security.md)
- [Packaging](../docs/plugin-packaging.md)
- [Development guide](../docs/plugin-development.md)

The declarations describe API version 2. API version 1 packages keep working; new packages should set `"api": 2`.
