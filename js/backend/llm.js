'use strict';

const hashText = async text =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
const redactText = value =>
  String(value)
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
function schemaIssues(value, schema, at = '$') {
  if (!isObject(schema)) throw bad('schema must be an object');
  const problems = [];
  const types = {
    object: isObject,
    array: Array.isArray,
    string: v => typeof v === 'string',
    number: finite,
    integer: Number.isInteger,
    boolean: v => typeof v === 'boolean',
    null: v => v === null,
  };
  if (schema.type && (!types[schema.type] || !types[schema.type](value))) return [`${at}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value)))
    problems.push(`${at}: not in enum`);
  if (isObject(value)) {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) problems.push(`${at}.${name}: required`);
    for (const [name, v] of Object.entries(value)) {
      if (schema.properties?.[name]) problems.push(...schemaIssues(v, schema.properties[name], at + '.' + name));
      else if (schema.additionalProperties === false) problems.push(`${at}.${name}: unknown property`);
    }
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((v, i) => problems.push(...schemaIssues(v, schema.items, `${at}[${i}]`)));
  if (
    finite(value) &&
    ((finite(schema.minimum) && value < schema.minimum) || (finite(schema.maximum) && value > schema.maximum))
  )
    problems.push(`${at}: out of range`);
  return problems;
}
function validateBudget(value) {
  if (
    !isObject(value) ||
    Object.entries(value).some(([k, v]) => !['calls', 'tokens', 'cost', 'ms'].includes(k) || !finite(v) || v < 0)
  )
    throw bad('budget contains nonnegative calls, tokens, cost and ms limits');
  return clone(value);
}
async function reserveUsage(run, estimate) {
  if (!run) return null;
  return exclusive(async () => {
    const accounts = [{usage: run.usage, limits: run.budget}];
    let initiative;
    if (run.initiative_id) {
      const record = await DB.get('initiatives/' + run.initiative_id);
      if (!record) throw missing('Initiative not found');
      const id = record.budget_id ?? run.initiative_id;
      initiative = {
        id,
        ...((await DB.get('budgets/' + id)) ?? {usage: {calls: 0, tokens: 0, cost: 0, ms: 0}, limits: run.budget}),
      };
      accounts.push(initiative);
    }
    for (const account of accounts)
      for (const [k, v] of Object.entries(estimate)) {
        if (account.limits?.[k] !== undefined && (account.usage[k] ?? 0) + v > account.limits[k])
          throw new ApiError('budget_exceeded', `Budget exceeded: ${k}`, 409);
      }
    for (const account of accounts)
      for (const [k, v] of Object.entries(estimate)) account.usage[k] = (account.usage[k] ?? 0) + v;
    await DB.commit({
      [runKey(run.id) + '/budget']: {limits: run.budget, usage: run.usage},
      ...(initiative ? {['budgets/' + initiative.id]: initiative} : {}),
    });
    return {estimate, initiative};
  });
}
async function settleUsage(run, reservation, actual) {
  if (!run || !reservation) return;
  await exclusive(async () => {
    const accounts = [run.usage];
    const initiative = reservation.initiative ? await DB.get('budgets/' + reservation.initiative.id) : null;
    if (initiative) accounts.push(initiative.usage);
    for (const usage of accounts)
      for (const k of Object.keys(reservation.estimate))
        usage[k] = Math.max(0, (usage[k] ?? 0) - reservation.estimate[k] + (actual[k] ?? 0));
    await DB.commit({
      [runKey(run.id) + '/budget']: {limits: run.budget, usage: run.usage},
      ...(initiative ? {['budgets/' + initiative.id]: initiative} : {}),
    });
  });
}
async function modelCall(body, context = {}) {
  context ??= {};
  const {
    prompt,
    messages,
    provider: requested,
    model: selected,
    retry = {},
    timeout = 60000,
    schema,
    format_attempts = 1,
    ...options
  } = body;
  if (typeof (messages ?? prompt) !== 'string' && !Array.isArray(messages ?? prompt))
    throw bad('Pass prompt or messages');
  const providers = ((await DB.get('resources')) ?? []).filter(r => r.kind === 'provider');
  const resource = requested ? providers.find(r => r.id === requested || r.name === requested) : providers[0];
  if (!resource) throw bad('Add a provider in the Library first.');
  const provider = await injectSecrets(resource.payload),
    model = selected || provider.default_model;
  const privateValues = [
    provider.api_key,
    ...Object.entries(provider.headers ?? {})
      .filter(([k]) => /authorization|key|token|secret/i.test(k))
      .map(([, v]) => v),
  ].filter(v => typeof v === 'string' && v.length > 0);
  const scrub = value => {
    if (typeof value === 'string') {
      for (const secret of privateValues) value = value.replaceAll(secret, '[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  };
  if (!model) throw bad('Choose a model');
  const prefs = (await DB.get('prefs')) ?? {};
  if (prefs.allowed_models?.length && !prefs.allowed_models.includes(resource.name + '/' + model))
    throw new ApiError('permission_denied', 'Model is not allowed', 403);
  const max = retry.max ?? 2,
    backoff = retry.backoff ?? 100,
    retryOn = retry.retry_on ?? [429, 500, 502, 503, 504, 'network'];
  if (
    !Number.isInteger(max) ||
    max < 0 ||
    max > 10 ||
    !finite(backoff) ||
    backoff < 0 ||
    backoff > 60000 ||
    !Array.isArray(retryOn) ||
    !finite(timeout) ||
    timeout < 1 ||
    timeout > 120000 ||
    !Number.isInteger(format_attempts) ||
    format_attempts < 0 ||
    format_attempts > 5
  )
    throw bad('Invalid retry, timeout or format_attempts');
  const run = RUNS.byId.get(context.run_id);
  let conversation = clone(
    messages ?? [
      ...(options.system ? [{role: 'system', content: options.system}] : []),
      {role: 'user', content: prompt},
    ]
  );
  delete options.system;
  for (let formatTry = 0; formatTry <= (schema ? format_attempts : 0); formatTry++) {
    let response, text;
    for (let attempt = 0; attempt <= max; attempt++) {
      const payload = {model, messages: conversation, ...provider.generation, ...options};
      delete payload.raw;
      if (
        payload.max_tokens !== undefined &&
        (!Number.isInteger(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > 1000000)
      )
        throw bad('Invalid max_tokens');
      const promptText = JSON.stringify(payload),
        estimated = new TextEncoder().encode(promptText).length + (payload.max_tokens ?? 1024);
      const prices = provider.prices ?? {input: 0, output: 0};
      const reservation = await reserveUsage(run, {
        calls: 1,
        tokens: estimated,
        cost: (estimated * Math.max(prices.input, prices.output)) / 1000000,
        ms: 0,
      });
      const started = Date.now();
      let error;
      try {
        response = scrub(
          await providerFetch(provider, provider.chat_path || 'chat/completions', {
            method: 'POST',
            body: promptText,
            signal: run
              ? AbortSignal.any([
                  AbortSignal.timeout(timeout),
                  run.controller.signal,
                  ...(run.callController ? [run.callController.signal] : []),
                ])
              : AbortSignal.timeout(timeout),
          })
        );
        text = response.choices?.[0]?.message?.content ?? '';
      } catch (e) {
        error = e;
        error.message = scrub(redactText(error.message));
      }
      const elapsed = Date.now() - started,
        usage = response?.usage ?? {};
      const tokens = usage.total_tokens ?? (error ? 0 : Math.ceil((promptText.length + String(text).length) / 4));
      const cost =
        ((usage.prompt_tokens ?? tokens) * prices.input + (usage.completion_tokens ?? 0) * prices.output) / 1000000;
      await settleUsage(run, reservation, {calls: 1, tokens, cost, ms: elapsed});
      const cleanPrompt = redactText(promptText),
        cleanResponse = redactText(text ?? '');
      const promptHash = await hashText(cleanPrompt),
        responseHash = await hashText(cleanResponse);
      const event = {
        provider: resource.name,
        model,
        parameters: {...options, retry: {max, backoff, retry_on: retryOn}, timeout},
        prompt_hash: promptHash,
        prompt_size: promptText.length,
        response_hash: responseHash,
        response_size: String(text ?? '').length,
        tokens,
        cost,
        ms: elapsed,
        attempt,
        format_attempt: formatTry,
        error: error?.message ?? null,
      };
      if (prefs.trace_blobs !== false)
        await exclusive(async () => {
          const index = clone((await DB.get('blob_index')) ?? {}),
            at = Date.now();
          index[promptHash] = at;
          index[responseHash] = at;
          await DB.commit({
            blob_index: index,
            ['blobs/' + promptHash]: {text: cleanPrompt, created_at: at},
            ['blobs/' + responseHash]: {text: cleanResponse, created_at: at},
          });
        });
      if (run) {
        emit(run, 'llm_call', event);
        await persistRun(run);
      }
      if (run && Object.entries(run.budget).some(([k, v]) => (run.usage[k] ?? 0) > v))
        throw new ApiError('budget_exceeded', 'Actual usage exceeded the reserved budget', 409);
      if (!error) break;
      if (run?.controller.signal.aborted || run?.callController?.signal.aborted) throw error;
      if (attempt === max || !retryOn.includes(error.providerStatus ?? 'network')) throw error;
      await new Promise(resolve => setTimeout(resolve, backoff * 2 ** attempt));
    }
    if (!schema) return options.raw ? response : {text, usage: response.usage ?? null};
    let value, issues;
    try {
      value = JSON.parse(text);
      issues = schemaIssues(value, schema);
    } catch (error) {
      issues = [error.message];
    }
    if (!issues.length) return {text, value, usage: response.usage ?? null};
    if (formatTry === format_attempts) throw new ApiError('invalid_model_output', issues.join('; '), 422);
    conversation = [
      ...conversation,
      {role: 'assistant', content: text},
      {
        role: 'user',
        content: 'Return valid JSON matching this schema: ' + JSON.stringify(schema) + '\nErrors: ' + issues.join('; '),
      },
    ];
  }
}
