// Pages: project settings and application settings.
'use strict';

// ----- project settings -----
PAGES['project-settings'] = async (view, route) => {
  const {project} = await api(`projects/${route.project}`);
  if (app.route !== route) return;
  view.innerHTML = `<form class="page form-page" id="project-form">${pageHead({
    crumbs: [
      ['Projects', '/projects'],
      [project.name, `/p/${project.id}`],
    ],
    title: 'Project settings',
    actions: '<span id="save-slot"></span>',
  })}
    <section><h2>General</h2>${field('Name', `<input name="name" required maxlength="100" value="${esc(project.name)}">`)}
      ${field('Description', `<textarea name="description" rows="4" maxlength="2000" placeholder="What is this project for?">${esc(project.description)}</textarea>`)}</section>
    <p class="form-error" hidden></p></form>`;
  const form = $('#project-form');
  pageAutosave(
    form,
    () => ({name: form.name.value.trim(), description: form.description.value}),
    async body => {
      await api(`projects/${project.id}`, {method: 'PUT', body});
      await loadProjects();
    }
  );
};

// ----- application settings -----
const PALETTE = ['background', 'surface', 'text', 'accent'];
/** The built-in theme whose four colours these are ('' for a custom palette). */
const themeOf = style => Object.keys(THEMES).find(name => PALETTE.every(k => THEMES[name][k] === style[k])) ?? '';
const graphNumber = (name, style) => {
  const [min, max] = GRAPH_RANGES[name];
  return `<input name="${name}" type="number" min="${min}" max="${max}" value="${style[name]}">`;
};
PAGES.settings = async (view, route) => {
  const {preferences} = await loadLibrary();
  if (app.route !== route) return;
  const style = {...STYLE_DEFAULTS, ...preferences.style};
  view.innerHTML = `<form class="page form-page" id="settings-form">${pageHead({title: 'Settings', actions: '<span id="save-slot"></span>'})}
    <section><h2>Editing</h2>${field('Undo steps per workflow', `<input name="undo_steps" type="number" min="0" max="500" value="${esc(preferences.undo_steps ?? 50)}">`)}
      <label class="check"><input type="checkbox" name="developer_mode" ${preferences.developer_mode ? 'checked' : ''}> Developer mode</label></section>
    <section class="appearance-section"><h2>Appearance</h2>
      <div class="settings-group"><h3>Theme</h3><p class="muted">Pick a built-in theme, or set the four colours below yourself.</p>
        <select name="theme" aria-label="Theme"><option value="">Custom</option>${options(
          Object.keys(THEMES).map(name => [name, name]),
          themeOf(style)
        )}</select></div>
      <div class="settings-group"><h3>Colours</h3><p class="muted">The four colours every other colour is made from.</p>
        <div class="colour-fields">${PALETTE.map(k => `<label class="colour-field"><input type="color" name="${k}" value="${esc(style[k])}" aria-label="${k}"><span>${k[0].toUpperCase() + k.slice(1)}</span></label>`).join('')}</div></div>
      <div class="settings-group"><h3>Text</h3>
        <div class="settings-grid">${field('Text size', `<input name="font_size" type="number" min="12" max="22" value="${style.font_size}">`)}
        ${field('Font', `<select name="font_family">${options([['system', 'System'], ...['Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Courier New'].map(f => [f, f])], style.font_family)}</select>`)}</div></div>
      <div class="settings-group"><h3>Interface</h3>
        <label class="toggle-row"><input type="checkbox" name="animations" ${style.animations ? 'checked' : ''}><span><strong>Animations</strong><small class="muted">Panels, pills and menus move instead of jumping.</small></span></label>
        <label class="toggle-row"><input type="checkbox" name="effects" ${style.effects ? 'checked' : ''}><span><strong>Effects</strong><small class="muted">Blur, glow and connected panels.</small></span></label></div>
      <div class="settings-group"><h3>Graph editor</h3>
        <div class="settings-grid">${field('Wire style', `<select name="wire_style">${options(WIRE_STYLES, style.wire_style)}</select>`)}
        ${field('Wire thickness', graphNumber('wire_width', style))}
        ${field('Wire curve (Bezier, %)', graphNumber('wire_curve', style))}
        ${field('Node corner radius', graphNumber('node_radius', style))}
        ${field('Group corner radius', graphNumber('group_radius', style))}</div></div>
    </section>
    <section><h2>Keyboard shortcuts</h2>
      <div class="shortcuts">${Object.entries(SHORTCUT_LABELS)
        .map(
          ([action, label]) =>
            `<span>${esc(label)}</span><button type="button" class="key" data-action="${action}">${esc(shortcutText(action))}</button>`
        )
        .join('')}</div>
</section></form>`;
  const form = $('#settings-form');
  showSectionPanel(form);
  let shortcuts = {...(preferences.shortcuts || {})};
  const readStyle = () => ({
    font_size: Number(form.font_size.value),
    font_family: form.font_family.value,
    animations: form.animations.checked,
    effects: form.effects.checked,
    wire_style: form.wire_style.value,
    ...Object.fromEntries(
      Object.keys(GRAPH_RANGES).map(k => [
        k,
        clamp(form[k].value.trim() === '' ? GRAPH_DEFAULTS[k] : Math.round(Number(form[k].value)), ...GRAPH_RANGES[k]),
      ])
    ),
    ...Object.fromEntries(PALETTE.map(k => [k, form[k].value])),
  });
  // A colour picker reports dozens of changes a second. Each one only marks the page dirty; the page is restyled once per frame, with the
  // transitions off (hundreds of elements would otherwise start animating towards a colour that is already out of date).
  let frame = 0,
    settle = 0;
  const preview = () => {
    frame = 0;
    const current = readStyle();
    form.theme.value = themeOf(current);
    setRootData('liveEdit', '');
    applyStyle(current);
    clearTimeout(settle);
    settle = setTimeout(() => delete document.documentElement.dataset.liveEdit, 200);
  };
  form.oninput = event => {
    if (event.target.name === 'theme' && THEMES[form.theme.value])
      for (const k of PALETTE) form[k].value = THEMES[form.theme.value][k];
    frame ||= requestAnimationFrame(preview);
  };
  leaveGuards.push(() => {
    cancelAnimationFrame(frame);
    clearTimeout(settle);
    delete document.documentElement.dataset.liveEdit;
  });
  const save = pageAutosave(
    form,
    () => ({
      undo_steps: clamp(Math.round(Number(form.undo_steps.value)) || 0, 0, 500),
      developer_mode: form.developer_mode.checked,
      style: readStyle(),
      shortcuts,
    }),
    async body => {
      app.preferences = await api('settings', {method: 'PUT', body});
      // What was saved may already be behind what the pickers show now: then the pickers win and the next save follows.
      if (!save.isDirty()) applyStyle(app.preferences.style);
      Tabs.render();
    }
  );
  // Whatever was previewed but could not be saved is dropped when the page is left.
  leaveGuards.push(() => applyStyle(app.preferences.style));
  for (const button of $$('.key', form))
    button.onkeydown = event => {
      if (event.key === 'Tab') return;
      event.preventDefault();
      const value = event.key === 'Backspace' ? '' : recordShortcut(event);
      if (
        ['Shift', 'Control', 'Alt', 'Meta'].includes(value) &&
        !['pan', 'multiSelect'].includes(button.dataset.action)
      )
        return;
      shortcuts[button.dataset.action] = value;
      button.textContent = value || '—';
      save.changed();
    };
  app.restoreSettings = () =>
    confirmDialog(
      'Restore default settings?',
      'Theme, appearance, undo steps and keyboard shortcuts return to their defaults.',
      async () => {
        await save(); // nothing pending may overwrite the defaults afterwards
        app.preferences = await api('settings', {
          method: 'PUT',
          body: {undo_steps: 50, style: STYLE_DEFAULTS, shortcuts: {}},
        });
        applyStyle(app.preferences.style);
        leaveGuards = [];
        await render();
      },
      'Restore'
    );
};
