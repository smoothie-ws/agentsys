# Hello plugin

The smallest complete plugin. It uses one command, one toolbar button, one page, private per-server storage and the
public SDK only.

```bash
node tools/plugin-pack.js examples/hello-plugin
```

This writes `examples/hello-plugin/hello-agent-1.0.0.agentsys-plugin.json`. Start AgentSys:

```bash
npm start
```

Open **Plugins → Install plugin → Import JSON file…**, choose the generated file, and open the plugin page. The
toolbar button and the page's button both run the `count` command. The counter is stored per browser and per active
server: switching environments shows a different count.

Read [docs/plugin-development.md](../../docs/plugin-development.md) for the whole loop, including errors, capabilities
and packaging.
