'use strict';
async function cancelRunApprovals(runId, locked = false) {
  const cancel = async () => {
    const changes = {};
    for (const id of (await DB.get('approval_index')) ?? []) {
      const approval = clone(await DB.get('approvals/' + id));
      if (approval?.run_id === runId && ['pending', 'escalated'].includes(approval.status)) {
        approval.status = 'cancelled';
        approval.answered_at = Date.now();
        changes['approvals/' + id] = approval;
      }
    }
    await DB.commit(changes);
  };
  return locked ? cancel() : exclusive(cancel);
}

async function registerApprovals(run, locked = false) {
  const save = async () => {
    const ids = (await DB.get('approval_index')) ?? [],
      changes = {};
    for (const wait of run.checkpoint.waits) {
      const spec = wait.wait_spec.approval;
      if (!spec) continue;
      const id = await hashText(run.id + '/' + wait.key + '/' + wait.created_at);
      if (ids.includes(id)) continue;
      if (
        spec.options &&
        (!Array.isArray(spec.options) || !spec.options.length || spec.options.some(x => typeof x !== 'string'))
      )
        throw bad('Approval options must be text');
      const expires = spec.expires_at ? Date.parse(spec.expires_at) : wait.created_at + (spec.timeout ?? 86400000);
      if (
        !Number.isFinite(expires) ||
        expires <= wait.created_at ||
        !['reject', 'escalate'].includes(spec.default ?? 'reject')
      )
        throw bad('Invalid approval expiration/default');
      const step = run.plan.nodes.find(n => n.id === wait.node_id);
      const approval = {
        id,
        run_id: run.id,
        node: wait.node_id,
        key: wait.key,
        question: spec.question,
        options: spec.options ?? ['approve', 'reject'],
        context_ref: spec.context_ref ?? null,
        status: 'pending',
        created_at: wait.created_at,
        expires_at: expires,
        default: spec.default ?? 'reject',
        budget: spec.budget ?? false,
        code: spec.permission ? step?.inputs.find(p => p.code)?.fallback : null,
        capabilities: spec.permission?.capabilities ?? [],
      };
      changes['approvals/' + id] = approval;
      ids.push(id);
      wait.approval_id = id;
    }
    changes.approval_index = ids;
    await DB.commit(changes);
  };
  return locked ? save() : exclusive(save);
}
async function resolveApproval(approval, answer, comment, locked = false, extra = {}) {
  const resolve = async () => {
    const current = clone(await DB.get('approvals/' + approval.id));
    if (!current || !['pending', 'escalated'].includes(current.status))
      throw new ApiError('conflict', 'Approval already answered', 409);
    if (!extra.expired && current.status === 'pending' && current.expires_at < Date.now())
      throw new ApiError('conflict', 'Approval expired', 409);
    const run = RUNS.byId.get(current.run_id);
    if (current.permission_request) {
      if (!current.options.includes(answer)) throw bad('Answer is not an offered option');
      const p = current.permission_request;
      if (answer === 'approve')
        await DB.commit({
          ['permission_grant:' + p.project_id + ':' + p.resource_id]: {
            code_hash: p.code_hash,
            grants: p.capabilities,
            code: current.code,
          },
        });
      current.status = answer === 'approve' ? 'approved' : 'rejected';
      current.answer = answer;
      current.comment = String(comment ?? '').slice(0, 2000);
      current.answered_at = Date.now();
      await DB.commit({['approvals/' + current.id]: current});
      return current;
    }
    if (!run || run.status !== 'waiting') throw bad('Run is not waiting');
    if (RUNS.active >= MAX_ACTIVE_RUNS)
      throw new ApiError('too_many_runs', 'Too many active runs; retry the approval when a slot is free', 429);
    if (!current.options.includes(answer) && !extra.expired) throw bad('Answer is not an offered option');
    current.status = extra.expired ? 'expired' : answer === 'reject' ? 'rejected' : 'approved';
    current.answer = answer;
    current.comment = String(comment ?? '').slice(0, 2000);
    current.answered_at = Date.now();
    const wait = run.checkpoint.waits.find(w => w.key === current.key);
    if (extra.budget && answer === 'approve') {
      run.budget = validateBudget(extra.budget);
    }
    if (wait?.wait_spec.approval.permission && answer === 'approve')
      await grantApprovedPermissions(run, wait.wait_spec.approval.permission);
    await DB.commit({['approvals/' + current.id]: current});
    emit(run, 'approval_answered', {approval_id: current.id, answer, status: current.status});
    await continueRun(
      run,
      {
        [current.key]: {
          key: current.key,
          value: {answer, comment: current.comment, approved: current.status === 'approved'},
        },
      },
      true
    );
    return current;
  };
  return locked ? resolve() : exclusive(resolve);
}
async function expireApprovals(at) {
  for (const id of (await DB.get('approval_index')) ?? []) {
    const approval = await DB.get('approvals/' + id);
    if (approval?.status !== 'pending' || approval.expires_at > at) continue;
    if (!approval.permission_request && RUNS.byId.get(approval.run_id)?.status !== 'waiting') {
      approval.status = 'cancelled';
      await DB.commit({['approvals/' + id]: approval});
      continue;
    }
    if (approval.permission_request) {
      approval.status = 'expired';
      await DB.commit({['approvals/' + id]: approval});
      continue;
    }
    if (approval.default === 'escalate') {
      approval.status = 'escalated';
      await DB.commit({['approvals/' + id]: approval});
    } else await resolveApproval(approval, 'reject', 'Approval expired', true, {expired: true});
  }
}
route(
  'GET',
  'approvals',
  'List pending human approvals',
  async c => {
    const list = await Promise.all((await c.ctx.get('approval_index', [])).map(id => c.ctx.get('approvals/' + id)));
    return list.filter(
      a => a && (!c.query.status ? ['pending', 'escalated'].includes(a.status) : a.status === c.query.status)
    );
  },
  {query: ['status']}
);
route(
  'GET POST',
  'approvals/{approval_id}',
  'Read or answer an approval',
  async (c, {approval_id}) => {
    const a = await DB.get('approvals/' + approval_id);
    if (!a) throw missing('Approval not found');
    return c.method === 'GET' ? a : resolveApproval(a, c.body.answer, c.body.comment, false, c.body);
  },
  {unlocked: true, body: {answer: 'approve', comment: ''}}
);
route('GET', 'runs/{run_id}/budget', 'Read run budget and consumption', async (c, {run_id}) => {
  const run = RUNS.byId.get(run_id);
  if (!run) throw missing('Run not found');
  return {limits: run.budget, usage: run.usage};
});
route('GET PUT', 'budgets/{budget_id}', 'Read or set an Initiative budget', async (c, {budget_id}) => {
  const key = 'budgets/' + budget_id;
  const value = await c.ctx.get(key, {
    limits: {calls: 100, tokens: 1000000, cost: 10, ms: 604800000},
    usage: {calls: 0, tokens: 0, cost: 0, ms: 0},
  });
  if (c.method !== 'GET') {
    value.limits = validateBudget(c.body.limits);
    c.ctx.set(key, value);
  }
  return value;
});
