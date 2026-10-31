# Providers

Configure model providers in Library / AI / Providers. Each configuration stores a stable provider ID, API adapter name, endpoint, environment variable names, headers and options. API keys are stored separately and omitted from exports.

Models load automatically when a saved Provider is opened, using `GET <Base URL>/models`. Refresh requests a new list. The list is not editable or stored as provider configuration. Saving provider changes reloads the list. The plugin needs its `net.fetch:*` permission enabled in Plugins.

Requests use the saved API key (`Authorization: Bearer` for OpenAI-compatible adapters; `x-api-key` for Anthropic), plus Additional headers. JSON arrays, `{data: [...]}` and `{models: [...]}` lists are accepted. Anthropic pagination is followed. Model IDs are deduplicated and sorted; HTTP and format errors appear beside the list without blocking provider editing.

The plugin also registers Library / Nodes / AI with three graphs:

- **Provider**: `on_placed` initializes the Provider combobox from the Library; `on_widget` refreshes connected Model selectors. `on_read` exposes `id` (the stable Provider ID) and `url`.
- **Model**: input `provider` receives Provider.id. `on_placed`/`on_input_connected` initialize its model combobox. Changing the connected Provider selection also refreshes it. Output `model` is the selected model ID.
- **Ask**: signal `in` starts a request, `out` fires after success; inputs are `url`, `model`, `prompt` and optional `provider`. Output `response` is the model's text. It contains Prepare request (Script), Request and Read response (Script).

Wire Provider.id to Model.provider and, for explicit credentials, Ask.provider; Provider.url to Ask.url; Model.model to Ask.model. Connect an on_run Event to Ask.in and Ask.out/response to a Preview. A URL without a Library Provider uses an unauthenticated OpenAI-compatible endpoint. When multiple Providers share one URL, Ask.provider is required.

Ask uses non-streaming text requests: OpenAI-compatible `/chat/completions`, or Anthropic `/messages`. See [OpenAI Docs](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) for the compatible request/response format. Provider options can set parameters such as temperature; images, tools and reasoning controls are not exposed in this MVP.

The AI plugin owns URL construction, authentication, response parsing, node graphs and widget scripts. API keys remain in the plugin's host and are not put on graph wires. Request delegates authenticated transport to the plugin; Stop cancels the outstanding HTTP call without disabling the plugin. The core supplies only generic graph, widget, plugin endpoint and credential APIs.

The packaged Request graph comes from the workspace's Request node, with optional `request` (complete request options) and `endpoint` (checked API route, default `net`) inputs. The packaged graph makes the package portable. Update `nodes/request.json` and rebuild to include later changes to that graph.

Enable the plugin's requested permissions in Plugins. In the workflow's Project permissions allow graph.read/write and library.read; Provider also needs run.start to refresh downstream Model widgets, and Ask needs net.fetch for the chosen host. New instances inherit the plugin node defaults; their permissions remain editable on the canvas.
