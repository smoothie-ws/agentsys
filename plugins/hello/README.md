The **AI** plugin keeps the original greeting example: `main.js` adds a **Hello** node to the Library (folder *Plugins*), a *Greeting* setting, and answers `GET /api/plugins/hello/greet?name=...`.

The folder id stays `hello` so saved settings and existing workflows continue to work. This example does not call a model.

Copy this folder, rename it and edit `main.js` to make your own. See `docs/plugins.md`.
