'use strict';
function validateQuotas(value) {
  if (!Array.isArray(value) || value.length > 50) throw bad('quotas is a list of at most 50 rules');
  const names = new Set();
  return value.map(rule => {
    if (!isObject(rule) || typeof rule.key !== 'string' || !rule.key || rule.key.length > 300 || names.has(rule.key))
      throw bad('Invalid or duplicate quota key');
    names.add(rule.key);
    const result = {
      key: rule.key,
      limit: rule.limit,
      window_ms: rule.window_ms ?? 60000,
      capacity: rule.capacity ?? rule.limit,
      refill_per_second: rule.refill_per_second ?? rule.limit / 60,
      reserve_units: rule.reserve_units ?? 1,
    };
    for (const key of ['limit', 'window_ms', 'capacity', 'refill_per_second', 'reserve_units'])
      if (!Number.isFinite(result[key]) || result[key] <= 0 || result[key] > 1e12) throw bad('Invalid quota ' + key);
    return result;
  });
}
// Called under exclusive. Reservations survive waits; abandoned process reservations expire with their window.
function charge(bucket, rule, units, at) {
  if (!Number.isFinite(units)) throw bad('Invalid charge units');
  if (!bucket || at - bucket.since >= rule.window_ms) bucket = {since: at, used: 0, tokens: rule.capacity, updated: at};
  const tokens = Math.min(
    rule.capacity,
    bucket.tokens + (Math.max(0, at - bucket.updated) * rule.refill_per_second) / 1000
  );
  if (units > 0 && (bucket.used + units > rule.limit || tokens < units))
    throw new ApiError('quota_exceeded', 'Quota exceeded: ' + rule.key, 429);
  return {
    ...bucket,
    used: Math.max(0, bucket.used + units),
    tokens: Math.min(rule.capacity, tokens - units),
    updated: at,
  };
}
async function reserveBridge(context, method, path) {
  if (!context.workflow_id) return null;
  return exclusive(async () => {
    const key = workflowBase(context.workflow_id) + '/usage',
      ctl = (await DB.get(workflowControlKey(context.workflow_id))) ?? defaultWorkflowControl(),
      usage = clone((await DB.get(key)) ?? {}),
      callKey = `${String(method).toUpperCase()} ${String(path).replace(/^\/?(?:api\/)?/, '')}`,
      route = ROUTES.find(r => r.methods.has(method) && r.regex.test(path)),
      methodKey = `${method} ${route?.pattern ?? path}`;
    const rules = ctl.quotas.filter(
      r => r.key === '*' || r.key === callKey || (r.key.endsWith('*') && callKey.startsWith(r.key.slice(0, -1)))
    );
    for (const rule of rules) usage[rule.key] = charge(usage[rule.key], rule, rule.reserve_units, Date.now());
    // Keep generic call accounting even when no quota was configured.
    usage.calls = (usage.calls ?? 0) + 1;
    usage.methods ??= {};
    const at = Date.now(),
      counter = usage.methods[methodKey];
    usage.methods[methodKey] =
      !counter || at - counter.since >= 60000
        ? {since: at, calls: 1, units: 0, failures: 0}
        : {...counter, calls: counter.calls + 1};
    await DB.commit({[key]: usage});
    return {key, workflow_id: context.workflow_id, rules, methodKey, reserved_at: at};
  });
}
// A call may report how much it used (`usage.units` in its result); otherwise it counts as one unit.
async function settleBridge(reservation, result, error) {
  if (!reservation) return;
  const units = error ? 0 : (result?.usage?.units ?? 1);
  if (!Number.isFinite(units) || units < 0) throw bad('usage.units must be a nonnegative number');
  return exclusive(async () => {
    if (!((await DB.get('projects')) ?? []).some(p => p.workflows.some(w => w.id === reservation.workflow_id))) return;
    const usage = clone((await DB.get(reservation.key)) ?? {});
    for (const rule of reservation.rules) {
      // A call must stay within the configured maximum reservation.
      if (units > rule.reserve_units)
        throw new ApiError('quota_exceeded', 'Usage exceeds reserve_units: ' + rule.key, 429);
      const bucket = usage[rule.key];
      if (bucket?.since <= reservation.reserved_at && reservation.reserved_at - bucket.since < rule.window_ms)
        usage[rule.key] = charge(bucket, rule, units - rule.reserve_units, Date.now());
    }
    usage.units = (usage.units ?? 0) + units;
    const counter = usage.methods?.[reservation.methodKey];
    if (counter && counter.since <= reservation.reserved_at && reservation.reserved_at - counter.since < 60000) {
      counter.units += units;
      if (error) counter.failures++;
    }
    await DB.commit({[reservation.key]: usage});
  });
}
route('GET', 'workflows/{workflow_id}/usage', 'Read workflow bridge accounting', async (c, {workflow_id}) => {
  await workflowOwner(c, workflow_id);
  return c.ctx.get(workflowBase(workflow_id) + '/usage', {});
});
