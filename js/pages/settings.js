// Pages: project settings and application settings.
'use strict';

// ----- project settings -----
PAGES['project-settings'] = async (view, route) => {
  const {project} = await api(`projects/${route.project}`);
  view.innerHTML = `<form class="page form-page" id="project-form">${pageHead({
    crumbs: [
      ['Projects', '/'],
      [project.name, `/p/${project.id}`],
    ],
    title: 'Project settings',
    actions: '<span id="save-slot"></span>',
  })}
    <section><h2>General</h2>${field('Name', `<input name="name" required maxlength="100" value="${esc(project.name)}">`)}
      ${field('Description', `<textarea name="description" rows="4" maxlength="2000" placeholder="What is this project for?">${esc(project.description)}</textarea>`)}</section>
    <p class="form-error" hidden></p></form>`;
  const form = $('#project-form');
  sectionTabs(form, [['General', 'settings']]);
  autosave(
    form,
    () => ({name: nameValue(form.name).trim(), description: form.description.value}),
    async body => {
      await api(`projects/${project.id}`, {method: 'PUT', body});
      await loadProjects();
    }
  );
  bindNameField(form.name);
};

/** Settings pages save by themselves: the status text sits in the page header, and leaving the page saves what is pending. */
function autosave(form, read, write) {
  const save = autoForm(form, read, write),
    status = $('.save-status', form);
  $('#save-slot', form).replaceWith(status);
  leaveGuards.push(() => save());
  return save;
}

// ----- application settings -----
const graphNumber = (name, style) => {
  const [min, max] = GRAPH_RANGES[name];
  return `<input name="${name}" type="number" min="${min}" max="${max}" value="${style[name]}">`;
};
PAGES.settings = async view => {
  const {preferences} = await loadLibrary();
  const style = {...STYLE_DEFAULTS, ...preferences.style};
  const theme = selectedTheme(style, preferences);
  view.innerHTML = `<form class="page form-page" id="settings-form">${pageHead({title: 'Settings', actions: '<span id="save-slot"></span><button type="button" class="ghost" id="restore">Restore defaults</button>'})}
    <section><h2>Editing</h2>${field('Undo steps per workflow', `<input name="undo_steps" type="number" min="0" max="500" value="${esc(preferences.undo_steps ?? 50)}">`)}
      <label class="check"><input type="checkbox" name="developer_mode" ${preferences.developer_mode ? 'checked' : ''}> Developer mode</label></section>
    <section class="appearance-section"><h2>Appearance</h2>${field(
      'Theme',
      `<select name="theme">${themeOptions(preferences,theme)}</select>`
    )}
      <div class="button-row theme-actions"><button type="button" class="ghost" id="save-theme">${icon('plus')}Save theme</button><button type="button" class="ghost" id="import-themes">${icon('download')}Import themes</button><button type="button" class="ghost" id="export-theme">${icon('upload')}Export theme</button><button type="button" class="icon" id="theme-actions-more" data-context-menu aria-label="More theme actions">${icon('dots')}</button></div>
      <div class="grid4">${['background', 'surface', 'text', 'accent'].map(k => field(k[0].toUpperCase() + k.slice(1), `<input type="color" name="${k}" value="${esc(style[k])}">`)).join('')}</div>
      <div class="grid2">${field('Text size', `<input name="font_size" type="number" min="12" max="22" value="${style.font_size}">`)}
      ${field('Font', `<select name="font_family">${options([['system', 'System'], ...['Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Courier New'].map(f => [f, f])], style.font_family)}</select>`)}</div>
      <div class="button-row"><label class="check"><input type="checkbox" name="animations" ${style.animations ? 'checked' : ''}> Animations</label><label class="check"><input type="checkbox" name="effects" ${style.effects ? 'checked' : ''}> Effects</label></div>
      ${themeEditorHTML(style.components)}
      <h3>Graph Editor</h3>
      <div class="grid2">${field('Wire style', `<select name="wire_style">${options(WIRE_STYLES, style.wire_style)}</select>`)}
      ${field('Wire thickness', graphNumber('wire_width', style))}
      ${field('Wire curve (Bezier, %)', graphNumber('wire_curve', style))}
      ${field('Node corner radius', graphNumber('node_radius', style))}
      ${field('Group corner radius', graphNumber('group_radius', style))}</div></section>
    <section><h2>Keyboard shortcuts</h2>
      <div class="shortcuts">${Object.entries(SHORTCUT_LABELS)
        .map(
          ([action, label]) =>
            `<span>${esc(label)}</span><button type="button" class="key" data-action="${action}">${esc(shortcutText(action))}</button>`
        )
        .join('')}</div>
</section></form>`;
  const form = $('#settings-form');
  sectionTabs(form, [
    ['Editing', 'settings'],
    ['Appearance', 'palette'],
    ['Keyboard shortcuts', 'keyboard'],
  ]);
  let shortcuts = {...(preferences.shortcuts || {})};
  const readStyle = () => ({
    font_size: Number(form.font_size.value),
    font_family: form.font_family.value,
    animations: form.animations.checked,
    effects: form.effects.checked,
    wire_style: form.wire_style.value,
    components: readThemeParts(form),
    ...Object.fromEntries(
      Object.keys(GRAPH_RANGES).map(k => [
        k,
        clamp(form[k].value.trim()==='' ? GRAPH_DEFAULTS[k] : Math.round(Number(form[k].value)), ...GRAPH_RANGES[k]),
      ])
    ),
    ...Object.fromEntries(['background', 'surface', 'text', 'accent'].map(k => [k, form[k].value])),
  });
  // A colour picker reports dozens of changes a second. Each one only marks the page dirty; the page is restyled once per frame, with the
  // transitions off (hundreds of elements would otherwise start animating towards a colour that is already out of date), and the
  // previews of the untouched tokens are recomputed once the dragging has settled.
  let frame = 0, settle = 0;
  const preview = () => {
    frame = 0;
    const selected = themeEntries().find(t => t.id === form.theme.value),
      current = readStyle();
    if (selected && !sameTheme(current, selected)) form.theme.value = '';
    try { validateThemeParts(current.components); } catch { return; }
    setRootData('liveEdit', '');
    applyStyle(current);
    clearTimeout(settle);
    settle = setTimeout(() => {
      delete document.documentElement.dataset.liveEdit;
      refreshThemeParts(form);
    }, 200);
  };
  form.oninput = event => {
    const selected = themeEntries().find(t => t.id === form.theme.value);
    if (event.target.name === 'theme' && selected) fillTheme(form, selected.style);
    frame ||= requestAnimationFrame(preview);
  };
  leaveGuards.push(() => {
    cancelAnimationFrame(frame);
    clearTimeout(settle);
    delete document.documentElement.dataset.liveEdit;
  });
  const save = autosave(
    form,
    () => ({
      undo_steps: clamp(Math.round(Number(form.undo_steps.value)) || 0, 0, 500),
      developer_mode: form.developer_mode.checked,
      style: readStyle(),
      theme: form.theme.value,
      shortcuts,
    }),
    async body => {
      app.preferences = await api('settings', {method: 'PUT', body});
      // What was saved may already be behind what the pickers show now: then the pickers win and the next save follows.
      if (!save.isDirty()) applyStyle(app.preferences.style);
      Tabs.render();
    }
  );
  bindThemeActions(form,save,readStyle);
  bindThemeEditor(form);
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
  $('#restore').onclick = () =>
    confirmDialog(
      'Restore default settings?',
      'Theme, appearance, undo steps and keyboard shortcuts return to their defaults.',
      async () => {
        await save(); // nothing pending may overwrite the defaults afterwards
        app.preferences = await api('settings', {
          method: 'PUT',
          body: {undo_steps: 50, style: STYLE_DEFAULTS, shortcuts: {}, theme: ''},
        });
        applyStyle(app.preferences.style);
        leaveGuards = [];
        await render();
      },
      'Restore'
    );
};
