# Legacy plugin package adapter

The host accepts `agentsys.plugin/1` packages alongside executable API 2 packages. This compatibility format uses `manifest.contributes` for Library collections, node catalogs, pages, tiles, commands, endpoints, templates and setting schemas.

Native resources use the same generic JSON field types as [API 2](plugins.md). A legacy endpoint is a packaged JavaScript function body executed in an isolated Worker per call. A legacy command targets a packaged page or an application path. Existing permission declarations use `capabilities` and are intersected with current grants.

New plugins should use `main`, `activate(context)` and executable handlers; version 2 manifests reject contribution declarations.
