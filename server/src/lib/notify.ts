import type { Db } from '../db/index.ts';
import { plain } from '../db/index.ts';

export interface NotificationInput {
  userId: number;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

export interface NotificationRow {
  id: number;
  user_id: number;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/** יוצר התראה למשתמש. */
export function notify(db: Db, input: NotificationInput): void {
  db.prepare('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)').run(
    input.userId,
    input.kind,
    input.title,
    input.body ?? null,
    input.link ?? null,
  );
}

/** יוצר התראה זהה לכמה משתמשים. */
export function notifyMany(db: Db, userIds: Iterable<number>, input: Omit<NotificationInput, 'userId'>): void {
  for (const userId of userIds) notify(db, { ...input, userId });
}

export function listNotifications(db: Db, userId: number, limit = 50): NotificationRow[] {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, limit)
    .map((row) => plain<NotificationRow>(row));
}

export function unreadCount(db: Db, userId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function markAllRead(db: Db, userId: number): void {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(userId);
}

export function markRead(db: Db, userId: number, notificationId: number): void {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ?").run(
    userId,
    notificationId,
  );
}
