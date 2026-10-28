'use strict';
route(
  'GET PUT',
  'projects/{project_id}/policy',
  'Read or set the workspace capability allow list',
  async (c, {project_id}) => {
    await c.project(project_id);
    if (c.method === 'PUT') {
      checkManifest({capabilities: c.body.allow});
      if (!Array.isArray(c.body.allow)) throw bad('allow is required');
      c.ctx.set('policy:' + project_id, {allow: c.body.allow});
    }
    return c.ctx.get('policy:' + project_id, {allow: ['graph.read']});
  },
  {needs: {GET: ['system.admin'], PUT: ['system.admin']}, body: {allow: ['graph.read']}}
);
route('GET PUT DELETE', 'secrets/{name}', 'Store a secret; reads return metadata only', async (c, {name}) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw bad('Invalid secret name');
  const key = 'secrets/' + name;
  if (c.method === 'PUT') {
    if (typeof c.body.value !== 'string' || !c.body.value || c.body.value.length > 10000)
      throw bad('value is text of 1 to 10000 characters');
    c.ctx.set(key, {value: c.body.value});
  }
  if (c.method === 'DELETE') await c.ctx.remove(key);
  return {name, present: c.method !== 'DELETE' && !!(await c.ctx.get(key))};
});
route(
  'POST',
  'net',
  'Make a capability checked HTTP request',
  async c => {
    let url;
    try {
      url = new URL(c.body.url);
    } catch {
      throw bad('Invalid network URL');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw bad('Use an HTTP(S) URL without credentials');
    const run = RUNS.byId.get(c.scriptContext?.run_id);
    {
      const request = await injectSecrets(c.body);
      const response = await fetch(url, {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: run
          ? AbortSignal.any([
              AbortSignal.timeout(request.timeout ?? 30000),
              run.controller.signal,
              ...(run.callController ? [run.callController.signal] : []),
            ])
          : AbortSignal.timeout(request.timeout ?? 30000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new ApiError('permission_denied', 'Redirects require a separate request and host permission', 403);
      const text = await response.text();
      if (text.length > 2000000) throw bad('Network response is too large');
      // Secrets can be reflected by an endpoint: scrub all stored values before returning.
      let clean = text;
      for (const m of JSON.stringify(c.body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)) {
        const secret = await DB.get('secrets/' + m[1]);
        if (secret?.value) clean = clean.replaceAll(secret.value, '[REDACTED]');
      }
      return {status: response.status, text: clean};
    }
  },
  {unlocked: true}
);
