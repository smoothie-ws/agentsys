'use strict';
route(
  'GET PUT',
  'projects/{project_id}/node-permissions/{node_id}',
  'Inspect effective Script grants or authorize a standalone Script',
  async (c, {project_id, node_id}) => {
    const {doc, editor} = await c.workflow(project_id),
      raw = doc.nodes.find(n => n.id === node_id),
      node = createGraphView(editor.snapshot(), {context: {project_id, workflow_id: c.workflowId}}).get(node_id);
    if (!raw || raw.config?.op !== 'script' || !node) throw missing('Script not found');
    const chain = node.context.grant_chain ?? [],
      editable = !chain.length;
    if (c.method === 'PUT') {
      if (!editable) throw bad('Edit the enclosing Custom Node permissions');
      if (!Array.isArray(c.body.grants)) throw bad('grants is required');
      checkManifest(c.body);
      raw.config.grants = clone(c.body.grants);
    }
    const layers = editable ? [raw.config.grants ?? []] : chain,
      policy = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']}),
      candidates = [...new Set([...policy.allow, ...layers.flat()])],
      effective = candidates.filter(
        capability => allows(policy.allow, capability) && layers.every(list => allows(list, capability))
      );
    return {node_id, editable, grants: raw.config.grants ?? [], layers, project_allow: policy.allow, effective};
  },
  {needs: {GET: ['graph.read'], PUT: ['system.admin']}, query: ['workflow_id'], body: {grants: ['graph.read']}}
);
route(
  'GET PUT',
  'projects/{project_id}/policy',
  'Read or set the workspace capability allow list and its egress policy',
  async (c, {project_id}) => {
    await c.project(project_id);
    const current = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']});
    if (c.method === 'PUT') {
      checkManifest({grants: c.body.allow});
      if (!Array.isArray(c.body.allow)) throw bad('allow is required');
      const next = {allow: c.body.allow};
      if ('net' in c.body) {
        if (c.body.net === null) {
          // Explicitly inherit the server's egress policy.
        } else if (!isObject(c.body.net) || Array.isArray(c.body.net)) throw bad('net must be an object or null');
        else {
          const {allow, deny_private} = c.body.net;
          if (allow !== undefined) {
            if (
              !Array.isArray(allow) ||
              allow.length > 50 ||
              allow.some(value => typeof value !== 'string' || !value || value.length > 200 || !/^[A-Za-z0-9.*:_\[\]-]+$/.test(value))
            )
              throw bad('net.allow must be a list of at most 50 host patterns');
          }
          if (deny_private !== undefined && typeof deny_private !== 'boolean')
            throw bad('net.deny_private must be true or false');
          next.net = {...(allow === undefined ? {} : {allow}), ...(deny_private === undefined ? {} : {deny_private})};
        }
      } else if (isObject(current.net)) next.net = current.net;
      c.ctx.set('policy:' + project_id, next);
    }
    const policy = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']});
    return {allow: policy.allow ?? [], net: isObject(policy.net) ? policy.net : null};
  },
  {
    needs: {GET: ['system.admin'], PUT: ['system.admin']},
    body: {allow: ['graph.read'], net: {allow: ['api.example.com'], deny_private: true}},
  }
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
    // Secrets belong in headers or the body. A placeholder in the URL would be sent literally (and would move the
    // checked host if it were expanded), so it is refused before anything leaves the server.
    if (/\{\{secret:/i.test(String(c.body.url)))
      throw bad('A secret placeholder cannot be used in a network URL; put it in a header or the body');
    const host = authorityOf(url);
    if (!netHostAllowed(host))
      throw new ApiError(
        'permission_denied',
        `This server does not fetch ${url.host}; it allows ${NET_ALLOW.join(', ')}.`,
        403
      );
    // A project can narrow egress further for its own Scripts; a direct API call is bounded by the server list.
    const projectPolicy = c.scriptContext?.project_id
      ? await DB.get('policy:' + c.scriptContext.project_id)
      : null;
    const netPolicy = isObject(projectPolicy?.net) ? projectPolicy.net : null;
    if (netPolicy && !hostMatches(netPolicy.allow, host))
      throw new ApiError(
        'permission_denied',
        `This project does not fetch ${url.host}; it allows ${(netPolicy.allow || []).join(', ') || 'no host'}.`,
        403
      );
    const denyPrivate = netPolicy?.deny_private === true || (netPolicy?.deny_private !== false && NET_BLOCK_PRIVATE);
    let pinnedAddress = null;
    if (denyPrivate) {
      try {
        pinnedAddress = await publicAddress(url.hostname);
      } catch (error) {
        throw new ApiError('network_error', `Could not resolve ${url.hostname}: ${error.message}`, 502);
      }
      if (!pinnedAddress)
        throw new ApiError(
          'permission_denied',
          `This policy does not fetch private, loopback or link-local addresses (${url.hostname}).`,
          403
        );
    }
    const executionSignal = c.scriptContext?.signal;
    if (executionSignal?.aborted) throw bad('Execution stopped');
    {
      const request = await injectSecrets(c.body);
      const timeout = request.timeout === undefined ? 30000 : Number(request.timeout);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
        throw bad('timeout must be a number of milliseconds from 1 to 120000');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('The request timed out')), timeout);
      const abort = () => controller.abort(executionSignal?.reason);
      executionSignal?.addEventListener('abort', abort, {once: true});
      try {
        const limit = 2000000;
        const pinned = denyPrivate && typeof AGENTSYS_HTTP_REQUEST === 'function';
        const response = pinned
          ? await AGENTSYS_HTTP_REQUEST({
              url: url.toString(),
              method: request.method ?? 'GET',
              headers: request.headers ?? {},
              body: request.body,
              address: pinnedAddress,
              limit,
              timeout,
              signal: controller.signal,
            })
          : await fetch(url, {
              method: request.method ?? 'GET',
              headers: request.headers,
              body: request.body,
              redirect: 'manual',
              signal: controller.signal,
            });
        if (response.status >= 300 && response.status < 400)
          throw new ApiError('permission_denied', 'Redirects require a separate request and host permission', 403);
        let text;
        if (pinned) text = response.text;
        else {
          const declared = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(declared) && declared > limit) throw bad('Network response is too large');
          // Read with a hard limit instead of buffering whatever a remote endpoint chooses to send.
          if (response.body?.getReader) {
            const reader = response.body.getReader(),
              decoder = new TextDecoder(),
              chunks = [];
            let size = 0;
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel().catch(() => {});
                throw bad('Network response is too large');
              }
              chunks.push(value);
            }
            text = chunks.map(chunk => decoder.decode(chunk, {stream: true})).join('') + decoder.decode();
          } else text = await response.text();
        }
        if (text.length > limit) throw bad('Network response is too large');
        // Secrets can be reflected by an endpoint: scrub all stored values before returning.
        let clean = text;
        for (const m of JSON.stringify(c.body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)) {
          const secret = await DB.get('secrets/' + m[1]);
          if (secret?.value) clean = clean.replaceAll(secret.value, '[REDACTED]');
        }
        return {status: response.status, text: clean};
      } catch (error) {
        if (executionSignal?.aborted) throw bad('Execution stopped');
        if (error?.status) throw error;
        if (error?.code === 'too_large') throw bad('Network response is too large');
        if (error?.code === 'timeout' || controller.signal.aborted)
          throw new ApiError('network_error', 'The network request timed out', 504);
        throw new ApiError('network_error', 'The network request failed: ' + (error?.message || error), 502);
      } finally {
        clearTimeout(timer);
        executionSignal?.removeEventListener('abort', abort);
      }
    }
  },
  {unlocked: true}
);
