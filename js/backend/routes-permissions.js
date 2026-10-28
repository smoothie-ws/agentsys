'use strict';
route(
  'GET PUT',
  'initiatives/{initiative_id}/policy',
  'Read or set an Initiative capability allow list',
  async (c, {initiative_id}) => {
    await readInitiative(c, initiative_id);
    const key = 'initiative_policy:' + initiative_id;
    if (c.method === 'PUT') {
      checkManifest({capabilities: c.body.allow});
      if (!Array.isArray(c.body.allow)) throw bad('allow is required');
      c.ctx.set(key, {allow: c.body.allow});
    }
    return c.ctx.get(key, null);
  },
  {needs: {GET: ['system.admin'], PUT: ['system.admin']}}
);
route('POST', 'permission-requests', 'Authorize creation of a durable human approval', async () => ({allowed: true}), {
  unlocked: true,
});
route(
  'POST',
  'projects/{project_id}/permission-approvals',
  'Request a review of a Library node and its declared permissions',
  async (c, {project_id}) => {
    await c.project(project_id);
    const resource = (await c.ctx.get('resources', [])).find(
      r => r.id === c.body.resource_id && r.kind === 'custom_node'
    );
    if (!resource) throw missing('Library node not found');
    const script =
      resource.payload.bundle.records
        .find(r => r.payload.config?.op === 'script')
        ?.payload.config.inputs.find(p => p.id === 'script')?.default ?? '';
    const fullCode = resource.payload.bundle.records
      .filter(r => r.payload.config?.op === 'script')
      .map(r => '// ' + r.payload.config.title + '\n' + r.payload.config.inputs.find(p => p.id === 'script')?.default)
      .join('\n\n');
    const plan = {
      nodes: [{id: 'review', context: {resource_id: resource.id}, inputs: [{code: true, fallback: script}]}],
    };
    await preparePlanPermissions(plan);
    const id = uid(),
      m = plan.nodes[0].manifest;
    const prior = await c.ctx.get('permission_grant:' + project_id + ':' + resource.id);
    const approval = {
      id,
      run_id: null,
      node: resource.id,
      status: 'pending',
      question: 'Grant the declared capabilities for ' + resource.name + '?',
      options: ['approve', 'reject'],
      created_at: Date.now(),
      expires_at: Date.now() + 86400000,
      default: 'reject',
      code: fullCode,
      previous_code: prior?.code ?? '',
      capabilities: m.capabilities,
      permission_request: {project_id, resource_id: resource.id, code_hash: m.code_hash, capabilities: m.capabilities},
    };
    c.ctx.set('approvals/' + id, approval);
    c.ctx.set('approval_index', [...(await c.ctx.get('approval_index', [])), id]);
    return approval;
  },
  {needs: {POST: ['system.admin']}}
);

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
    requiredText(c.body.value, 'value', 10000);
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
    const reservation = await reserveUsage(run, {calls: 1, tokens: 0, cost: 0, ms: 0}),
      started = Date.now();
    try {
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
    } finally {
      await settleUsage(run, reservation, {calls: 1, tokens: 0, cost: 0, ms: Date.now() - started});
    }
  },
  {unlocked: true}
);
