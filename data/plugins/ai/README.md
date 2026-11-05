# AI

Adds **Providers** to Library while enabled. Create, edit and delete providers there.
Each provider has a stable ID, name, HTTP(S) base URL, default model and optional API key.
Provider data is saved in `data/plugins/ai/data.json`. API keys are not returned by the plugin API.
An empty API key field keeps the stored key; sending `apiKey: null` clears it.

Disabling the plugin hides Providers and retains its saved data.
