# Updating current plugins

Use Plugin API 2 and package format 2. A source project has `plugin.json`, `main.js` and optional package-local
modules. Build and validate with `node tools/plugin-pack.js <directory>` and `--check <directory>`.

Keep the stable plugin id. Increment the semantic version and use onUpdate/migrate for changes to your own
data. The lifecycle context includes from/to versions and dataVersion; a successful migration stores the
returned data version. Failure rolls back activation according to the lifecycle contract. Reinstalling an
updated package preserves enablement and modern storage. See [Lifecycle](plugin-lifecycle.md).

Deployment is a separate per-environment operation. Current server Library resources, workflow templates and
Collection records remain after disabling/uninstalling the plugin. Capability increases require review. Never
request a root token or import a private UI module. See [SDK](plugin-sdk.md) and [Library](plugin-library.md).

Retired format 1 / API 1 packages must be rebuilt before installation. Server plugins are unsupported;
their old implementation remains in Git history. See [Compatibility changes](migration.md).
