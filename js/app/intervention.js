'use strict';

function mountRunIntervention(container, detail, onChange) {
  const invocations = (detail.invocations ?? []).filter(i => i.schema);
  const active = ['running', 'waiting', 'interrupted'].includes(detail.status);
  container.innerHTML = `<p data-intervention-error class="warn" hidden></p>
    ${(detail.waits ?? []).length ? '<p class="muted">Resuming restarts the waiting script from its beginning. External actions before the wait may run again; use idempotency keys for those actions.</p>' : ''}
    ${(detail.waits ?? []).map(wait => `<form data-wait-key="${esc(wait.key)}"><h3>${wait.wait_spec.event ? 'Send event: ' + esc(wait.wait_spec.event) : 'Resume wait'}</h3><p>${esc(invocations.find(i => i.invocation === wait.key)?.label || wait.node_id)}</p><label>Payload (JSON)<textarea name="payload" rows="4" required>${esc(pretty(wait.wait_spec.match ?? {}))}</textarea></label><button type="submit">${wait.wait_spec.event ? 'Send event' : 'Resume wait'}</button></form>`).join('')}
    ${detail.recovery_available && invocations.length ? `<form data-output-replacement><h3>Replace output and restart</h3><label>Invocation<select name="invocation">${invocations.map((entry, i) => `<option value="${esc(entry.invocation)}">${esc(entry.label || entry.node_id)} · ${i + 1} · ${esc(entry.status)}</option>`).join('')}</select></label><p data-invocation-path class="muted"></p><label>Output values (JSON)<textarea name="output" rows="5" required></textarea></label><fieldset><legend>Signal outputs to fire</legend><div data-output-signals></div></fieldset><p>Dependent work runs again. Completed independent calls are kept.${detail.status === 'running' ? ' This stops the running activation.' : ''}</p><button type="submit">Replace output and restart</button></form>` : ''}
    ${
      active && Object.keys(detail.waves ?? {}).length
        ? `<h3>Waves</h3><div data-waves>${Object.entries(detail.waves)
            .map(
              ([path, wave], i) =>
                `<div class="button-row"><span title="${esc(path)}">${path === 'run' ? 'Activation' : 'Wave ' + i}${wave.cancelled ? ' · cancelled' : ''}</span><button type="button" data-cancel-wave="${esc(path)}" ${wave.cancelled || wave.active === false ? 'disabled' : ''}>Cancel wave</button></div>`
            )
            .join('')}</div>`
        : ''
    }`;
  const perform = async (button, action) => {
    button.disabled = true;
    const error = $('[data-intervention-error]', container);
    error.hidden = true;
    try {
      const result = await action();
      await onChange(result?.id ?? detail.id);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
  for (const form of $$('[data-wait-key]', container))
    form.onsubmit = event => {
      event.preventDefault();
      perform($('button', form), async () => {
        const payload = JSON.parse(form.elements.payload.value);
        const wait = detail.waits.find(w => w.key === form.dataset.waitKey);
        return wait.wait_spec.event
          ? api('events/' + encodeURIComponent(wait.wait_spec.event), {
              method: 'POST',
              body: payload,
              query: {run_id: detail.id, key: wait.key},
            })
          : api(`runs/${detail.id}/resume`, {method: 'POST', body: {key: wait.key, value: payload}});
      });
    };
  const form = $('[data-output-replacement]', container);
  if (form) {
    const select = form.elements.invocation;
    select.onchange = () => {
      const entry = invocations.find(i => i.invocation === select.value);
      $('[data-invocation-path]', form).textContent = entry.invocation;
      form.elements.output.value = pretty(
        entry.output_value ?? Object.fromEntries(entry.schema.map(p => [p.name, null]))
      );
      const emitted = (entry.emissions ?? []).map(e => e.name);
      const choices = [...emitted, ...(entry.signals ?? []).filter(name => !emitted.includes(name))];
      $('[data-output-signals]', form).innerHTML = choices.length
        ? choices
            .map(
              (name, i) =>
                `<label class="check"><input type="checkbox" name="signal" value="${esc(name)}" ${i < emitted.length ? 'checked' : ''}>${esc(name)}${emitted.filter(n => n === name).length > 1 ? ' · ' + (i + 1) : ''}</label>`
            )
            .join('')
        : '<p class="muted">No signal outputs.</p>';
    };
    select.onchange();
    form.onsubmit = event => {
      event.preventDefault();
      perform($('button[type=submit]', form), () =>
        api(`runs/${detail.id}/output`, {
          method: 'POST',
          body: {
            invocation: select.value,
            output: JSON.parse(form.elements.output.value),
            signals: $$('input[name=signal]:checked', form).map(input => input.value),
          },
        })
      );
    };
  }
  for (const button of $$('[data-cancel-wave]', container))
    button.onclick = () =>
      perform(button, () =>
        api(`runs/${detail.id}/waves/cancel`, {method: 'POST', body: {path: button.dataset.cancelWave}})
      );
}

async function showRunIntervention(id) {
  const detail = await api('runs/' + id),
    modal = document.createElement('dialog');
  modal.className = 'run-intervention';
  modal.innerHTML =
    '<div class="button-row"><h2>Run intervention</h2><button type="button" data-close>Close</button></div><div data-intervention-panel></div>';
  document.body.append(modal);
  $('[data-close]', modal).onclick = () => modal.close();
  modal.onclose = () => modal.remove();
  const changed = async nextId => {
    const next = await api('runs/' + nextId);
    if (modal.isConnected) mountRunIntervention($('[data-intervention-panel]', modal), next, changed);
    if (typeof W !== 'undefined' && W.workflow === next.workflow_id) {
      W.followedRunId = nextId;
      await reload();
      syncToolbar();
    }
  };
  mountRunIntervention($('[data-intervention-panel]', modal), detail, changed);
  modal.showModal();
}
