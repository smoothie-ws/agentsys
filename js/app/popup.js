// Popup and context menus (nested submenus, search, keyboard).
'use strict';

/** Small popup menu anchored at a point. `items` are [label, action, {danger, disabled}] or null separators. */
// `searchItems` can supply a wider catalog than the entries shown with an empty query, also on searchable submenus.
function popup(x, y, items, {search = false, searchItems = items} = {}) {
  closePopup(true);
  const menu = document.createElement('div');
  menu.className = 'popup';
  menu.innerHTML = `${search ? `<label class="menu-search">${icon('search')}<input type="search" placeholder="Search nodes…" aria-label="Search nodes" autocomplete="off"></label>` : ''}<div class="menu-items" role="menu"></div>`;
  document.body.append(menu);
  const rootItems = $('.menu-items', menu);
  const closeSiblings = row => {
    for (const sibling of row.parentElement.children) {
      if (sibling === row) continue;
      sibling.querySelector('.submenu')?.remove();
      sibling.querySelector('button')?.setAttribute('aria-expanded', 'false');
    }
  };
  const renderItems = (root, list) => {
    root.replaceChildren();
    for (const item of list) {
      if (!item) {
        root.append(document.createElement('hr'));
        continue;
      }
      const [label, action, meta = {}] = item,
        children = meta.children;
      if (meta.header) {
        // A heading over a group of entries (the label of an <optgroup>); it cannot be chosen.
        const heading = document.createElement('div');
        heading.className = 'menu-heading';
        heading.textContent = label;
        root.append(heading);
        continue;
      }
      const row = document.createElement('div'),
        button = document.createElement('button');
      row.className = 'menu-row';
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.className = meta.danger ? 'danger' : '';
      button.disabled = !!meta.disabled;
      if ('checked' in meta) {
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(!!meta.checked));
      }
      button.innerHTML = `<span class="menu-label">${meta.icon ? icon(meta.icon) : ''}<span>${esc(label)}</span></span>${children ? icon('chevron') : meta.hint ? `<kbd>${esc(meta.hint)}</kbd>` : ''}`;
      row.append(button);
      root.append(row);
      if (children) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const open = () => {
          if (button.disabled) return;
          closeSiblings(row);
          if ($('.submenu', row)) return;
          const sub = document.createElement('div');
          sub.className = 'submenu';
          sub.setAttribute('role', 'menu');
          row.append(sub);
          let list = sub;
          if (meta.search) {
            // A submenu with its own search field filters all of its (nested) entries.
            sub.removeAttribute('role');
            sub.innerHTML = `<label class="menu-search">${icon('search')}<input type="search" placeholder="Search nodes…" aria-label="Search nodes" autocomplete="off"></label><div class="menu-items" role="menu"></div>`;
            list = $('.menu-items', sub);
          }
          renderItems(list, children);
          if (meta.search) {
            const field = $('input', sub);
            field.oninput = () => {
              const q = field.value.trim().toLocaleLowerCase();
              renderItems(list, q ? flatten(meta.searchItems || children).filter(item => item[0].toLocaleLowerCase().includes(q)) : children);
            };
            if (!phoneLayout.matches) setTimeout(() => field.focus(), 0);
          }
          button.setAttribute('aria-expanded', 'true');
          const r = button.getBoundingClientRect(),
            sr = sub.getBoundingClientRect();
          if (phoneLayout.matches) {
            const back=document.createElement('button');back.type='button';back.className='submenu-back';
            back.innerHTML=`${icon('chevron')}<span>Back</span>`;
            back.onclick=event=>{event.stopPropagation();sub.remove();button.setAttribute('aria-expanded','false');button.focus();};
            sub.prepend(back);
          }
          sub.style.left = (phoneLayout.matches ? Math.max(8,(innerWidth-sr.width)/2) : r.right + sr.width + 8 > innerWidth ? Math.max(8, r.left - sr.width) : r.right - 2) + 'px';
          sub.style.top = Math.max(8, Math.min(r.top, innerHeight - sr.height - 8)) + 'px';
        };
        row.onpointerenter = open;
        button.onclick = open;
        button.onkeydown = event => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            open();
            $('.submenu button', row)?.focus();
          }
        };
      } else {
        row.onpointerenter = () => closeSiblings(row);
        button.onclick = () => {
          closePopup();
          Promise.resolve()
            .then(() => action())
            .catch(fail);
        };
      }
    }
    if (!list.length) root.innerHTML = '<p class="muted small menu-empty">No matching nodes</p>';
  };
  renderItems(rootItems, items);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
  const flatten = (list, prefix = '') =>
    list
      .filter(Boolean)
      .flatMap(([label, action, meta = {}]) =>
        meta.children ? flatten(meta.children, prefix + label + ' / ') : [[prefix + label, action, meta]]
      );
  const input = $('input', menu);
  if (input)
    input.oninput = () => {
      const q = input.value.trim().toLocaleLowerCase();
      renderItems(rootItems, q ? flatten(searchItems).filter(item => item[0].toLocaleLowerCase().includes(q)) : items);
      const r = menu.getBoundingClientRect();
      menu.style.top = Math.max(8, Math.min(parseFloat(menu.style.top), innerHeight - r.height - 8)) + 'px';
    };
  menu.addEventListener('keydown', event => {
    if (event.target.matches('input:not([type=search]),textarea,select') && event.key !== 'Escape') return;
    const submenu = event.target.closest('.submenu');
    const scope = submenu ? $('.menu-items', submenu) || submenu : rootItems;
    const buttons = [...scope.children].map(row => $('button', row)).filter(b => b && !b.disabled);
    const i = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = i < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) :
        (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      const parent = submenu.parentElement;
      submenu.remove();
      $('button', parent).setAttribute('aria-expanded', 'false');
      $('button', parent).focus();
    }
    if (event.key === 'Escape') W.canvas?.focus();
  });
  ((!phoneLayout.matches && input) || menu.querySelector('button:not(:disabled)'))?.focus();
  return menu;
}
/** Closes the menus: they fade out first (CSS `.closing`), or at once with `immediate` or when animations are off. */
function closePopup(immediate = false) {
  for (const menu of $$('.popup')) {
    if (immediate) menu.remove();
    else if (!menu.classList.contains('closing')) {
      menu.classList.add('closing');
      const done = () => menu.remove();
      Promise.allSettled(menu.getAnimations({subtree: true}).map(a => a.finished)).then(done);
      setTimeout(done, 400);
    }
  }
}
// Must run before the listener that closes menus: a click on the field of an open list closes it.
document.addEventListener(
  'pointerdown',
  event => {
    const select = event.target.closest?.('select');
    toggledOff = !!select && select === selectMenuOf && !!$('.popup.select-menu:not(.closing)');
  },
  true
);
document.addEventListener(
  'pointerdown',
  event => {
    if (!event.target.closest('.popup')) closePopup();
  },
  true
);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePopup();
});
// Scrolling or zooming anywhere outside a menu closes it, like a click does.
document.addEventListener(
  'wheel',
  event => {
    if (!event.target.closest('.popup')) closePopup();
  },
  {capture: true, passive: true}
);

// ----- Drop-down lists: a <select> opens one of these menus instead of the browser's own list -----
// The <select> stays the source of truth (its value, its change event, options that code rewrites), so nothing that uses it changes.
const selectable = element => element instanceof HTMLSelectElement && !element.disabled && !element.multiple && !(element.size > 1);
let selectMenuOf = null; // the <select> whose menu is open
let toggledOff = false; // the pointer went down on a <select> whose menu was open: that click closes it
/** The entries of a <select>: its options, with the label of each <optgroup> as a heading over its options. */
function selectItems(select) {
  const entry = option => [
    option.textContent,
    () => {
      if (select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
    },
    {disabled: option.disabled, checked: option.selected},
  ];
  const items = [];
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      if (items.length) items.push(null);
      if (child.label) items.push([child.label, null, {header: true}]);
      items.push(...[...child.children].filter(o => o.tagName === 'OPTION').map(entry));
    } else if (child.tagName === 'OPTION') items.push(entry(child));
  }
  return items;
}
function openSelectMenu(select) {
  const r = select.getBoundingClientRect(),
    menu = popup(r.left, r.bottom + 4, selectItems(select));
  menu.classList.add('select-menu');
  menu.style.minWidth = Math.max(r.width, 120) + 'px';
  // Inside a modal dialog everything else is inert, so the menu goes into the dialog.
  const dialog = select.closest('dialog');
  if (dialog) {
    dialog.append(menu);
    menu.classList.add('in-dialog');
  }
  const below = innerHeight - r.bottom - 12,
    height = menu.getBoundingClientRect().height;
  // Not enough room below: open upwards from the top of the field.
  if (height > below && r.top > below) menu.style.top = Math.max(8, r.top - height - 4) + 'px';
  selectMenuOf = select;
  const checked = $('[aria-checked=true]', menu);
  (checked || $('button:not(:disabled)', menu))?.focus({preventScroll: true});
  checked?.scrollIntoView({block: 'nearest'});
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopup();
      select.focus();
    }
  });
  return menu;
}
document.addEventListener(
  'mousedown',
  event => {
    const select = event.target.closest?.('select');
    if (!select || !selectable(select) || event.button !== 0) return;
    event.preventDefault(); // no list of the browser's own
    select.focus();
    if (toggledOff) toggledOff = false;
    else openSelectMenu(select);
  },
  true
);
document.addEventListener(
  'keydown',
  event => {
    const select = event.target;
    if (!selectable(select) || select.matches('[data-no-menu]')) return;
    if (event.key === ' ' || event.key === 'Enter' || (event.altKey && event.key === 'ArrowDown') || event.key === 'F4') {
      // Space and Alt+Down open the list natively; Enter only does inside a form. All open ours.
      if (event.key === 'Enter' && !event.target.closest('.port-row, .widget, .slot-field')) return;
      event.preventDefault();
      openSelectMenu(select);
    }
  },
  true
);
