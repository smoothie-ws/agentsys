// Notifications: a list of messages for the person (the bell at the top right). Plugins (api.notify) and
// workflows post to it, through POST notifications (the capability `notifications.write`). A notification is a short title, an optional text,
// a level and an optional link to a page of the app.
'use strict';

const NOTIFICATIONS = 'notifications';
const NOTIFICATION = {max: 200, title: 200, body: 2000, levels: ['info', 'success', 'warn', 'error']};

const notificationList = c => c.ctx.get(NOTIFICATIONS, []);
function newNotification(input) {
  const text = (value, label, max, min = 0) => {
    if (typeof value !== 'string' || value.trim().length < min || value.length > max)
      throw bad(`${label} must be text of ${min ? `${min} to ` : 'at most '}${max} characters`);
    return value;
  };
  const level = input.level ?? 'info';
  if (!NOTIFICATION.levels.includes(level)) throw bad(`level is one of ${NOTIFICATION.levels.join(', ')}`);
  if (
    input.href !== undefined &&
    (typeof input.href !== 'string' || !/^\/(?!\/)[A-Za-z0-9_\-/?=&%.]{0,198}$/.test(input.href))
  )
    throw bad('href is a page of the app, like /projects');
  return {
    id: uid(),
    title: text(input.title, 'title', NOTIFICATION.title, 1).trim(),
    body: text(input.body ?? '', 'body', NOTIFICATION.body),
    level,
    href: input.href ?? '',
    source: text(input.source ?? '', 'source', 100),
    created: Date.now() / 1000,
  };
}
route(
  'GET POST DELETE',
  'notifications',
  'List notifications (newest first), post one, or clear them all',
  async c => {
    const items = await notificationList(c);
    if (c.method === 'GET') {
      const limit = Math.min(Math.max(Number(c.query.limit) || 50, 1), NOTIFICATION.max);
      return {total: items.length, items: [...items].reverse().slice(0, limit)};
    }
    if (c.method === 'POST') {
      const item = newNotification(c.body);
      c.ctx.set(NOTIFICATIONS, [...items, item].slice(-NOTIFICATION.max));
      return item;
    }
    c.ctx.set(NOTIFICATIONS, []);
    return {deleted: items.length};
  },
  {
    body: {
      title: 'Backup finished',
      body: 'optional text',
      level: 'info|success|warn|error',
      href: '/projects',
      source: 'optional',
    },
    query: ['limit'],
  }
);
route('DELETE', 'notifications/{id}', 'Delete one notification', async (c, {id}) => {
  const items = await notificationList(c);
  if (!items.some(n => n.id === id)) throw missing('Notification not found');
  c.ctx.set(
    NOTIFICATIONS,
    items.filter(n => n.id !== id)
  );
  return {deleted: id};
});
