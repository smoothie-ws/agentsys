// The notification bell (top right, beside Search): an icon with a dot while the list is not empty; it opens a list of the messages
// kept by `notifications` (backend/routes-notifications.js). Plugins (api.notify) and Scripts (POST notifications) post to it.
'use strict';

const Notifications = {items: [], total: 0, open: false};
async function loadNotifications() {
  const result = await api('notifications', {query: {limit: 100}});
  Notifications.items = result.items;
  Notifications.total = result.total;
  drawNotifications();
}
function drawNotifications() {
  const bell = $('#open-notifications');
  if (!bell) return;
  bell.classList.toggle('has', Notifications.total > 0);
  bell.setAttribute('aria-label', Notifications.total ? `Notifications, ${Notifications.total}` : 'Notifications');
  if (!Notifications.open) return;
  $('#notifications-list').innerHTML = Notifications.items.length
    ? Notifications.items
        .map(
          n =>
            `<div class="notif lvl-${esc(n.level)}" data-id="${esc(n.id)}"><span class="notif-dot" aria-hidden="true"></span>${
              n.href ? `<a class="notif-main" href="${esc(n.href)}" data-link>` : '<div class="notif-main">'
            }<strong>${esc(n.title)}</strong>${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ''}<small class="muted">${esc([when(n.created), n.source].filter(Boolean).join(' · '))}</small>${n.href ? '</a>' : '</div>'}<button type="button" class="icon" data-notif-delete aria-label="Delete notification">${icon('x')}</button></div>`
        )
        .join('')
    : '<p class="muted notif-empty">No notifications.</p>';
  $('#notifications-clear').disabled = !Notifications.items.length;
}
function setNotificationsOpen(open) {
  Notifications.open = open;
  const panel = $('#notifications-panel');
  panel.inert = !open;
  panel.classList.toggle('open', open);
  $('#open-notifications').setAttribute('aria-expanded', String(open));
  if (open) loadNotifications().catch(fail);
}
const notificationAction = (path, options) => api(path, options).then(loadNotifications).catch(fail);
document.addEventListener('click', event => {
  const bell = event.target.closest('#open-notifications');
  if (bell) return setNotificationsOpen(!Notifications.open);
  if (!Notifications.open) return;
  const inside = event.target.closest('#notifications-panel');
  if (!inside) return setNotificationsOpen(false);
  if (event.target.closest('#notifications-close')) {
    setNotificationsOpen(false);
    $('#open-notifications').focus();
    return;
  }
  const row = event.target.closest('.notif');
  if (event.target.closest('#notifications-clear')) return notificationAction('notifications', {method: 'DELETE'});
  if (!row) return;
  if (event.target.closest('[data-notif-delete]'))
    return notificationAction('notifications/' + row.dataset.id, {method: 'DELETE'});
  if (event.target.closest('a')) setNotificationsOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && Notifications.open) {
    setNotificationsOpen(false);
    $('#open-notifications').focus();
  }
});
Environment.subscribe(keys => {
  if (keys.includes('notifications')) loadNotifications().catch(() => {});
});
document.addEventListener('DOMContentLoaded', () => setTimeout(() => loadNotifications().catch(() => {}), 0));
