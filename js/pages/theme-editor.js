// Component appearance editor. An empty field follows the base palette.
'use strict';
let previewContext;
/** Any CSS colour as #rrggbb[aa], through one shared 1×1 canvas (a new canvas per token made every preview refresh slow). */
function colourToHex(fill) {
  previewContext ??= Object.assign(document.createElement('canvas'), {width: 1, height: 1}).getContext('2d', {willReadFrequently: true});
  previewContext.clearRect(0, 0, 1, 1);
  previewContext.fillStyle = '#808080'; // what an unreadable value falls back to
  previewContext.fillStyle = fill;
  previewContext.fillRect(0, 0, 1, 1);
  const data = [...previewContext.getImageData(0, 0, 1, 1).data];
  return '#' + data.slice(0, data[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('');
}
/** The colour a token shows while it has no override of its own. `known` remembers each variable for one pass over the form. */
function themePartPreview(rule, computed = getComputedStyle(document.body), known = new Map()) {
  if (rule.type !== 'color') return '';
  if (!known.has(rule.fallback)) known.set(rule.fallback, colourToHex(computed.getPropertyValue(rule.fallback).trim() || '#808080'));
  return known.get(rule.fallback);
}
function themeEditorHTML(parts = {}) {
  const computed = getComputedStyle(document.body), known = new Map();
  return `<div class="theme-component-editor">
    <div class="theme-editor-toolbar"><h3>Component appearance</h3><input type="search" id="theme-filter" aria-label="Find theme setting" placeholder="Find a component or colour"><button type="button" class="ghost small" id="theme-expand-all">Expand all</button><button type="button" class="ghost small" id="theme-reset-parts">Reset</button></div>
    <div class="theme-live-preview" aria-label="Theme preview"><span class="theme-preview-label">Preview</span><button type="button">Button</button><button type="button" class="primary">Primary</button><input aria-label="Preview field" placeholder="Text field"><span class="theme-preview-node">${icon('node')}Graph node</span><span class="theme-preview-menu"><span>Menu item</span><span class="selected">Selected</span></span><span class="theme-preview-status">${icon('activity')}Ready</span></div>
    ${Object.entries(THEME_PARTS).map(([group,definition],i)=>`<details class="theme-component" data-theme-group="${group}" ${i<2?'open':''}><summary>${icon(definition.icon)}<strong>${esc(definition.label)}</strong><span class="theme-custom-count">Automatic</span></summary><div class="theme-token-grid">${Object.entries(definition.fields).map(([key,rule])=>{
      const value=parts[group]?.[key] ?? '',label=`${definition.label}: ${rule.label}`;
      return `<div class="theme-token" data-theme-token="${key}"><span>${esc(rule.label)}</span><div class="theme-token-controls">${rule.type==='color' ? `<span class="theme-colour-chip"><input type="color" data-theme-picker aria-label="${esc(label)} colour" value="${String(value || themePartPreview(rule, computed, known)).slice(0,7)}"></span>` : ''}<input data-theme-value data-part="${group}" data-key="${key}" type="${rule.type==='color'?'text':'number'}" value="${esc(value)}" aria-label="${esc(label)}" placeholder="Auto" ${rule.type==='color'?'maxlength="9" pattern="#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?" spellcheck="false"':'min="0" max="32" step="1"'}>${rule.type==='number'?'<span class="theme-unit">px</span>':''}</div></div>`;
    }).join('')}</div></details>`).join('')}
  </div>`;
}
function readThemeParts(form) {
  const result={};
  for (const input of $$('[data-theme-value]',form)) {
    const value=input.value.trim(),rule=THEME_PARTS[input.dataset.part].fields[input.dataset.key];
    if (!value) continue;
    (result[input.dataset.part]??={})[input.dataset.key]=rule.type==='number'?Number(value):value.toLowerCase();
  }
  return result;
}
function fillThemeParts(form,parts = {}) {
  for (const input of $$('[data-theme-value]',form)) input.value=parts[input.dataset.part]?.[input.dataset.key] ?? '';
  refreshThemeParts(form);
}
function refreshThemeToken(input, computed, known) {
  const token = input.closest('.theme-token'), rule = THEME_PARTS[input.dataset.part].fields[input.dataset.key];
  const overridden = String(input.value !== '');
  if (token.dataset.overridden !== overridden) token.dataset.overridden = overridden;
  const picker = $('[data-theme-picker]', token);
  if (!picker) return;
  const valid = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(input.value);
  const color = valid ? input.value : themePartPreview(rule, computed, known);
  if (token.dataset.preview === color) return;
  token.dataset.preview = color;
  picker.value = color.slice(0, 7);
  token.style.setProperty('--preview-color', color);
}
function refreshThemeParts(form) {
  const computed = getComputedStyle(document.body), known = new Map();
  for (const input of $$('[data-theme-value]', form)) refreshThemeToken(input, computed, known);
  for (const group of $$('[data-theme-group]', form)) {
    const count = $$('[data-theme-value]', group).filter(input => input.value !== '').length;
    const label = $('.theme-custom-count', group), text = count ? `${count} override${count === 1 ? '' : 's'}` : 'Automatic';
    if (label.textContent !== text) label.textContent = text;
  }
}
function bindThemeEditor(form) {
  const editor=$('.theme-component-editor',form);
  editor.addEventListener('input',event=>{
    const picker=event.target.closest('[data-theme-picker]');
    if (!picker) return;
    const input=$('[data-theme-value]',picker.closest('.theme-token'));
    input.value=picker.value+(input.value.length===9?input.value.slice(7):'');
    refreshThemeToken(input);
    const group=input.closest('[data-theme-group]'),count=$$('[data-theme-value]',group).filter(field=>field.value!=='').length;
    $('.theme-custom-count',group).textContent=count?`${count} override${count===1?'':'s'}`:'Automatic';
  });
  $('#theme-reset-parts',form).onclick=()=>{
    fillThemeParts(form,{});
    form.dispatchEvent(new Event('input',{bubbles:true}));
  };
  $('#theme-expand-all',form).onclick=event=>{
    const groups=$$('[data-theme-group]:not([hidden])',form),open=groups.some(group=>!group.open);
    for (const group of groups) group.open=open;
    event.currentTarget.textContent=open?'Collapse all':'Expand all';
  };
  $('#theme-filter',form).addEventListener('input',event=>{
    event.stopPropagation();
    const query=event.target.value.trim().toLowerCase();
    for (const group of $$('[data-theme-group]',editor)) {
      const definition=THEME_PARTS[group.dataset.themeGroup],all=definition.label.toLowerCase().includes(query);
      let visible=0;
      for (const token of $$('.theme-token',group)) {
        const rule=definition.fields[token.dataset.themeToken];
        token.hidden=!!query&&!all&&!rule.label.toLowerCase().includes(query);
        if (!token.hidden) visible++;
      }
      group.hidden=!visible;
      if(query&&visible) group.open=true;
    }
  });
  refreshThemeParts(form);
}
