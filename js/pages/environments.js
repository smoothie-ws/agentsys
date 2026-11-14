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
    <div class="button-row"><button type="submit" class="primary">${env.id ? 'Save changes' : 'Add server'}</button><button type="button" data-test>Test connection</button></div>
  </form>`;
}

const displayServerURL = () => Environment.defaultURL();

function showEnvironmentDialog(env, onDone) {
  const editing = !!env;
  dialog(editing ? 'Edit server' : 'Add server', environmentForm(env || {}), async form => {
    const value = {
      ...(env || {}),
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      token: form.elements.token.value,
    };
    try {
      const saved = Environment.save(value);
      toast(editing ? 'Server saved.' : 'Server added.');
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

/** Actions of the Server section, shared by its sidebar row and its page heading. */
function environmentSectionActions() {
  return [
    ['Add server', () => showEnvironmentDialog(null, () => go('/environments', true).catch(fail)), {icon: 'plus'}],
    null,
    [
      'Reconnect',
      () =>
        Environment.reconnect()
          .then(ok => {
            if (!ok) toast(stateMessage(Environment.status()), true);
          })
          .catch(fail),
      {icon: 'refresh'},
    ],
  ];
}

/** Actions of one server card, opened from its three dots or a right-click on the card. */
function environmentActions(id) {
  const env = Environment.get(id);
  if (!env) return [];
  const active = env.id === Environment.active()?.id;
  return [
    active
      ? [
          'Reconnect',
          () =>
            Environment.reconnect()
              .then(ok => {
                if (!ok) toast(stateMessage(Environment.status()), true);
              })
              .catch(fail),
          {icon: 'refresh'},
        ]
      : ['Use this server', () => chooseEnvironment(env.id).catch(fail), {icon: 'power'}],
    ['Test connection', () => testEnvironment(env, $('[data-env-output]')), {icon: 'activity'}],
    null,
    ['Edit server…', () => showEnvironmentDialog(env, () => go('/environments', true).catch(fail)), {icon: 'settings'}],
    ...(active && Environment.tokenOf(env.id)
      ? [
          [
            'Forget token for this tab',
            async () => {
              await Environment.signOut();
              await go('/environments', true);
            },
            {icon: 'key'},
          ],
        ]
      : []),
    [
      'Remove server…',
      () =>
        confirmDialog(
          'Remove server?',
          `Remove the saved connection “${env.name}”? The server and its data are not touched.`,
          async () => {
            try {
              Environment.remove(env.id);
              if (Environment.active()?.id === env.id)
                await Environment.setActive(Environment.list()[0]?.id).catch(() => {});
              await go('/environments', true);
            } catch (error) {
              fail(error);
            }
          },
          'Remove'
        ),
      {icon: 'trash', danger: true, disabled: Environment.list().length <= 1},
    ],
  ];
}

PAGES.environments = async view => {
  const state = Environment.status();
  const list = Environment.list();
  const meta = state.meta;
  view.innerHTML = `<div class="page environments-page">
    ${pageHead({title: 'Servers'})}
    <div class="cards">${list
      .map(env =>
        card({
          glyph: 'server',
          title: env.name,
          extra: `data-env-row="${esc(env.id)}"`,
          preview: `<div class="environment-card-status">${environmentStatusBadge(state, env.id)}${
            env.active ? '<span class="badge" data-tone="info">Active</span>' : ''
          }</div><code class="environment-card-url">${esc(env.url)}</code>`,
          previewClass: 'card-note environment-card',
          facts: env.active
            ? `AgentSys ${esc(meta?.version || '?')} · protocol ${esc(String(meta?.protocol || '?'))}`
            : 'Saved in this browser',
          menu: 'environment:' + env.id,
        })
      )
      .join('')}</div>
  </div>`;
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
