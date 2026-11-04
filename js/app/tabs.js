// Tabs of the open graph editors (workflows and Custom Nodes), like files in a code editor; persisted in this browser.
// Every other page (Dashboard, Projects, a project, Library, Settings) is reached through the sidebar and the second panel;
// it has no tab; Tabs.pages remembers scroll and local filters, while the URL selects the page and subsection.
'use strict';

const Tabs = {
  items: [],
  /** Editors shown during this page session: reopening one keeps its camera, a fresh open fits the view. */
  seen: new Set(),
  /** Scroll and local filters of non-editor pages, by page key. */
  pages: {},
  /** An editor tab is told apart by project/workflow. */
  key: tab => tab.project + '/' + tab.workflow,
  /** The key of a page that has no tab (an editor's key is its project/workflow). */
  pageKey(route) {
    return (
      {
        home: 'home',
        projects: 'projects',
        project: 'p:' + route.project,
        'project-settings': 'ps:' + route.project,
        settings: 'settings',
        // (no "/" in a key: an editor's key is project/workflow)
        resources: ['res', route.section, route.id || (route.folder ? 'in:' + encodeURIComponent(route.folder) : '')]
          .filter(Boolean)
          .join(':'),
        api: 'api',
        plugins: ['plugins', route.id].filter(Boolean).join(':'),
        'not-found': 'missing',
      }[route.page] || 'home'
    );
  },
  /** What the open page remembers: the Settings section, the scroll position. An editor tab holds its own. */
  stateOf(key = this.keyOf(app.route || {})) {
    const tab = this.items.find(t => this.key(t) === key);
    return tab || (key.includes('/') ? undefined : (this.pages[key] ??= {})); // an editor key is project/workflow
  },
  keyOf(route) {
    return route.workflow ? this.key(route) : this.pageKey(route);
  },
  load() {
    const saved = store.get('agentsys-tabs', []);
    this.items = Array.isArray(saved) ? saved.filter(t => t && t.project && t.workflow) : [];
    const pages = store.get('agentsys-pages', {});
    this.pages = pages && typeof pages === 'object' && !Array.isArray(pages) ? pages : {};
  },
  save() {
    for (const key of this.seen) if (!this.items.some(t => this.key(t) === key)) this.seen.delete(key);
    store.set('agentsys-tabs', this.items);
    store.set('agentsys-pages', this.pages);
  },
  /** Adds the editor to the bar (or refreshes its name) when its page opens. */
  open(tab) {
    const found = this.items.find(t => this.key(t) === this.key(tab));
    if (found) Object.assign(found, tab);
    else this.items.push(tab);
    this.arrange();
    this.save();
    this.render();
  },
  /** Pinned tabs form a stack on the left; the order inside each part is kept. */
  arrange() {
    this.items = [...this.items.filter(t => t.pinned), ...this.items.filter(t => !t.pinned)];
  },
  pin(key, pinned) {
    const tab = this.items.find(t => this.key(t) === key);
    if (!tab) return;
    if (pinned) tab.pinned = true;
    else delete tab.pinned;
    this.arrange();
    this.save();
    this.render();
  },
  rename(workflow, title) {
    const tab = this.items.find(t => t.workflow === workflow);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.save();
    this.render();
  },
  setIcon(workflow, icon) {
    const tab = this.items.find(t => t.workflow === workflow);
    if (!tab || tab.icon === icon) return;
    tab.icon = icon;
    this.save();
    this.render();
  },
  renameProject(project, sub) {
    for (const tab of this.items.filter(t => t.project === project && !t.library)) tab.sub = sub;
    this.save();
    this.render();
  },
  drop(workflow) {
    this.items = this.items.filter(t => t.workflow !== workflow);
    this.save();
    this.render();
  },
  dropProject(project) {
    this.items = this.items.filter(t => t.project !== project);
    for (const key of ['p:' + project, 'ps:' + project]) delete this.pages[key];
    this.save();
    this.render();
  },
  /** Closes a tab; when it was the open one, the neighbouring tab (or the project list) takes its place. */
  async close(key) {
    const index = this.items.findIndex(t => this.key(t) === key);
    if (index < 0 || this.items[index].pinned) return;
    const active = this.keyOf(app.route || {}) === key;
    const fallback = parentPage(app.route || {})[1];
    if (active && !(await leaveView())) return;
    this.items.splice(index, 1);
    this.save();
    if (!active) return this.render();
    const next = this.items[index] || this.items[index - 1];
    if (next) await go(this.href(next));
    else await go(fallback);
  },
  /** Closes several tabs at once (never the pinned ones); `stay` is the tab to show if the open one goes. */
  async closeMany(keys, stay) {
    const gone = new Set(keys.filter(k => !this.items.find(t => this.key(t) === k)?.pinned));
    if (!gone.size) return;
    const active = gone.has(this.keyOf(app.route || {}));
    const fallback = parentPage(app.route || {})[1];
    if (active && !(await leaveView())) return;
    this.items = this.items.filter(t => !gone.has(this.key(t)));
    this.save();
    if (!active) return this.render();
    const next = this.items.find(t => this.key(t) === stay) || this.items[0];
    await go(next ? this.href(next) : fallback);
  },
  menu(key, x, y) {
    const index = this.items.findIndex(t => this.key(t) === key),
      tab = this.items[index];
    if (!tab) return;
    const keys = list => list.map(t => this.key(t));
    popup(x, y, [
      [tab.pinned ? 'Unpin' : 'Pin', () => this.pin(key, !tab.pinned), {icon: tab.pinned ? 'unpin' : 'pin'}],
      null,
      ['Close', () => this.close(key).catch(fail), {icon: 'x', disabled: !!tab.pinned}],
      [
        'Close All',
        () => this.closeMany(keys(this.items), key).catch(fail),
        {icon: 'collapse', disabled: this.items.every(t => t.pinned)},
      ],
      [
        'Close to the right',
        () => this.closeMany(keys(this.items.slice(index + 1)), key).catch(fail),
        {icon: 'chevron', disabled: this.items.slice(index + 1).every(t => t.pinned)},
      ],
    ]);
  },
  href: tab => tab.href || `/p/${encodeURIComponent(tab.project)}/w/${encodeURIComponent(tab.workflow)}`,
  /** A closed tab fades and shrinks to nothing, so the tabs to its right glide over (the bar is a flex row; its width is animated in CSS). */
  dismiss(el) {
    if (document.documentElement.dataset.motion === 'false' || !el.isConnected) return el.remove();
    el.classList.remove('active');
    el.style.maxWidth = el.offsetWidth + 'px';
    el.style.pointerEvents = 'none';
    void el.offsetWidth; // the start width must be applied before the end width, or nothing animates
    el.classList.add('closing');
    el.addEventListener('transitionend', event => event.propertyName === 'max-width' && el.remove());
    setTimeout(() => el.remove(), 600); // in case no transition ends (hidden page)
  },
  /** Redraws the bar in place: a tab keeps its element, so switching the open one animates (CSS transitions) instead of flashing. */
  render() {
    const bar = $('#tabs');
    if (!bar) return;
    const current = this.keyOf(app.route || {}),
      old = new Map([...bar.children].filter(el => !el.classList.contains('closing')).map(el => [el.dataset.tab, el]));
    const tabs = this.items
      .filter(tab => developerMode() || (!tab.library && !tab.project.startsWith('lib-')))
      .map(tab => {
        const key = this.key(tab),
          el = old.get(key) || Object.assign(document.createElement('a'), {role: 'tab'});
        old.delete(key);
        const html = `${icon(tab.icon || (tab.library ? 'complex' : 'node'))}<span class="tab-title">${esc(tab.title)}</span>${tab.sub ? `<span class="tab-sub">${esc(tab.sub)}</span>` : ''}${tab.pinned ? `<span class="tab-pin" title="Pinned">${icon('pin')}</span>` : `<button class="icon tab-close" data-close-tab="${esc(key)}" title="Close" aria-label="Close tab">${icon('x')}</button>`}`;
        el.dataset.tab = key;
        el.draggable = false;
        el.toggleAttribute('data-link', true);
        el.dataset.path = this.href(tab);
        el.href = urlOf(el.dataset.path);
        el.title = (tab.sub ? tab.sub + ' / ' : '') + tab.title;
        el.className = 'tab' + (key === current ? ' active' : '') + (tab.pinned ? ' is-pinned' : '');
        el.setAttribute('aria-selected', String(key === current));
        el.tabIndex =
          key === current || (!this.items.some(t => this.key(t) === current) && tab === this.items[0]) ? 0 : -1;
        if (el.dataset.html !== html) el.innerHTML = el.dataset.html = html;
        return el;
      });
    old.forEach(el => this.dismiss(el));
    // Tabs keep their order; a tab that is leaving stays where it was until it has shrunk away.
    let cursor = bar.firstElementChild;
    for (const el of tabs) {
      while (cursor && cursor !== el && cursor.classList.contains('closing')) cursor = cursor.nextElementSibling;
      if (cursor === el) cursor = cursor.nextElementSibling;
      else bar.insertBefore(el, cursor);
    }
    if (!this.sorting) $('.tab.active', bar)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  },
};
Tabs.load();
Tabs.arrange();
$('#tabs').addEventListener('contextmenu', event => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  event.preventDefault();
  if (Tabs.sorting) return;
  Tabs.menu(tab.dataset.tab, event.clientX, event.clientY);
});
$('#tabs').addEventListener('click', event => {
  const close = event.target.closest('[data-close-tab]');
  if (!close) return;
  event.preventDefault();
  event.stopPropagation();
  Tabs.close(close.dataset.closeTab).catch(fail);
});
$('#tabs').addEventListener('auxclick', event => {
  const tab = event.target.closest('[data-tab]');
  if (event.button !== 1 || !tab) return;
  event.preventDefault();
  Tabs.close(tab.dataset.tab).catch(fail);
});
$('#tabs').addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button')) return;
  const tab = event.target.closest('.tab:not(.closing)');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Delete') return Tabs.close(tab.dataset.tab).catch(fail);
  const tabs = $$('#tabs > .tab:not(.closing)'),
    index = tabs.indexOf(tab);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  go(tabs[next].dataset.path).catch(fail);
});
$('#tabs').addEventListener(
  'wheel',
  event => {
    if (event.deltaY && !event.deltaX) {
      event.currentTarget.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  },
  {passive: false}
);

// Mouse drag reorders immediately; on touch, swipe scrolls and hold-then-drag reorders.
let suppressTabClick = false;
$('#tabs').addEventListener(
  'click',
  event => {
    if (suppressTabClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);
$('#tabs').addEventListener('pointerdown', event => {
  const tab = event.target.closest('.tab:not(.closing)');
  if (event.button !== 0 || !tab || event.target.closest('button,input')) return;
  const bar = event.currentTarget,
    key = tab.dataset.tab,
    moving = Tabs.items.find(t => Tabs.key(t) === key);
  if (!moving) return;
  const controller = new AbortController(),
    initial = Tabs.items.map(Tabs.key),
    scroll = bar.scrollLeft;
  let mode = '',
    timer,
    pointerX = event.clientX,
    grab = 0,
    frame = 0;
  const elOf = t => $(`[data-tab="${CSS.escape(Tabs.key(t))}"]`, bar);
  /** Where the pointer is in the bar's own coordinates (they do not change when the bar scrolls under it). */
  const contentX = () => pointerX - bar.getBoundingClientRect().left + bar.scrollLeft;
  /** The dragged tab follows the pointer exactly: its place in the row plus an offset that makes up the difference. */
  const follow = () => {
    // ...but never past the ends of the row: a tab pulled out of it would stretch the bar and make the other tabs scroll away.
    const last = bar.lastElementChild,
      left = Math.max(0, Math.min(contentX() - grab, last.offsetLeft + last.offsetWidth - tab.offsetWidth));
    tab.style.transform = `translateX(${left - tab.offsetLeft}px)`;
  };
  const start = () => {
    mode = 'sort';
    Tabs.sorting = true;
    grab = event.clientX - tab.getBoundingClientRect().left;
    tab.classList.add('sorting');
    follow();
    const edge = () => {
      // the bar scrolls on its own while the pointer rests at an edge
      if (mode !== 'sort') return;
      const rect = bar.getBoundingClientRect(),
        before = bar.scrollLeft;
      if (pointerX < rect.left + 40) bar.scrollLeft -= Math.min(18, (rect.left + 40 - pointerX) / 2 + 2);
      else if (pointerX > rect.right - 40) bar.scrollLeft += Math.min(18, (pointerX - rect.right + 40) / 2 + 2);
      if (bar.scrollLeft !== before) {
        follow();
        place();
      }
      frame = requestAnimationFrame(edge);
    };
    frame = requestAnimationFrame(edge);
  };
  /** Puts the dragged tab where the pointer is; the tabs it passes glide aside instead of jumping. */
  const place = () => {
    const x = contentX(),
      rest = Tabs.items.filter(t => t !== moving),
      peers = rest.filter(t => !!t.pinned === !!moving.pinned);
    const before = peers.find(t => {
      const el = elOf(t);
      return el && x < el.offsetLeft + el.offsetWidth / 2;
    });
    let index = before ? rest.indexOf(before) : moving.pinned ? rest.findIndex(t => !t.pinned) : rest.length;
    if (index < 0) index = rest.length;
    const unchanged = Tabs.items.indexOf(moving) === index;
    rest.splice(index, 0, moving);
    if (unchanged) {
      follow();
      return;
    }
    const others = [...bar.children].filter(el => el !== tab),
      from = new Map(others.map(el => [el, el.offsetLeft]));
    Tabs.items = rest;
    const next = rest[index + 1],
      ref = next && elOf(next);
    bar.insertBefore(tab, ref && ref.parentNode === bar ? ref : null);
    follow();
    for (const el of others) {
      const delta = from.get(el) - el.offsetLeft;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateX(${delta}px)`;
      void el.offsetWidth;
      el.style.transition = '';
      el.style.transform = '';
    }
  };
  if (event.pointerType === 'touch') timer = setTimeout(start, 300);
  const finish = cancel => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    controller.abort();
    if (cancel && mode === 'sort')
      Tabs.items.sort((a, b) => initial.indexOf(Tabs.key(a)) - initial.indexOf(Tabs.key(b)));
    Tabs.sorting = false;
    tab.classList.remove('sorting');
    if (mode === 'sort') {
      // the tab settles into its place
      const from = tab.getBoundingClientRect().left;
      tab.style.transition = 'none';
      tab.style.transform = '';
      Tabs.render();
      const delta = from - tab.getBoundingClientRect().left;
      if (delta && document.documentElement.dataset.motion !== 'false') {
        tab.style.transform = `translateX(${delta}px)`;
        void tab.offsetWidth;
        tab.style.transition = '';
        tab.style.transform = '';
      } else tab.style.transition = '';
    }
    if (mode) {
      suppressTabClick = true;
      setTimeout(() => (suppressTabClick = false), 0);
      Tabs.save();
      if (mode !== 'sort') Tabs.render();
    }
  };
  window.addEventListener(
    'pointermove',
    move => {
      if (move.pointerId !== event.pointerId) return;
      pointerX = move.clientX;
      const dx = move.clientX - event.clientX;
      if (!mode && Math.hypot(dx, move.clientY - event.clientY) < 6) return;
      if (!mode) {
        clearTimeout(timer);
        if (event.pointerType === 'touch') mode = 'scroll';
        else start();
      }
      move.preventDefault();
      if (mode === 'scroll') {
        bar.scrollLeft = scroll - dx;
        return;
      }
      follow();
      place();
    },
    {signal: controller.signal, passive: false}
  );
  for (const type of ['pointerup', 'pointercancel'])
    window.addEventListener(
      type,
      up => {
        if (up.pointerId === event.pointerId) finish(type === 'pointercancel');
      },
      {signal: controller.signal}
    );
  window.addEventListener(
    'keydown',
    key => {
      if (key.key === 'Escape') {
        key.preventDefault();
        finish(true);
      }
    },
    {signal: controller.signal}
  );
});
