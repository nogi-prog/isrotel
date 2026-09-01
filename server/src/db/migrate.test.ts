/**
 * טסט למיגרציה שבונה מחדש את טבלת users כדי להסיר את אילוץ ה-CHECK מ-role.
 * זו המיגרציה המסוכנת היחידה במערכת: היא מוחקת טבלה ויוצרת אותה מחדש, ועובדת
 * על מסד אמיתי עם משתמשים. לכן היא נבדקת על קובץ זמני שנבנה בדיוק כמו המסד
 * הישן - כולל טבלת ילד שמצביעה על המשתמשים - ולא על מסד בזיכרון.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { migrate } = await import('./migrate.ts');

const dir = mkdtempSync(join(tmpdir(), 'trip-organize-migrate-'));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** מסד בהגדרה הישנה: users עם CHECK על role, וטבלת ילד שמצביעה אליו. */
function legacyDatabase(name: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, name));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   TEXT    NOT NULL UNIQUE,
    first_name   TEXT    NOT NULL,
    last_name    TEXT    NOT NULL,
    gender       TEXT    NOT NULL CHECK (gender IN ('male', 'female')),
    role         TEXT    NOT NULL CHECK (role IN ('employee', 'team_leader', 'sector_leader', 'division_leader', 'to')),
    diet         TEXT    NOT NULL CHECK (diet IN ('all', 'vegetarian', 'vegan')),
    manager_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    unit_name    TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at  TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX idx_users_manager ON users(manager_id)');
  db.exec('CREATE INDEX idx_users_status ON users(status)');

  // טבלת ילד שמצביעה על users - כמו signups/notifications במסד האמיתי.
  db.exec(`CREATE TABLE notes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body    TEXT    NOT NULL
  )`);

  const insert = db.prepare(
    `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, manager_id, unit_name, status, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', '2026-01-01 08:00:00') RETURNING id`,
  );
  const managerId = (
    insert.get('1000001', 'דנה', 'לוי', 'female', 'sector_leader', 'all', null, 'מדור תוכנה') as { id: number }
  ).id;
  const soldierId = (
    insert.get('2000001', 'יונתן', 'ברק', 'male', 'employee', 'vegan', managerId, null) as { id: number }
  ).id;
  db.prepare('INSERT INTO notes (user_id, body) VALUES (?, ?)').run(soldierId, 'שורה תלויה');
  return db;
}

const foreignKeyProblems = (db: DatabaseSync): unknown[] => db.prepare('PRAGMA foreign_key_check').all();
const usersSql = (db: DatabaseSync): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string }).sql;
const indexNames = (db: DatabaseSync): string[] =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();

describe('מיגרציית users.role', () => {
  test('מסירה את ה-CHECK, שומרת את הנתונים ומאפשרת תפקיד מפמ״ר', () => {
    const db = legacyDatabase('legacy.db');

    // לפני המיגרציה - התפקיד החדש נדחה על ידי ה-CHECK.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, status)
             VALUES ('9000001', 'נעמה', 'בן-ארי', 'female', 'ceo', 'all', 'approved')`,
          )
          .run(),
      /CHECK constraint failed/,
    );

    const before = db.prepare('SELECT id, company_id, role, manager_id FROM users ORDER BY id').all();
    const indexesBefore = indexNames(db);

    migrate(db);

    // ה-CHECK על role ירד, ושל gender/diet/status נשארו.
    const sql = usersSql(db);
    assert.doesNotMatch(sql, /CHECK\s*\(\s*role\s+IN/i);
    assert.match(sql, /gender IN/);
    assert.match(sql, /diet IN/);
    assert.match(sql, /status IN/);

    // הנתונים והמזהים נשמרו בדיוק, ולכן טבלאות הילדים ממשיכות להצביע נכון.
    assert.deepEqual(db.prepare('SELECT id, company_id, role, manager_id FROM users ORDER BY id').all(), before);
    assert.deepEqual(indexNames(db), indexesBefore);
    assert.deepEqual(foreignKeyProblems(db), []);
    const note = db.prepare('SELECT user_id FROM notes').get() as { user_id: number };
    assert.equal(note.user_id, (before[1] as { id: number }).id);

    // ועכשיו המפמ״ר נכנס.
    db.prepare(
      `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, status)
       VALUES ('9000001', 'נעמה', 'בן-ארי', 'female', 'ceo', 'all', 'approved')`,
    ).run();
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'ceo'").get() as { c: number }).c,
      1,
    );

    // המפתחות הזרים חזרו לפעול אחרי הבנייה מחדש.
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    db.close();
  });

  test('רצה פעם אחת בלבד - הרצה שנייה אינה משנה דבר', () => {
    const db = legacyDatabase('idempotent.db');

    migrate(db);
    const sqlAfterFirst = usersSql(db);
    const rowsAfterFirst = db.prepare('SELECT * FROM users ORDER BY id').all();

    migrate(db);
    assert.equal(usersSql(db), sqlAfterFirst, 'ההרצה השנייה בנתה את הטבלה מחדש');
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), rowsAfterFirst);
    assert.deepEqual(foreignKeyProblems(db), []);
    db.close();
  });
});
