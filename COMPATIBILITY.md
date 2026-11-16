# Product compatibility

| Server | Client | API | Verified transport |
| --- | --- | --- | --- |
| 0.4.0 | 0.7.0 | 2.0 | REST, Bearer/session, authenticated SSE, Chromium/Firefox/WebKit |

Application versions are independent. API major 2 is the compatibility boundary;
minor additions are compatible. Optional functions are discovered in GET /api/meta.
Incompatible majors fail with an explanatory connection state. No shared runtime
package, workspace install, server filesystem or IPC connects the products.

The canonical OpenAPI specification and JSON schemas belong to agentsys-server.
Each product stores public conformance JSON fixtures and owns its implementation.
API contract changes require their own versioned release and updated compatibility
evidence. Product release workflows run independently on v-prefixed Git tags.
