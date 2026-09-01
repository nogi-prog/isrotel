import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { migrate } from './migrate.ts';

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql');

/**
 * מסד דמו שנשמר ב־repo. ה־postbuild מעתיק אותו אל `dist/db/seed.db`, ולכן
 * הוא יושב ליד `schema.sql` גם אחרי ה־build.
 */
const SEED_PATH = process.env.SEED_DB_FILE ?? join(import.meta.dirname, 'seed.db');

export type Db = DatabaseSync;

/**
 * פותח מסד נתונים ומחיל עליו את הסכמה.
 * `:memory:` משמש בטסטים.
 *
 * אם המסד עדיין לא קיים ויש מסד דמו זמין - הוא מועתק פנימה. בסביבה חסרת
 * אחסון קבוע (Vercel, שבה המסד יושב ב-/tmp ונמחק בכל cold start) זה מה
 * שמחזיר את נתוני הדמו בכל הפעלה מחדש.
 *
 * הסכמה מורצת אחר כך (יוצרת טבלאות חסרות), ואחריה המיגרציות שמתקנות
 * טבלאות שכבר היו קיימות - כך מסד קיים מתעדכן בלי לאבד נתונים.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    if (!existsSync(file) && existsSync(SEED_PATH)) copyFileSync(SEED_PATH, file);
  }
  const db = new DatabaseSync(file);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// ב־Vercel מערכת הקבצים לקריאה בלבד פרט ל-/tmp, שגם הוא זמני ונמחק בכל
// cold start. מסד הדמו מועתק לשם מחדש בכל הפעלה (ראו openDatabase).
const DEFAULT_DB_FILE = process.env.VERCEL
  ? '/tmp/trip-organize.db'
  : join(process.cwd(), 'data', 'trip-organize.db');

const DB_FILE = process.env.DB_FILE ?? DEFAULT_DB_FILE;

/** מסד הנתונים של האפליקציה. */
export const db: Db = openDatabase(DB_FILE);

export { DB_FILE };

/** מריץ פעולה בתוך טרנזקציה, עם rollback במקרה של שגיאה. */
export function transaction<T>(database: Db, fn: () => T): T {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** מריץ טרנזקציה על מסד הנתונים הראשי. */
export function tx<T>(fn: () => T): T {
  return transaction(db, fn);
}

/** node:sqlite מחזיר אובייקטים עם prototype null - ממיר לאובייקט רגיל. */
export function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}
