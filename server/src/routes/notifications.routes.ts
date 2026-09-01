import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { requireAuth, requireUser } from '../lib/auth.ts';
import { listNotifications, markAllRead, markRead, unreadCount } from '../lib/notify.ts';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', (req, res) => {
  const user = requireUser(req);
  res.json({
    unread: unreadCount(db, user.id),
    notifications: listNotifications(db, user.id).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      read: row.read_at != null,
      createdAt: row.created_at,
    })),
  });
});

notificationsRouter.post('/read-all', (req, res) => {
  const user = requireUser(req);
  markAllRead(db, user.id);
  res.json({ ok: true });
});

notificationsRouter.post('/:id/read', (req, res) => {
  const user = requireUser(req);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  markRead(db, user.id, id);
  res.json({ ok: true });
});
