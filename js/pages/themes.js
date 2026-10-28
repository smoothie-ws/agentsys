// Named appearance presets and portable JSON theme files.
'use strict';

const themeEntries = (prefs = app.preferences) => [
  ...Object.entries(THEMES).map(([name, style]) => ({id:name, name, style})),
  ...(prefs.themes || []).map(theme => ({...theme, id:'saved:' + theme.id, saved:true})),
];
const sameTheme = (style, theme) => Object.entries(theme.style).filter(([key])=>key!=='components').every(([key, value]) => style[key] === value) && Object.entries(THEME_PARTS).every(([group,definition])=>Object.keys(definition.fields).every(key=>style.components?.[group]?.[key]===theme.style.components?.[group]?.[key]));
function selectedTheme(style, prefs) {
  const entries = themeEntries(prefs);
  return entries.find(t => t.id === prefs.theme && sameTheme(style,t))?.id ||
    [...entries.filter(t => t.saved), ...entries.filter(t => !t.saved)].find(t => sameTheme(style,t))?.id || '';
}
function themeOptions(prefs, selected = '') {
  return `<option value="">Custom</option><optgroup label="Built-in">${options(Object.keys(THEMES).map(name => [name,name]),selected)}</optgroup>${prefs.themes?.length ? `<optgroup label="Saved">${options(prefs.themes.map(t => ['saved:'+t.id,t.name]),selected)}</optgroup>` : ''}`;
}
function fillTheme(form, style) {
  fillThemeParts(form,style.components || {});
  for (const [key,value] of Object.entries(style)) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
  }
}
function bindThemeActions(form, save, readStyle) {
  const refresh = id => {
    form.theme.innerHTML = themeOptions(app.preferences,id);
    form.theme.value = id;
  };
  $('#save-theme',form).onclick = () => {
    const current = themeEntries().find(t => t.id === form.theme.value);
    dialog('Save theme', field('Name', `<input name="name" required maxlength="100" value="${esc(current?.saved ? current.name : 'My theme')}" autofocus>`), async modal => {
      await save();
      const name = modal.elements.name.value.trim();
      if (!name) throw new Error('Enter a theme name.');
      const themes = [...(app.preferences.themes || [])];
      const index = themes.findIndex(t => t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      const theme = {id:index >= 0 ? themes[index].id : uuid(),name,style:readStyle()};
      if (index >= 0) themes[index] = theme; else themes.push(theme);
      const id = 'saved:' + theme.id;
      app.preferences = await api('settings',{method:'PUT',body:{themes,theme:id,style:theme.style}});
      refresh(id);
      save.changed(); await save();
    },'Save theme');
    $('#modal input[name=name]').select();
  };
  $('#export-theme',form).onclick = () => {
    const name = themeEntries().find(t => t.id === form.theme.value)?.name || 'Custom theme';
    downloadJSON({agentsys:1,kind:'theme',name,style:readStyle()}, `${name}.theme`);
  };
  $('#import-themes',form).onclick = async () => {
    try {
      const files = await pickFiles();
      if (!files.length) return;
      await save();
      const themes = [...(app.preferences.themes || [])];
      let last;
      for (const file of files) {
        const data = JSON.parse(await file.text());
        if (data.agentsys !== 1 || !['theme','themes'].includes(data.kind)) throw new Error(`${file.name}: choose an exported theme file.`);
        const entries = data.kind === 'theme' ? [data] : data.themes;
        if (!Array.isArray(entries) || !entries.length) throw new Error('The theme file is empty.');
        for (const entry of entries) {
          if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 100) throw new Error('A theme needs a name of 1 to 100 characters.');
          const base = entry.name.trim();
          let name = base, suffix = 2;
          while (themes.some(t => t.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = base.slice(0,93) + ` (${suffix++})`;
          last = {id:uuid(),name,style:entry.style};
          themes.push(last);
        }
      }
      validateThemes(themes); // Validate the entire batch before persisting any imported theme.
      const style = {...readStyle(),...last.style,components:last.style.components||{}}, id = 'saved:' + last.id;
      app.preferences = await api('settings',{method:'PUT',body:{themes,style,theme:id}});
      fillTheme(form,style); refresh(id); applyStyle(style);
      save.changed(); await save();
    } catch (error) { fail(error); }
  };
  $('#theme-actions-more',form).onclick = event => {
    const saved = (app.preferences.themes || []), id = form.theme.value.slice(6);
    const current = form.theme.value.startsWith('saved:') && saved.find(t => t.id === id);
    const rect = event.currentTarget.getBoundingClientRect();
    popup(rect.left,rect.bottom+4,[
      ['Export saved themes', () => downloadJSON({agentsys:1,kind:'themes',themes:saved.map(({name,style})=>({name,style}))},'Saved themes'), {icon:'upload',disabled:!saved.length}],
      ['Delete saved theme',async () => {
        await save();
        app.preferences = await api('settings',{method:'PUT',body:{themes:saved.filter(t=>t.id!==id),theme:''}});
        refresh(''); save.changed(); await save();
      },{icon:'trash',danger:true,disabled:!current}],
    ]);
  };
}
