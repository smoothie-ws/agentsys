// Executable plugin packages: one isolated host per enabled plugin, with owned registrations and callbacks.
'use strict';
const PLUGIN_HOSTS = new Map();
const PLUGIN_LOADING = new Map();

function pluginVersionMatches(version, range) {
  if (range === '*') return true;
  const wanted = range
      .match(/(\d+)\.(\d+)\.(\d+)$/)
      .slice(1)
      .map(Number),
    actual = version.split(/[.+-]/).slice(0, 3).map(Number),
    compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (range.startsWith('>=')) return compare(actual, wanted) >= 0;
  if (range.startsWith('~')) return compare(actual, wanted) >= 0 && actual[0] === wanted[0] && actual[1] === wanted[1];
  if (range.startsWith('^')) {
    const upper = wanted[0] ? [wanted[0] + 1, 0, 0] : wanted[1] ? [0, wanted[1] + 1, 0] : [0, 0, wanted[2] + 1];
    return compare(actual, wanted) >= 0 && compare(actual, upper) < 0;
  }
  return compare(actual, wanted) === 0;
}

function normalizeRuntimeRegistry(pkg, registry) {
  if (!isObject(registry)) throw bad('Invalid plugin registry');
  const contributes = {...registry};
  delete contributes.events;
  const normalized = validatePluginRegistrations(pkg, contributes);
  const events = pluginList(registry.events, 'event subscriptions', 100);
  for (const event of events)
    if (
      !isObject(event) ||
      !['workspace.changed', 'library.changed', 'settings.changed', 'storage.changed'].includes(event.event) ||
      typeof event.handler !== 'string' ||
      event.handler.length > 100
    )
      throw bad('Unknown plugin event subscription');
  return {contributions: normalized, events: clone(events)};
}

// This function is also used by trusted inline tests. Production runs it inside a frozen Worker realm.
function pluginRuntimeProgram(send) {
  const pending = new Map(),
    handlers = new Map(),
    modules = new Map(),
    owned = new Set(),
    timers = new Set(),
    timerStarts = new Map();
  const cancelled = new Set();
  const buckets = {
    library: new Map(),
    nodes: new Map(),
    templates: new Map(),
    pages: new Map(),
    tiles: new Map(),
    commands: new Map(),
    endpoints: new Map(),
    events: new Map(),
  };
  let sequence = 0,
    nextHandle = 0,
    phase = 'new',
    input,
    app,
    context,
    main,
    currentJob = null,
    queue = Promise.resolve();
  let settingsSchema = {fields: []},
    registrationPending = Promise.resolve();
  const copy = value => JSON.parse(JSON.stringify(value));
  const snapshot = () => ({
    ...Object.fromEntries(
      Object.entries(buckets).map(([key, value]) => [key, [...value.values()].map(v => (key === 'nodes' ? v.id : v))])
    ),
    settings: settingsSchema,
  });
  const ask = (type, args) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      send({type: 'rpc', id, operation: type, args, job: currentJob});
    });
  const changed = () => {
    if (phase !== 'active') return;
    registrationPending = ask('registry', snapshot());
    registrationPending.catch(error => send({type: 'log', error: error.message}));
    return registrationPending;
  };
  const disposable = dispose => {
    let alive = true;
    const handle = {
      dispose() {
        if (!alive) return;
        alive = false;
        owned.delete(handle);
        return dispose();
      },
    };
    owned.add(handle);
    return handle;
  };
  const register = (bucket, spec, callback) => {
    if (!['activating', 'active'].includes(phase)) throw new Error('The plugin is not active');
    if (!spec || typeof spec !== 'object') throw new Error('Registration needs an object');
    const value = {...spec},
      id = value.id ?? value.name;
    if (!id || buckets[bucket].has(id)) throw new Error('Duplicate or missing registration ID: ' + id);
    if (value.parent && typeof value.parent === 'object') value.parent = value.parent.id;
    const after = typeof value.after === 'object' ? value.after.id : value.after;
    delete value.after;
    if (callback !== undefined) {
      if (typeof callback !== 'function') throw new Error('A handler must be a function');
      value.handler = bucket + ':' + id;
      handlers.set(value.handler, callback);
    }
    if (after !== undefined) {
      const entries = [...buckets[bucket]],
        index = entries.findIndex(([key]) => key === after);
      if (index < 0) throw new Error('Unknown preceding registration: ' + after);
      entries.splice(index + 1, 0, [id, value]);
      buckets[bucket] = new Map(entries);
    } else buckets[bucket].set(id, value);
    const handle = disposable(() => {
      buckets[bucket].delete(id);
      if (value.handler) handlers.delete(value.handler);
      return changed();
    });
    handle.id = id;
    handle.kind = bucket;
    changed();
    return handle;
  };
  const sectionId = section => input.plugin + '.' + (typeof section === 'string' ? section : section.id);
  const request = (method, path, body, query) => ask('request', [method, path, body, query]);
  const load = (filename, from = '') => {
    if (filename === '@agentsys/plugin') return app;
    if (!filename.startsWith('.') && from) throw new Error('Only packaged relative modules can be required');
    const parts = from ? from.split('/').slice(0, -1) : [];
    for (const part of filename.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('Module path leaves the package');
        parts.pop();
      } else parts.push(part);
    }
    const path = parts.join('/'),
      key = [path, path + '.js', path + '.json', path + '/index.js'].find(p => Object.hasOwn(input.files, p));
    if (!key) throw new Error('Packaged module not found: ' + path);
    if (modules.has(key)) return modules.get(key).exports;
    const module = {exports: {}};
    modules.set(key, module);
    if (key.endsWith('.json')) module.exports = JSON.parse(input.files[key]);
    else
      new Function('module', 'exports', 'require', input.files[key])(module, module.exports, path => load(path, key));
    return module.exports;
  };
  const enqueue = work => {
    queue = queue.then(work, work);
    return queue;
  };
  const schedule = (callback, ms, repeat) => {
    if (typeof callback !== 'function' || !Number.isFinite(ms) || ms < 0 || ms > 2147483647)
      throw new Error('Invalid timer');
    let timer,
      alive = true;
    const tick = () => {
      if (!alive) return;
      enqueue(async () => {
        if (!alive || phase !== 'active') return;
        try {
          await callback();
        } catch (error) {
          send({type: 'log', error: error.message});
        }
        if (repeat && alive) start();
        else handle.dispose();
      });
    };
    const start = () => {
      timer = setTimeout(tick, repeat ? Math.max(10, ms) : ms);
      timer?.unref?.();
    };
    const handle = disposable(() => {
      alive = false;
      clearTimeout(timer);
      timers.delete(handle);
      timerStarts.delete(handle);
    });
    timers.add(handle);
    if (phase === 'active') start();
    else timerStarts.set(handle, start);
    return handle;
  };
  const activate = async data => {
    input = data;
    phase = 'activating';
    app = {
      request,
      library: {
        registerSection: spec => register('library', spec),
        registerCollection: spec => register('library', spec),
        registerNodeCatalog: file => register('nodes', {id: file}),
        listItems: (section, query) => request('GET', 'library/sections/' + sectionId(section) + '/items', null, query),
        createItem: (section, item) => request('POST', 'library/sections/' + sectionId(section) + '/items', item),
        updateItem: (section, id, item) =>
          request('PUT', 'library/sections/' + sectionId(section) + '/items/' + encodeURIComponent(id), item),
        deleteItem: (section, id) =>
          request('DELETE', 'library/sections/' + sectionId(section) + '/items/' + encodeURIComponent(id)),
        getSecret: (section, id, key) => ask('collection-secret', [sectionId(section), id, key]),
      },
      commands: {
        register: (id, handler, options = {}) => register('commands', {id, title: options.title ?? id}, handler),
        execute: (id, ...args) => {
          const handler = handlers.get('commands:' + id);
          if (!handler) throw new Error('Command not registered: ' + id);
          return handler(...args);
        },
      },
      endpoints: {
        register: (name, handler, options = {}) =>
          register(
            'endpoints',
            {
              name,
              methods: options.methods ?? ['POST'],
              ...(options.permissions ? {permissions: options.permissions} : {}),
              ...(options.timeout !== undefined ? {timeout: options.timeout} : {}),
            },
            handler
          ),
      },
      views: {register: spec => register('pages', spec), registerTile: spec => register('tiles', spec)},
      templates: {register: spec => register('templates', spec)},
      events: {on: (event, handler) => register('events', {id: 'event-' + ++nextHandle, event}, handler)},
      timers: {
        setTimeout: (handler, ms) => schedule(handler, ms, false),
        setInterval: (handler, ms) => schedule(handler, ms, true),
      },
      settings: {
        register: fields => {
          settingsSchema = {fields: copy(fields)};
          changed();
          return disposable(() => {
            settingsSchema = {fields: []};
            changed();
          });
        },
        get: () => ask('settings', ['get', settingsSchema]),
        set: values => ask('settings', ['set', settingsSchema, values]),
      },
      storage: {
        get: key => ask('storage', ['get', key]),
        set: (key, value, version) => ask('storage', ['set', key, value, version]),
        delete: (key, version) => ask('storage', ['delete', key, null, version]),
        list: prefix => ask('storage', ['list', prefix]),
      },
      secrets: {reference: name => ask('secret', name)},
      navigation: {
        open: target =>
          ask('ui', {type: 'navigate', path: typeof target === 'string' ? target : '/library/' + sectionId(target)}),
      },
      notifications: {show: (title, body = '') => request('POST', 'notifications', {title, body})},
      workflows: {
        get: (project, workflow) => request('GET', 'projects/' + project + '/workflow', null, {workflow_id: workflow}),
        edit: (project, workflow, operations) =>
          request('POST', 'projects/' + project + '/batch', {workflow_id: workflow, operations}),
        run: (project, workflow, options = {}) =>
          request('POST', 'projects/' + project + '/execution', {...options, workflow_id: workflow}),
        inspect: (project, workflow) =>
          request('GET', 'projects/' + project + '/execution', null, {workflow_id: workflow}),
        stop: (project, workflow) =>
          request('DELETE', 'projects/' + project + '/execution', null, {workflow_id: workflow}),
        dispatch: (project, workflow, id) =>
          request('GET', 'projects/' + project + '/execution/dispatches/' + id, null, {workflow_id: workflow}),
        trace: (project, workflow, filters = {}) =>
          request('GET', 'projects/' + project + '/execution/trace', null, {...filters, workflow_id: workflow}),
        getScope: (project, workflow, id) =>
          request('GET', 'projects/' + project + '/execution/scopes/' + id, null, {workflow_id: workflow}),
        setScope: (project, workflow, id, value, version) =>
          request('PUT', 'projects/' + project + '/execution/scopes/' + id, {workflow_id: workflow, value, version}),
      },
    };
    context = {
      id: data.plugin,
      app,
      subscriptions: {
        add(...handles) {
          for (const handle of handles) {
            if (!handle || typeof handle.dispose !== 'function') throw new Error('A subscription needs dispose()');
            owned.add(handle);
          }
        },
      },
      dependencies: copy(data.dependencies ?? {}),
      onReady: handler => {
        if (typeof handler !== 'function') throw new Error('onReady needs a handler');
        const key = 'ready:' + ++nextHandle;
        handlers.set(key, handler);
        return disposable(() => handlers.delete(key));
      },
    };
    main = load(data.main);
    if (typeof main.activate !== 'function') throw new Error('The entry module must export activate(context)');
    await main.activate(context);
    return snapshot();
  };
  const deactivate = async () => {
    phase = 'stopping';
    const errors = [];
    try {
      await main?.deactivate?.();
    } catch (error) {
      errors.push(error.message);
    }
    for (const timer of [...timers]) timer.dispose();
    for (const handle of [...owned].reverse())
      try {
        await handle.dispose();
      } catch (error) {
        errors.push(error.message);
      }
    handlers.clear();
    phase = 'stopped';
    if (errors.length) throw new Error('Plugin cleanup: ' + errors.join('; '));
    return null;
  };
  const receive = data => {
    if (data.type === 'cancel') {
      cancelled.add(data.id);
      return;
    }
    if (data.type === 'reply') {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      if (entry)
        data.error ? entry.reject(Object.assign(new Error(data.error), {code: data.code})) : entry.resolve(data.result);
      return;
    }
    enqueue(async () => {
      if (cancelled.delete(data.id)) return;
      currentJob = data.id;
      try {
        let result;
        if (data.type === 'activate') result = await activate(data.input);
        else if (data.type === 'ready') {
          phase = 'active';
          for (const start of timerStarts.values()) start();
          timerStarts.clear();
          for (const [key, handler] of handlers) if (key.startsWith('ready:')) await handler();
          result = null;
        } else if (data.type === 'deactivate') result = await deactivate();
        else if (data.type === 'heartbeat') result = null;
        else if (data.type === 'invoke') {
          const handler = handlers.get(data.handler);
          if (phase !== 'active' || !handler) throw new Error('Handler is not active: ' + data.handler);
          result = await handler(...data.args);
        } else throw new Error('Unknown plugin host message');
        await registrationPending;
        send({type: 'done', id: data.id, result: JSON.stringify(result ?? null)});
      } catch (error) {
        send({type: 'failed', id: data.id, error: String(error.message || error).slice(0, 2000), code: error.code});
      } finally {
        cancelled.delete(data.id);
        currentJob = null;
      }
    });
  };
  receive.dispose = () => {
    phase = 'stopped';
    for (const timer of [...timers]) timer.dispose();
  };
  return receive;
}

const PLUGIN_HOST_SOURCE = `(() => {
const send=globalThis.postMessage.bind(globalThis);
${WORKER_FREEZE}
const receive=(${pluginRuntimeProgram.toString()})(send);
globalThis.addEventListener?.('message',event=>receive(event.data));
${workerBlock(WORKER_BLOCKED.filter(name => !['Date', 'Math'].includes(name)))}
return text=>receive(JSON.parse(text));
})();`;

function createPluginHost(record, pkg) {
  const runtime = {
    id: record.id,
    version: record.manifest.version,
    pkg,
    jobs: new Map(),
    sequence: 0,
    active: false,
    stopped: false,
  };
  const fail = error => {
    for (const job of runtime.jobs.values()) {
      clearTimeout(job.timer);
      job.cleanup();
      job.controller.abort();
      job.reject(error);
    }
    const wasActive = runtime.active;
    clearTimeout(runtime.heartbeat);
    runtime.jobs.clear();
    runtime.active = false;
    runtime.worker.terminate();
    runtime.stopped = true;
    if (wasActive && PLUGIN_HOSTS.get(runtime.id) === runtime) {
      PLUGIN_HOSTS.delete(runtime.id);
      markPluginRuntimeFailed(runtime.id, runtime.version, runtime.pkg, error)
        .then(() => failPluginDependents(runtime.id, error))
        .catch(console.error);
    }
  };
  runtime.fail = fail;
  const onMessage = async data => {
    if (runtime.stopped) return;
    if (data.type === 'rpc') {
      try {
        const result = await pluginRuntimeRPC(runtime, data);
        if (!runtime.stopped) runtime.worker.postMessage({type: 'reply', id: data.id, result: result ?? null});
      } catch (error) {
        if (!runtime.stopped)
          runtime.worker.postMessage({type: 'reply', id: data.id, error: error.message, code: error.code});
      }
    } else if (data.type === 'log') logPlugin(record.id, {kind: 'runtime', error: data.error});
    else {
      const job = runtime.jobs.get(data.id);
      if (!job) return;
      runtime.jobs.delete(data.id);
      clearTimeout(job.timer);
      job.cleanup();
      if (!runtime.jobs.size) runtime.worker.unref?.();
      if (data.type === 'failed') job.reject(Object.assign(new Error(data.error), {code: data.code}));
      else {
        if (data.result.length > PLUGIN.resultBytes) job.reject(bad('Plugin result is too large'));
        else job.resolve({result: JSON.parse(data.result), effects: job.effects});
      }
    }
  };
  if (canStartWorkers()) {
    runtime.worker = startSourceWorker(PLUGIN_HOST_SOURCE);
    runtime.worker.onmessage = event => onMessage(event.data);
    runtime.worker.onerror = event => {
      if (!runtime.stopped) fail(new Error(event.message || 'The plugin host stopped'));
    };
  } else {
    const receive = pluginRuntimeProgram(data => Promise.resolve().then(() => onMessage(clone(data))));
    runtime.worker = {
      postMessage: data => Promise.resolve().then(() => receive(clone(data))),
      terminate: () => receive.dispose(),
    };
  }
  runtime.request = (type, args = {}, timeout = PLUGIN.endpointMs, signal, origin) =>
    new Promise((resolve, reject) => {
      if (runtime.stopped) return reject(new Error('Plugin host is stopped'));
      if (signal?.aborted) return reject(new Error('Execution stopped'));
      const id = ++runtime.sequence,
        timer = setTimeout(() => fail(new ApiError('timeout', 'Plugin callback timed out', 504)), timeout);
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        runtime.jobs.delete(id);
        runtime.worker.postMessage({type: 'cancel', id});
        reject(new Error('Execution stopped'));
        if (!runtime.jobs.size) runtime.worker.unref?.();
      };
      runtime.jobs.set(id, {
        resolve,
        reject,
        timer,
        effects: [],
        controller,
        origin,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, {once: true});
      runtime.worker.ref?.();
      runtime.worker.postMessage({type, id, ...args});
    });
  runtime.watch = () => {
    if (runtime.stopped) return;
    runtime.heartbeat = setTimeout(
      async () => {
        if (!runtime.jobs.size) await runtime.request('heartbeat').catch(() => {});
        runtime.watch();
      },
      Math.max(1000, PLUGIN.endpointMs)
    );
    runtime.heartbeat?.unref?.();
  };
  runtime.watch();
  return runtime;
}

async function pluginRuntimeRPC(runtime, message) {
  const {operation, args} = message;
  if (message.job != null && !runtime.jobs.has(message.job)) throw new Error('Plugin operation was cancelled');
  if (operation === 'collection-secret') {
    const [section, id, key] = args;
    const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(r => r.id === runtime.id);
    const collection = pluginContributions(record).library.find(s => runtime.id + '.' + s.id === section);
    if (!record?.enabled || !collection?.item?.fields.some(f => f.key === key && f.type === 'secret'))
      throw new ApiError('permission_denied', 'Only owned collection credentials are available', 403);
    const stored = await DB.get(catalogKey(section));
    if (!stored?.items.some(item => item.id === id)) throw missing('Library resource not found');
    return (await DB.get(catalogSecretKey(section, id)))?.[key] ?? null;
  }
  if (operation === 'secret') {
    const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(r => r.id === runtime.id);
    if (
      !record?.enabled ||
      !pluginSecrets(record).includes(args) ||
      !allows(pluginCapabilities(record), 'secrets.use:' + args) ||
      !allows(record.grants, 'secrets.use:' + args)
    )
      throw new ApiError('permission_denied', 'Secret use is not granted', 403);
    return '{{secret:' + args + '}}';
  }
  if (operation === 'storage') {
    const [op, key, value, version] = args;
    return exclusive(async () => {
      if (runtime.stopped || (message.job != null && !runtime.jobs.has(message.job)))
        throw bad('Plugin operation was cancelled');
      const c = new Call('POST', {}, {}, null);
      if (!(await c.ctx.get(PLUGIN_INDEX, [])).some(r => r.id === runtime.id)) throw missing('Plugin not installed');
      const result = await pluginDataOperation(c, runtime.id, op, key, {
        value,
        ...(version == null ? {} : {version}),
        prefix: key,
      });
      if (runtime.stopped || (message.job != null && !runtime.jobs.has(message.job)))
        throw bad('Plugin operation was cancelled');
      await c.ctx.commit();
      return result;
    });
  }
  if (operation === 'settings') {
    const schema = validatePluginSettingsSchema(args[1]);
    if (args[0] === 'get') return pluginSettingValues(schema, (await DB.get(pluginKey(runtime.id, 'settings'))) ?? {});
    return exclusive(async () => {
      const c = new Call('PUT', {}, {}, null);
      if (!(await pluginIndex(c)).some(r => r.id === runtime.id)) throw missing('Plugin not installed');
      const key = pluginKey(runtime.id, 'settings'),
        saved = pluginSettingValues(schema, await c.ctx.get(key, {}));
      const values = pluginSettingValues(schema, {...saved, ...args[2]}, true);
      c.ctx.set(key, values);
      await c.ctx.commit();
      return {schema, values};
    });
  }
  if (operation === 'request') {
    const job = runtime.jobs.get(message.job);
    return pluginBridgeRequest(runtime.id, ...args, {
      ...job?.origin,
      signal: job?.controller.signal,
      current: () =>
        !runtime.stopped &&
        (message.job == null || runtime.jobs.has(message.job)) &&
        job?.origin?.current?.() !== false,
    });
  }
  if (operation === 'registry') {
    if (!runtime.active || PLUGIN_HOSTS.get(runtime.id) !== runtime) throw bad('Plugin activation has not completed');
    return publishPluginRegistry(runtime, args);
  }
  if (operation === 'ui') {
    if (args.type !== 'navigate' || typeof args.path !== 'string' || !/^\/(?!\/)[A-Za-z0-9_\-/?=&%.]*$/.test(args.path))
      throw bad('Invalid plugin navigation');
    runtime.jobs.get(message.job)?.effects.push(args);
    return null;
  }
  throw bad('Unknown plugin host operation');
}

async function publishPluginRegistry(runtime, registry) {
  const normalized = normalizeRuntimeRegistry(runtime.pkg, registry);
  await exclusive(async () => {
    const c = new Call('POST', {}, {}, null),
      index = await pluginIndex(c),
      record = index.find(r => r.id === runtime.id);
    if (!record?.enabled || record.manifest.version !== runtime.version || PLUGIN_HOSTS.get(runtime.id) !== runtime)
      throw bad('Plugin registration belongs to an inactive host');
    record.collections = ownedCatalogSections(record);
    record.contributions = normalized.contributions;
    record.events = normalized.events;
    record.runtime = {status: 'active'};
    await seedPluginNodes(c, record, {...runtime.pkg, contributions: record.contributions});
    c.ctx.set(PLUGIN_INDEX, index);
    await c.finish('plugin-registry');
    await c.ctx.commit();
  });
}

async function stopPluginRuntime(id) {
  const runtime = PLUGIN_HOSTS.get(id);
  if (!runtime) return;
  runtime.active = false;
  PLUGIN_HOSTS.delete(id);
  try {
    if (!runtime.stopped) await runtime.request('deactivate', {}, Math.min(5000, PLUGIN.endpointMs));
  } catch (error) {
    logPlugin(id, {kind: 'deactivate', error: error.message});
  } finally {
    if (!runtime.stopped) runtime.fail(new Error('Plugin disabled'));
  }
}

async function ensurePluginRuntime(id, stack = []) {
  if (stack.includes(id)) throw bad('Plugin dependency cycle: ' + [...stack, id].join(' -> '));
  if (PLUGIN_LOADING.has(id)) return PLUGIN_LOADING.get(id);
  const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(r => r.id === id);
  if (!record?.enabled) throw bad('Plugin dependency is missing or disabled: ' + id);
  const current = PLUGIN_HOSTS.get(id);
  if (current?.active && current.version === record.manifest.version) return current;
  const load = (async () => {
    await stopPluginRuntime(id);
    let pkg, runtime;
    try {
      pkg = validatePluginPackage(await DB.get(pluginKey(id, 'package')));
      const dependencies = {};
      for (const [dependency, range] of Object.entries(record.manifest.dependencies ?? {})) {
        const target = ((await DB.get(PLUGIN_INDEX)) ?? []).find(r => r.id === dependency);
        if (!target?.enabled || !pluginVersionMatches(target.manifest.version, range))
          throw bad('Unsatisfied plugin dependency: ' + dependency + ' ' + range);
        await ensurePluginRuntime(dependency, [...stack, id]);
        dependencies[dependency] = {id: dependency, version: target.manifest.version};
      }
      runtime = createPluginHost(record, pkg);
      PLUGIN_HOSTS.set(id, runtime);
      const {result: registry} = await runtime.request('activate', {
        input: {plugin: id, main: pkg.manifest.main, files: pkg.files, dependencies},
      });
      await publishPluginRegistry(runtime, registry);
      runtime.active = true;
      await runtime.request('ready');
      logPlugin(id, {kind: 'activated'});
      return runtime;
    } catch (error) {
      if (PLUGIN_HOSTS.get(id) === runtime) await stopPluginRuntime(id);
      await exclusive(async () => {
        const c = new Call('POST', {}, {}, null),
          index = await pluginIndex(c),
          failed = index.find(r => r.id === id);
        if (failed?.enabled && failed.manifest.version === record.manifest.version) {
          failed.contributions = clone(EMPTY_PLUGIN_CONTRIBUTIONS);
          failed.events = [];
          failed.runtime = {status: 'failed', error: String(error.message).slice(0, 2000)};
          c.ctx.set(PLUGIN_INDEX, index);
          await c.finish('plugin-failed');
          await c.ctx.commit();
        }
      });
      await failPluginDependents(id, error);
      logPlugin(id, {kind: 'activation_failed', error: error.message});
      throw error;
    }
  })();
  PLUGIN_LOADING.set(id, load);
  try {
    return await load;
  } finally {
    if (PLUGIN_LOADING.get(id) === load) PLUGIN_LOADING.delete(id);
  }
}

async function refreshPluginDependents(id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  const dependents = ((await DB.get(PLUGIN_INDEX)) ?? []).filter(
    record => record.enabled && Object.hasOwn(record.manifest.dependencies ?? {}, id)
  );
  for (const dependent of dependents) {
    await stopPluginRuntime(dependent.id);
    await ensurePluginRuntime(dependent.id);
    await refreshPluginDependents(dependent.id, seen);
  }
}

async function failPluginDependents(id, error, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  for (const dependent of (await DB.get(PLUGIN_INDEX)) ?? []) {
    if (!dependent.enabled || !Object.hasOwn(dependent.manifest.dependencies ?? {}, id)) continue;
    const runtime = PLUGIN_HOSTS.get(dependent.id);
    await stopPluginRuntime(dependent.id);
    await markPluginRuntimeFailed(
      dependent.id,
      dependent.manifest.version,
      runtime?.pkg ?? (await DB.get(pluginKey(dependent.id, 'package'))),
      new Error('Dependency ' + id + ' failed: ' + error.message)
    );
    await failPluginDependents(dependent.id, error, seen);
  }
}

async function startEnabledPluginRuntimes() {
  for (const record of (await DB.get(PLUGIN_INDEX)) ?? [])
    if (record.enabled)
      await ensurePluginRuntime(record.id).catch(error => console.error('Plugin ' + record.id + ':', error.message));
}

async function invokePluginHandler(record, handler, args, timeout, signal, origin) {
  const runtime = await ensurePluginRuntime(record.id);
  if (!runtime) throw bad('The plugin has no executable host');
  return runtime.request('invoke', {handler, args}, timeout, signal, origin);
}

async function assertNoPluginDependents(c, id) {
  const dependents = (await pluginIndex(c)).filter(
    r => r.enabled && r.id !== id && Object.hasOwn(r.manifest.dependencies ?? {}, id)
  );
  if (dependents.length)
    throw bad('Disable dependent plugins first: ' + dependents.map(r => r.manifest.name).join(', '));
}

async function checkRuntimeDependencies(c, candidate) {
  const records = (await pluginIndex(c)).filter(r => r.id !== candidate.id).concat(candidate);
  const visit = (record, stack = []) => {
    if (stack.includes(record.id)) throw bad('Plugin dependency cycle: ' + [...stack, record.id].join(' -> '));
    for (const [id, range] of Object.entries(record.manifest.dependencies ?? {})) {
      const target = records.find(r => r.id === id);
      if (record.enabled && (!target?.enabled || !pluginVersionMatches(target.manifest.version, range)))
        throw bad('Unsatisfied plugin dependency: ' + id + ' ' + range);
      if (target) visit(target, [...stack, record.id]);
    }
  };
  for (const record of records) visit(record);
}

async function markPluginRuntimeFailed(id, version, pkg, error) {
  await exclusive(async () => {
    const c = new Call('POST', {}, {}, null),
      index = await pluginIndex(c),
      record = index.find(r => r.id === id);
    if (!record?.enabled || record.manifest.version !== version || PLUGIN_HOSTS.has(id)) return;
    record.contributions = clone(EMPTY_PLUGIN_CONTRIBUTIONS);
    record.events = [];
    record.runtime = {status: 'failed', error: String(error.message).slice(0, 2000)};
    c.ctx.set(PLUGIN_INDEX, index);
    await c.finish('plugin-failed');
    await c.ctx.commit();
  });
}

DB.subscribe(
  keys => {
    for (const runtime of PLUGIN_HOSTS.values()) {
      if (!runtime.active) continue;
      const notify = async () => {
        const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(r => r.id === runtime.id);
        if (!record?.enabled) return;
        for (const event of record.events ?? []) {
          let visible = [];
          if (event.event === 'settings.changed') visible = keys.filter(k => k === pluginKey(record.id, 'settings'));
          if (event.event === 'storage.changed') visible = keys.filter(k => k === pluginKey(record.id, 'data'));
          if (
            event.event === 'workspace.changed' &&
            allows(record.grants, 'graph.read') &&
            allows(pluginCapabilities(record), 'graph.read')
          )
            visible = keys.filter(k => k === 'projects' || k.startsWith('wf:'));
          if (
            event.event === 'library.changed' &&
            allows(record.grants, 'library.read') &&
            allows(pluginCapabilities(record), 'library.read')
          )
            visible = keys.filter(k => k === 'resources' || k.startsWith('library/sections/'));
          if (visible.length)
            await runtime
              .request('invoke', {handler: event.handler, args: [{keys: visible}]})
              .catch(error => logPlugin(record.id, {kind: 'event', error: error.message}));
        }
      };
      notify().catch(error => logPlugin(runtime.id, {kind: 'event', error: error.message}));
    }
  },
  {commits: true}
);
