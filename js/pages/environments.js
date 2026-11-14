// Environments: the servers this client can use, their connection state, and the page where one is added,
// tested, edited or removed. There is exactly one active environment; projects and workflows are never merged.
'use strict';

const environmentStatusText = state => {
  const labels = {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Disconnected',
    unauthorized: 'Unauthorized',
    incompatible: 'Incompatible version',
    error: 'Connection error',
  };
  return labels[state.status] || state.status;
};

const environmentStatusBadge = (state, envId) => {
  const own = envId === state.environment?.id;
  const status = own ? state.status : 'disconnected';
  return `<span class="environment-status"><span class="env-dot" data-status="${esc(status)}" aria-hidden="true"></span>${
    own ? esc(environmentStatusText(state)) : 'Not connected'
  }</span>`;
};

function environmentForm(env = {}) {
  const token = env.id ? Environment.tokenOf(env.id) : '';
  return `<form id="environment-form" class="stack">
    ${field('Name', `<input name="name" required maxlength="80" value="${esc(env.name || '')}" placeholder="Home server" autocomplete="off">`)}
    ${field('Server address', `<input name="url" required inputmode="url" value="${esc(env.url || displayServerURL())}" placeholder="https://agentsys.example.com" autocomplete="url"><span class="field-help">The base URL of an AgentSys Server. No path, no trailing slash needed.</span>`)}
    ${field('Token', `<input name="token" type="password" value="${esc(token)}" autocomplete="off" spellcheck="false" placeholder="${env.id ? 'Leave empty to keep the saved token' : 'Only if the server requires one'}"><span class="field-help">Kept for this browser tab only. It is exchanged for an HttpOnly session cookie.</span>`)}
    <p class="form-error" data-form-error hidden></p>
    <div class="button-row"><button type="submit" class="primary">${env.id ? 'Save changes' : 'Add environment'}</button><button type="button" data-test>Test connection</button></div>
  </form>`;
}

const displayServerURL = () =>
  globalThis.AGENTSYS_DEFAULT_SERVER || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8080');

function showEnvironmentDialog(env, onDone) {
  const editing = !!env;
  dialog(editing ? 'Edit environment' : 'Add environment', environmentForm(env || {}), async form => {
    const value = {
      ...(env || {}),
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      token: form.elements.token.value,
    };
    try {
      const saved = Environment.save(value);
      toast(editing ? 'Environment saved.' : 'Environment added.');
      onDone?.(saved);
    } catch (error) {
      const output = $('[data-form-error]', form);
      if (output) {
        output.hidden = false;
        output.textContent = error.message;
      }
      return false;
    }
  }, editing ? 'Save' : 'Add');
}

/** Probe without switching; the answer is shown in the page and in a toast. */
async function testEnvironment(env, output) {
  const set = (text, bad = false) => {
    if (output) {
      output.hidden = false;
      output.className = bad ? 'form-error' : 'muted';
      output.textContent = text;
    }
    toast(text, bad);
  };
  try {
    const meta = await Environment.probe(env);
    set(`Connected to ${meta.server_name || env.url} · AgentSys ${meta.version || '?'} · protocol ${meta.protocol}.`);
  } catch (error) {
    set(error.message, true);
  }
}

PAGES.environments = async (view, route) => {
  const state = Environment.status();
  const list = Environment.list();
  const meta = state.meta;
  view.innerHTML = `<div class="page environments-page">
    ${pageHead({
      title: 'Environments',
      sub: 'Each environment is one AgentSys Server with its own projects, Library, runtime and secrets.',
      menu: '',
      actions: `<button type="button" class="primary" data-env-add>${icon('plus')}<span>Add environment</span></button>`,
    })}
    ${
      state.status !== 'connected'
        ? `<div class="callout" data-tone="${state.status === 'unauthorized' ? 'warning' : 'error'}"><p><strong>${esc(
            environmentStatusText(state)
          )}</strong>${state.detail ? ` · ${esc(state.detail)}` : ''}</p><p class="muted">Choose another environment below, add one, or reconnect.</p></div>`
        : `<p class="muted">Connected to <strong>${esc(state.environment?.name || '')}</strong> at <code>${esc(
            state.environment?.url || ''
          )}</code> · AgentSys ${esc(meta?.version || '?')} · protocol ${esc(String(meta?.protocol || '?'))} · uptime ${esc(
            meta?.uptime_seconds != null ? Math.round(meta.uptime_seconds) + ' s' : 'unknown'
          )}.</p>`
    }
    <section>
      <div class="section-head"><h2>Servers</h2><span class="muted small">One active connection</span></div>
      <div class="environment-list">${list
        .map(
          env => `<article class="environment-row ${env.active ? 'active' : ''}" data-env-row="${esc(env.id)}">
            <div><h3>${esc(env.name)} ${env.active ? '<span class="badge" data-tone="info">Active</span>' : ''}</h3><p class="muted small"><code>${esc(env.url)}</code></p></div>
            <div class="button-row">
              ${environmentStatusBadge(state, env.id)}
              ${env.active ? '<button type="button" data-env-reconnect>Reconnect</button>' : `<button type="button" class="${state.status === 'connected' ? '' : 'primary'}" data-env-use>Use</button>`}
              <button type="button" data-env-test>Test</button>
              <button type="button" class="icon" data-env-edit title="Edit environment" aria-label="Edit environment">${icon('settings')}</button>
              ${list.length > 1 ? `<button type="button" class="icon danger" data-env-remove title="Remove environment" aria-label="Remove environment">${icon('x')}</button>` : ''}
            </div>
          </article>`
        )
        .join('')}</div>
    </section>
    <section>
      <h2>This client</h2>
      <p class="muted">Interface preferences, installed client plugins and the environment list are kept in this browser. Projects, Library nodes and runtime state stay on the active server.</p>
      <div class="button-row">
        <button type="button" data-env-import-state>Import old interface state from this server</button>
        ${Environment.tokenOf(state.environment?.id || '') ? '<button type="button" data-env-sign-out>Forget token for this tab</button>' : ''}
      </div>
      <p class="muted small" data-env-client-result></p>
    </section>
    <section>
      <h2>About environments</h2>
      <p class="muted">Projects, Library nodes, workflows, runtime state and secrets belong to the server. This client stores only the server list, the layout of its interface and the plugins you install here. Switching servers reloads the interface from the new server; it does not move workflows between them.</p>
      <p class="muted">For a remote server, use HTTPS (directly or through a reverse proxy) and a token. Tokens are transmitted in the <code>Authorization</code> header or exchanged once for a session cookie; they never appear in the address bar.</p>
    </section>
    <p class="form-error" data-env-output hidden></p>
  </div>`;

  const output = $('[data-env-output]', view);
  const clientResult = $('[data-env-client-result]', view);
  $('[data-env-import-state]', view)?.addEventListener('click', async () => {
    try {
      const values = await api('migration/ui-state');
      const entries = Object.entries(values || {}).filter(
        ([key]) => /^(?:agentsys-|fieldHeights:)/.test(key)
      );
      for (const [key, value] of entries) await store.set(key, value);
      clientResult.textContent = entries.length
        ? `Imported ${entries.length} interface preference(s) into this browser.`
        : 'This server has no old interface state to import.';
      if (entries.length) toast('Interface state imported. The server copy is unchanged.');
    } catch (error) {
      fail(error);
    }
  });
  $('[data-env-sign-out]', view)?.addEventListener('click', async () => {
    await Environment.signOut();
    await go('/environments', true);
  });
  $('[data-env-add]', view).onclick = () => showEnvironmentDialog(null, () => go('/environments', true).catch(fail));
  for (const row of $$('[data-env-row]', view)) {
    const id = row.dataset.envRow;
    const env = Environment.get(id);
    $('[data-env-use]', row)?.addEventListener('click', () => chooseEnvironment(id).catch(fail));
    $('[data-env-reconnect]', row)?.addEventListener('click', () =>
      Environment.reconnect()
        .then(ok => {
          if (ok) go('/environments', true);
          else {
            output.hidden = false;
            output.className = 'form-error';
            output.textContent = stateMessage(Environment.status());
          }
        })
        .catch(fail)
    );
    $('[data-env-test]', row)?.addEventListener('click', () => testEnvironment(env, output));
    $('[data-env-edit]', row)?.addEventListener('click', () =>
      showEnvironmentDialog(env, () => go('/environments', true).catch(fail))
    );
    $('[data-env-remove]', row)?.addEventListener('click', () => {
      confirmDialog(
        'Remove environment?',
        `Remove the saved connection "${env.name}"? The server and its data are not touched.`,
        async () => {
          try {
            Environment.remove(id);
            if (Environment.active()?.id === id) await Environment.setActive(Environment.list()[0]?.id).catch(() => {});
            await go('/environments', true);
          } catch (error) {
            fail(error);
          }
        },
        'Remove'
      );
    });
  }
};

// The dialog's Test button works on the values currently typed, before they are saved.
document.addEventListener('click', event => {
  const button = event.target.closest('#modal [data-test]');
  if (!button) return;
  event.preventDefault();
  const form = button.closest('#environment-form');
  const output = $('[data-form-error]', form);
  Environment.probeDraft({
    name: form.elements.name.value || 'Server',
    url: form.elements.url.value,
    token: form.elements.token.value,
  })
    .then(meta => {
      output.hidden = false;
      output.className = 'muted';
      output.textContent = `Connected to ${meta.server_name || form.elements.url.value} · AgentSys ${meta.version || '?'} · protocol ${meta.protocol}.`;
    })
    .catch(error => {
      output.hidden = false;
      output.className = 'form-error';
      output.textContent = error.message;
    });
});
