// Environments: the AgentSys servers this client can be connected to, the one active now, and the single API
// transport every request and event subscription goes through. Nothing here assumes that a server is local:
// an environment is only a base URL and, when the server asks for one, a token held in session storage.
'use strict';

const Environment = (() => {
  const LIST_KEY = 'agentsys-environments';
  const ACTIVE_KEY = 'agentsys-active-environment';
  const TOKEN_PREFIX = 'agentsys-token:';
  const PROTOCOL = globalThis.AgentSysProtocol;
  const STATUS = new Set(['connected', 'connecting', 'disconnected', 'unauthorized', 'incompatible', 'error']);
  const MAX_TOKEN_LENGTH = 4096;
  const listeners = new Set();
  const hookListeners = new Set();
  const statusListeners = new Set();
  const beforeSwitch = [];
  const afterSwitch = [];
  let environments = loadList();
  let activeId = loadActiveId();
  let active = null;
  let status = 'disconnected';
  let statusDetail = '';
  let meta = null;
  let generation = 0;
  let controller = null; // abort signal of the current environment: a switch cancels its in-flight requests
  let stream = null; // AbortController of the event stream
  let streamTask = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let started = false;
  let switching = 0; // a setActive() is between its start and its answer

  /** Starts a new environment generation: older answers are rejected, their requests and the event stream are aborted. */
  function beginGeneration() {
    generation++;
    controller?.abort();
    controller = new AbortController();
    closeStream();
    return controller.signal;
  }

  const normalizeURL = value => {
    const text = String(value || '').trim();
    if (!text) throw new ApiError('invalid_request', 'A server address is required', 400);
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new ApiError('invalid_request', 'The server address must be an absolute http(s) URL', 400);
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new ApiError('invalid_request', 'Use an http:// or https:// address', 400);
    if (url.username || url.password) throw new ApiError('invalid_request', 'Put credentials in the token field', 400);
    url.username = url.password = '';
    url.search = url.hash = '';
    return url.toString().replace(/\/+$/, '');
  };
  const defaultURL = () => {
    if (typeof globalThis.AGENTSYS_DEFAULT_SERVER === 'string' && globalThis.AGENTSYS_DEFAULT_SERVER)
      return normalizeURL(globalThis.AGENTSYS_DEFAULT_SERVER);
    if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
      return normalizeURL(location.origin);
    return 'http://127.0.0.1:8080';
  };
  function loadList() {
    try {
      const value = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value
        .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.url === 'string')
        .map(item => ({id: item.id, name: item.name, url: item.url}));
    } catch {
      return [];
    }
  }
  function loadActiveId() {
    try {
      return localStorage.getItem(ACTIVE_KEY) || '';
    } catch {
      return '';
    }
  }
  const ensureDefaults = () => {
    if (!environments.length) {
      environments.push({id: 'local', name: 'Local server', url: defaultURL()});
      persistList();
      if (!activeId) activeId = 'local';
    }
    if (!environments.some(env => env.id === activeId)) activeId = environments[0].id;
    active = environments.find(env => env.id === activeId) || environments[0];
    return active;
  };
  const persistList = () => {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(environments));
    } catch {}
  };
  const persistActive = () => {
    try {
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {}
  };
  const tokenKey = id => TOKEN_PREFIX + id;
  /** A token lives only for this browser tab: it is never written to localStorage. */
  const tokenOf = id => {
    try {
      return sessionStorage.getItem(tokenKey(id)) || '';
    } catch {
      return '';
    }
  };
  const setToken = (id, token) => {
    try {
      if (token) sessionStorage.setItem(tokenKey(id), String(token).slice(0, MAX_TOKEN_LENGTH));
      else sessionStorage.removeItem(tokenKey(id));
    } catch {}
  };
  const setStatus = (next, detail = '') => {
    if (!STATUS.has(next)) next = 'error';
    if (status === next && statusDetail === detail) return;
    status = next;
    statusDetail = detail;
    for (const listener of statusListeners) {
      try {
        listener({status, detail, environment: active, meta});
      } catch {}
    }
  };
  const emitChange = (keys, by) => {
    for (const listener of listeners) {
      try {
        listener(keys, {by, generation});
      } catch {}
    }
  };
  const emitHook = entry => {
    for (const listener of hookListeners) {
      try {
        listener(entry);
      } catch {}
    }
  };
  const apiURL = (env, path, query) => {
    const clean = String(path).replace(/^\/+/, '').replace(/^api\//, '');
    const url = new URL(env.url + '/api/' + clean);
    for (const [key, value] of Object.entries(query || {}))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  };
  const signalWithTimeout = (signal, ms) => {
    const timeout = AbortSignal.timeout(ms);
    const signals = [...(Array.isArray(signal) ? signal : [signal]), timeout].filter(Boolean);
    if (signals.length === 1) return signals[0];
    return typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
  };
  const authHeaders = env => {
    const token = tokenOf(env.id);
    return token ? {Authorization: 'Bearer ' + token} : {};
  };

  /** One transport for every API call. Network failures and mutations are never retried: a repeated Run may
   * have side effects. A clean 401 is different: the server rejected the request before running it, so after
   * renewing the session the same call may be sent once. */
  async function request(method, path, {body, query, edit, signal, env} = {}) {
    return requestOnce(method, path, {body, query, edit, signal, env}, true);
  }
  async function requestOnce(method, path, {body, query, edit, signal, env: target}, mayRenew) {
    const env = target || active || ensureDefaults();
    // A server that speaks another protocol is not asked: its answers would be read as this protocol's.
    if (status === 'incompatible')
      throw new ApiError('incompatible_protocol', statusDetail || 'The server speaks another AgentSys protocol', 409);
    const cleanPath = String(path).replace(/^\/+/, '').replace(/^api\//, '');
    if (!cleanPath || cleanPath.split('/').some(part => part === '.' || part === '..') || /[?#]/.test(cleanPath))
      throw new ApiError('invalid_request', 'Invalid API path', 400);
    path = cleanPath;
    const gen = generation;
    const gate = controller?.signal;
    const timeout = method === 'GET' ? 30000 : 120000;
    const headers = {'X-AgentSys': '1', ...authHeaders(env)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (edit) headers['X-Edit'] = edit;
    let response;
    try {
      response = await fetch(apiURL(env, path, query), {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        signal: signalWithTimeout([gate, signal], timeout),
        ...(body === undefined || method === 'GET' || method === 'DELETE' ? {} : {body: JSON.stringify(body)}),
      });
    } catch (error) {
      if (gen !== generation) throw new ApiError('stale_environment', 'The environment changed', 409);
      if (error?.name === 'AbortError') throw error;
      setStatus('disconnected', 'The server could not be reached.');
      throw new ApiError('network_error', 'The server could not be reached: ' + (error?.message || 'network error'), 503);
    }
    if (gen !== generation) throw new ApiError('stale_environment', 'The environment changed', 409);
    if (response.status === 401) {
      // A restarted server forgets in-memory sessions; the token for this tab can make a new one.
      if (mayRenew && tokenOf(env.id) && !/^auth\//.test(String(path).replace(/^\/+/, ''))) {
        try {
          await startSession(env, gate);
          if (gen === generation) return requestOnce(method, path, {body, query, edit, signal}, false);
        } catch {}
      }
      setStatus('unauthorized', 'The server asked for a token.');
      throw new ApiError('unauthorized', 'The server rejected this client. Add its token in Environments.', 401);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError('invalid_response', 'The server answered with something that is not JSON', 502);
    }
    if (!response.ok) {
      const error = result?.error;
      throw new ApiError(
        error?.code || 'request_failed',
        error?.message || (typeof result?.error === 'string' ? result.error : 'The request failed'),
        response.status
      );
    }
    return result;
  }

  /** Probes a server without changing the active environment. */
  async function probe(env, gate) {
    const url = new URL(env.url + PROTOCOL.META_PATH);
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      signal: signalWithTimeout(gate, 8000),
      headers: authHeaders(env),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError('invalid_response', 'The address answered, but it is not an AgentSys server.', 502);
    }
    if (!response.ok)
      throw new ApiError(
        value?.error?.code || 'probe_failed',
        value?.error?.message || `The server answered ${response.status}`,
        response.status
      );
    if (!value.agentsys || value.product !== PROTOCOL.PRODUCT)
      throw new ApiError('invalid_response', 'That address is not an AgentSys server.', 502);
    if (!PROTOCOL.compatible(value.protocol))
      throw new ApiError('incompatible_protocol', PROTOCOL.incompatibility(value.protocol), 409);
    return value;
  }

  /** Exchanges the optional typed token for a short-lived HttpOnly session cookie. */
  async function startSession(env, gate) {
    const token = tokenOf(env.id);
    if (!token) return {mode: meta?.auth || 'none'};
    const response = await fetch(new URL(env.url + PROTOCOL.SESSION_PATH), {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json', 'X-AgentSys': '1'},
      body: JSON.stringify({token}),
      signal: signalWithTimeout(gate, 15000),
    });
    if (response.status === 404) return {mode: 'bearer'}; // an older server: keep using the header
    if (!response.ok)
      throw new ApiError('unauthorized', 'The server rejected the token.', response.status === 401 ? 401 : 502);
    return response.json().catch(() => ({mode: 'cookie'}));
  }

  function closeStream() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stream?.abort();
    stream = null;
    streamTask = null;
  }

  /** Reads the server's Server-Sent Events through fetch so the same auth headers apply. Reconnects with backoff. */
  function openStream() {
    closeStream();
    const env = active;
    const gen = generation;
    const ctrl = new AbortController();
    stream = ctrl;
    const task = (async () => {
      let response;
      try {
        response = await fetch(new URL(env.url + PROTOCOL.EVENTS_PATH), {
          headers: {...authHeaders(env), Accept: 'text/event-stream'},
          credentials: 'include',
          cache: 'no-store',
          signal: ctrl.signal,
        });
      } catch (error) {
        if (gen === generation) scheduleReconnect(gen, error?.message);
        return;
      }
      if (gen !== generation) return;
      if (response.status === 401) {
        // Sessions live in the server's memory: after a restart, renew once from this tab's token.
        if (tokenOf(env.id)) {
          try {
            await startSession(env);
            if (gen === generation) setTimeout(() => gen === generation && openStream(), 0);
            return;
          } catch {}
        }
        setStatus('unauthorized', 'The server asked for a token.');
        return;
      }
      if (!response.ok || !response.body) {
        scheduleReconnect(gen, 'The event stream is unavailable.');
        return;
      }
      reconnectAttempt = 0;
      if (status !== 'connected') setStatus('connected');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const packet = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = packet
              .split('\n')
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trim())
              .join('\n');
            if (!data) continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (gen !== generation) return;
            if (event.type === 'hook') emitHook(event.entry);
            else if (event.type === 'change') emitChange(event.keys || [], event.by);
            else if (event.type === 'ready') {
              /* the stream is established */
            }
          }
        }
      } catch (error) {
        if (gen === generation && error?.name !== 'AbortError') scheduleReconnect(gen, error?.message);
      }
      if (gen === generation && !ctrl.signal.aborted) scheduleReconnect(gen, 'The event stream closed.');
    })();
    streamTask = task;
  }

  function scheduleReconnect(gen, detail) {
    if (gen !== generation || reconnectTimer) return;
    if (status === 'connected') setStatus('disconnected', detail || 'The event stream closed.');
    const delay = Math.min(15000, 500 * 2 ** Math.min(6, reconnectAttempt++));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (gen !== generation || !active) return;
      // A reconnect is a fresh read, never a replayed mutation.
      openStream();
    }, delay);
  }

  async function connect(env = active) {
    if (!env) env = ensureDefaults();
    active = env;
    // A connection attempt is a new generation: answers of the old environment (and its event stream) are void.
    const gate = beginGeneration();
    const gen = generation;
    setStatus('connecting');
    meta = null;
    // A newer attempt owns the state: an older one returns without touching status or meta.
    const current = () => gen === generation;
    try {
      const probed = await probe(env, gate);
      if (!current()) return false;
      meta = probed;
      await startSession(env, gate);
      if (!current()) return false;
      // A protected read proves the session (or the loopback trust) is good before the stream opens.
      await request('GET', 'session', {env});
      if (!current()) return false;
      if (status === 'unauthorized') return false;
      openStream();
      if (!current()) return false;
      setStatus('connected');
      if (!started) started = true;
      return true;
    } catch (error) {
      if (!current() || error?.code === 'stale_environment') return false;
      if (error?.code === 'incompatible_protocol') setStatus('incompatible', error.message);
      else if (error?.code === 'unauthorized') setStatus('unauthorized', error.message);
      else setStatus('disconnected', error?.message || 'The server could not be reached.');
      return false;
    }
  }

  const runHooks = async list => {
    for (const hook of list) {
      try {
        await hook();
      } catch (error) {
        console.error('Environment hook failed:', error);
      }
    }
  };

  /** Switches servers without mixing their data: old requests are aborted and their answers discarded. */
  async function setActive(id, {reconnect = true} = {}) {
    const env = environments.find(item => item.id === id);
    if (!env) throw new ApiError('not_found', 'Environment not found', 404);
    // A switch already on its way to this environment is not a reason to skip: it has not arrived yet.
    if (!switching && active?.id === id && status === 'connected') return true;
    switching++;
    try {
      await runHooks(beforeSwitch);
      if (active?.id !== id) beginGeneration();
      active = env;
      activeId = env.id;
      persistActive();
      meta = null;
      if (!reconnect) {
        beginGeneration(); // even for the same environment: no stream and no answer may outlive a disconnect
        setStatus('disconnected');
        return false;
      }
      const ok = await connect(env);
      if (ok) await runHooks(afterSwitch);
      return ok;
    } finally {
      switching--;
    }
  }

  function validate(env) {
    const name = String(env?.name || '').trim();
    if (!name || name.length > 80) throw new ApiError('invalid_request', 'An environment needs a name of 1 to 80 characters', 400);
    return {id: env.id || 'env-' + uid().slice(0, 12), name, url: normalizeURL(env.url)};
  }

  const api = {
    /** Starts on the saved active environment (or the local default). */
    async start() {
      ensureDefaults();
      return connect(active);
    },
    list: () => environments.map(env => ({...env, active: env.id === active?.id})),
    get(id) {
      const env = environments.find(item => item.id === id);
      return env ? {...env, active: env.id === active?.id} : undefined;
    },
    active: () => (active ? {...active} : null),
    status: () => ({status, detail: statusDetail, meta, environment: active ? {...active} : null}),
    meta: () => meta,
    tokenOf,
    /** Saves (or adds) an environment; a token is kept for this tab only. */
    save(env) {
      const clean = validate(env);
      const index = environments.findIndex(item => item.id === clean.id);
      if (index >= 0) environments[index] = clean;
      else environments.push(clean);
      persistList();
      // An empty field on an existing environment means "keep the token": use Forget token to clear it.
      if (env.token) setToken(clean.id, env.token);
      return this.get(clean.id);
    },
    /** Drops the token for this tab and tells the server to end the session cookie when it can. */
    async signOut(id = active?.id) {
      if (!id) return;
      setToken(id, '');
      const url = environments.find(env => env.id === id)?.url || active?.url || '';
      try {
        await fetch(new URL(url, PROTOCOL.LOGOUT_PATH), {
          method: 'POST',
          credentials: 'include',
          headers: {'X-AgentSys': '1'},
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
      if (id === active?.id) {
        beginGeneration(); // no request or event of the signed-out session may land after this
        meta = null;
        setStatus('disconnected', 'Signed out of this server.');
      }
    },
    remove(id) {
      if (environments.length === 1)
        throw new ApiError('invalid_request', 'Keep at least one environment', 400);
      const removed = environments.find(item => item.id === id);
      if (!removed) throw new ApiError('not_found', 'Environment not found', 404);
      const wasActive = active?.id === id || activeId === id;
      environments = environments.filter(item => item.id !== id);
      setToken(id, '');
      persistList();
      if (wasActive) {
        // The removed server must not keep feeding this page: cancel its requests and stream, then reconnect.
        activeId = environments[0].id;
        persistActive();
        active = environments[0];
        beginGeneration();
        meta = null;
        setStatus('disconnected', 'The environment was removed.');
        connect(active).catch(() => {});
      }
      return this.list();
    },
    setActive,
    reconnect: () => connect(active),
    probe,
    /** Tests typed-in values without adding them to the saved list. */
    async probeDraft({name = 'Server', url, token = ''}) {
      const env = {id: 'draft-' + uid(), name, url: normalizeURL(url)};
      setToken(env.id, token);
      try {
        return await probe(env);
      } finally {
        setToken(env.id, '');
      }
    },
    request,
    /** Changes from the server: `(keys, {by, generation})`; returns the unsubscribe function. */
    subscribe(listener, _options) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeHooks(listener) {
      hookListeners.add(listener);
      return () => hookListeners.delete(listener);
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener({status, detail: statusDetail, environment: active ? {...active} : null, meta});
      return () => statusListeners.delete(listener);
    },
    /** Hooks run before and after an environment switch (flush edits, clear caches, redraw). */
    onBeforeSwitch(hook) {
      beforeSwitch.push(hook);
      return () => beforeSwitch.splice(beforeSwitch.indexOf(hook), 1);
    },
    onAfterSwitch(hook) {
      afterSwitch.push(hook);
      return () => afterSwitch.splice(afterSwitch.indexOf(hook), 1);
    },
    /** Incremented on every switch; late answers carry an older value and are ignored by callers that check it. */
    generation: () => generation,
    apiURL: path => apiURL(active || ensureDefaults(), path),
    defaultURL,
    normalizeURL,
  };
  return api;
})();
