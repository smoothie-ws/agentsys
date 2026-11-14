// Small shared helpers (DOM, text, formatting), the global `app` state and the api() client.
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
  );
const isUploadedIcon = value =>
  /^(?:data:image\/png;base64,[a-z0-9+/]+=*|data:image\/svg\+xml,%3C.*)$/i.test(value || '');
const icon = name =>
  isUploadedIcon(name)
    ? `<img class="custom-icon" src="${esc(name)}" alt="" aria-hidden="true">`
    : `<svg aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`;
const pretty = value => JSON.stringify(value, null, 2);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = seconds => {
  if (!seconds) return '';
  const date = new Date(seconds * 1000),
    today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    undefined,
    today
      ? {hour: '2-digit', minute: '2-digit', second: '2-digit'}
      : {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}
  );
};
/**
 * Interface state belongs to the client: panel sizes, tabs, camera and the clipboard are kept in this browser,
 * never on the server. Older versions kept them in the server's ui-state key; those values are imported once.
 */
const store = (() => {
  const KEY = 'agentsys-ui-store';
  const RESERVED = new Set([
    KEY,
    'agentsys-environments',
    'agentsys-active-environment',
    'agentsys-client-plugins',
  ]);
  let values = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved;
  } catch {}
  const legacy = [];
  try {
    // The old server injected its ui-state into the page; copy it, then leave the server out of UI state.
    for (const [key, value] of Object.entries(globalThis.AGENTSYS_UI_STORE || {}))
      if (!Object.hasOwn(values, key)) values[key] = value;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (RESERVED.has(key) || (!key.startsWith('agentsys-') && !key.startsWith('fieldHeights:'))) continue;
      try {
        if (!Object.hasOwn(values, key)) values[key] = JSON.parse(localStorage.getItem(key));
        legacy.push(key);
      } catch {}
    }
  } catch {}
  let timer = null,
    pending = Promise.resolve();
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch (error) {
      console.error('Could not save UI state:', error);
    }
    for (const key of legacy.splice(0)) localStorage.removeItem(key);
  };
  const ready = Promise.resolve().then(() => {
    if (legacy.length) persist();
  });
  return {
    ready,
    get: (key, fallback = null) => clone(Object.hasOwn(values, key) ? values[key] : fallback),
    set(key, value) {
      if (JSON.stringify(values[key]) !== JSON.stringify(value)) {
        values[key] = clone(value);
        pending = pending.then(() => {
          if (!timer)
            timer = setTimeout(() => {
              timer = null;
              persist();
            }, 0);
        });
      }
      return pending;
    },
    /** Exposed for tests and for the migration notice. */
    kind: 'localStorage',
  };
})();
const uuid = () => crypto.randomUUID?.() ?? uid();
const app = {
  preferences: {},
  shortcutDefaults: {},
  projects: [],
  resources: [],
  route: null,
};

// ----- API -----
/**
 * Every request goes through the active environment's transport. There is no local backend in the client:
 * closing this page cannot stop a workflow, and switching servers cannot mix their data.
 */
async function api(path, {method = 'GET', body, query, edit, signal} = {}) {
  const [bare, search = ''] = path.split('?');
  const params = {
    ...Object.fromEntries(new URLSearchParams(search)),
    ...Object.fromEntries(Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null)),
  };
  return Environment.request(method, bare, {
    body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
    query: params,
    edit,
    signal,
  });
}

/** Icons a Custom Node or a group of Custom Nodes can wear. */
const NODE_ICONS =
  'complex package code spark branch split loop refresh skip exit merge toggle list hash text note eye file folder library server plug terminal user star heart bolt database globe mail cpu filter key lock bell chart cloud flag tag wrench shuffle timer'.split(
    ' '
  );
/** The upload button is not an icon: a wide dashed button with its own caption, so it is never mistaken for one of the icons around it. */
const uploadLabel = uploaded =>
  `${icon(uploaded || 'upload')}<span>${uploaded ? 'Replace your image' : 'Upload your own'}</span>`;
const iconGrid = (current, fallback, preview = '') =>
  `<div class="icon-grid" data-icon-grid ${preview ? `data-preview="${esc(preview)}"` : ''}><input type="hidden" name="icon" value="${esc(current || '')}">${NODE_ICONS.map(i => `<button type="button" class="icon ${i === (current || fallback) ? 'active' : ''}" data-icon-choice="${i}" title="${i}" aria-label="${i}">${icon(i)}</button>`).join('')}<button type="button" class="dashed-action ${isUploadedIcon(current) ? 'active' : ''}" data-upload-icon aria-label="Upload your own icon" title="Upload your own image as the icon">${uploadLabel(isUploadedIcon(current) ? current : '')}</button><input type="file" data-icon-file accept="image/*" hidden aria-label="Icon image"></div>`;

function chooseIcon(grid, value, selected) {
  const input = $('input[name=icon]', grid);
  input.value = value;
  for (const button of $$('[data-icon-choice], [data-upload-icon]', grid))
    button.classList.toggle('active', button === selected);
  if (grid.dataset.preview) $(grid.dataset.preview).innerHTML = icon(value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
}

document.addEventListener('click', event => {
  const upload = event.target.closest('[data-upload-icon]');
  if (upload) {
    event.preventDefault();
    $('[data-icon-file]', upload.closest('[data-icon-grid]')).click();
    return;
  }
  const choice = event.target.closest('[data-icon-choice]');
  if (!choice) return;
  event.preventDefault(); // Prevent the surrounding label from activating its first button too.
  chooseIcon(choice.closest('[data-icon-grid]'), choice.dataset.iconChoice, choice);
});

document.addEventListener('change', async event => {
  const input = event.target.closest('[data-icon-file]');
  if (!input?.files[0]) return;
  const url = URL.createObjectURL(input.files[0]);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * size));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * size));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const value = canvas.toDataURL('image/png');
    const grid = input.closest('[data-icon-grid]'),
      button = $('[data-upload-icon]', grid);
    button.innerHTML = uploadLabel(value);
    chooseIcon(grid, value, button);
  } catch {
    fail(new Error('Could not load this icon image.'));
  } finally {
    URL.revokeObjectURL(url);
    input.value = '';
  }
});

/** One pointer drag: `move` on every move, `end` once on release or cancel (e.type tells which). Shared by the canvas and the panel resizers. */
function drag(event, move, end) {
  event.preventDefault();
  const target = event.target;
  target.setPointerCapture?.(event.pointerId);
  const onMove = e => {
      if (e.pointerId === event.pointerId) move(e);
    },
    onUp = e => {
      if (e.pointerId !== event.pointerId) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
      Promise.resolve(end?.(e)).catch(fail);
    };
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
}

/** Reusable JSON file exchange for Library, projects, workflows. */
function pickFiles({multiple = true, accept = '.json,application/json'} = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;
    const finish = files => {
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish([...input.files]);
    input.oncancel = () => finish([]);
    document.body.append(input);
    input.click();
  });
}
function downloadJSON(value, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  link.download = `${
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim() || 'agentsys'
  }.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
