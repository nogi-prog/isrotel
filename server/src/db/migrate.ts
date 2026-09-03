/**
 * מיגרציות אידמפוטנטיות למסדי נתונים שנוצרו לפני שינוי סכמה.
 * `schema.sql` מטפל במסד חדש; כאן מטופל מסד קיים, כדי לא לאבד נתונים.
 */
import { cycleName } from '../types.ts';
import type { Db } from './index.ts';

function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: Db, table: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row != null;
}

/** הגדרת הטבלה כפי שהיא רשומה ב-sqlite_master, או null אם אינה קיימת. */
function tableSql(db: Db, table: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? null;
}

/**
 * הסרת אילוץ ה-CHECK מעמודת users.role.
 *
 * הטבלה נוצרה עם `CHECK (role IN (...))`, ו-SQLite אינו מאפשר לשנות CHECK
 * בטבלה קיימת - כל הוספת תפקיד חייבה בנייה מחדש של הטבלה, וזה כבר קרה
 * פעמיים (האופרטיבי, ואחריו המפמ״ר). מכאן התפקידים נבדקים בקצה בלבד (Zod
 * ואיחוד הטיפוסים Role), ולטבלה אין CHECK על role.
 *
 * הבנייה מחדש היא הנוהל בן 12 השלבים של SQLite, ומוגנת כך שתרוץ פעם אחת:
 *   1. זיהוי: האם הגדרת הטבלה ב-sqlite_master עדיין מכילה CHECK על role
 *   2. PRAGMA foreign_keys = OFF - אי אפשר לשנות בתוך טרנזקציה
 *   3. BEGIN
 *   4. יצירת users_new בהגדרה החדשה, בלי CHECK על role
 *   5. העברת התוכן, תוך שמירה על כל המזהים - טבלאות הילדים מצביעות אליהם
 *   6. DROP TABLE users
 *   7. ALTER TABLE users_new RENAME TO users
 *   8. יצירת האינדקסים מחדש
 *   9. COMMIT
 *  10. PRAGMA foreign_keys = ON
 *  11. PRAGMA foreign_key_check - אימות שאף הצבעה לא נשברה
 *  12. דיווח בעברית
 */
function dropUsersRoleCheck(db: Db): void {
  // 1. זיהוי
  const sql = tableSql(db, 'users');
  if (sql == null || !/CHECK\s*\(\s*role\s+IN/i.test(sql)) return;

  console.log('[migrate] users.role: מתחילה בנייה מחדש של הטבלה להסרת אילוץ ה-CHECK');

  const before = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;

  // 2. אי אפשר לשנות PRAGMA foreign_keys בתוך טרנזקציה
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN'); // 3

    // 4. אותה הגדרה כמו ב-schema.sql, בלי CHECK על role
    db.exec(`CREATE TABLE users_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id   TEXT    NOT NULL UNIQUE CHECK (length(company_id) = 7 AND company_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
      first_name   TEXT    NOT NULL,
      last_name    TEXT    NOT NULL,
      gender       TEXT    NOT NULL CHECK (gender IN ('male', 'female')),
      role         TEXT    NOT NULL,
      diet         TEXT    NOT NULL CHECK (diet IN ('all', 'vegetarian', 'vegan')),
      manager_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      unit_name    TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at  TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )`);

    // 5. המזהים נשמרים כפי שהם
    db.exec(`INSERT INTO users_new
               (id, company_id, first_name, last_name, gender, role, diet,
                manager_id, unit_name, status, approved_by, approved_at, created_at)
             SELECT id, company_id, first_name, last_name, gender, role, diet,
                    manager_id, unit_name, status, approved_by, approved_at, created_at
               FROM users`);

    db.exec('DROP TABLE users'); // 6
    db.exec('ALTER TABLE users_new RENAME TO users'); // 7

    // 8. האינדקסים ירדו יחד עם הטבלה
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status)');

    db.exec('COMMIT'); // 9
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }

  db.exec('PRAGMA foreign_keys = ON'); // 10

  // 11. אימות המפתחות הזרים אחרי הבנייה מחדש
  const broken = db.prepare('PRAGMA foreign_key_check').all();

  // 12. דיווח
  const after = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  console.log(`[migrate] users.role: אילוץ ה-CHECK הוסר, ${after} משתמשים הועברו (היו ${before})`);
  if (broken.length > 0) {
    console.error(
      `[migrate] אזהרה: PRAGMA foreign_key_check מדווח על ${broken.length} הצבעות שבורות אחרי בניית users מחדש:`,
      JSON.stringify(broken),
    );
  }
}

export function migrate(db: Db): void {
  // קודם כל: הסרת אילוץ ה-CHECK מ-users.role, כדי שתפקידים חדשים
  // (אופרטיבי, מפמ״ר) ייכנסו למסד קיים.
  if (tableExists(db, 'users')) dropUsersRoleCheck(db);

  if (!tableExists(db, 'trips')) return; // מסד חדש - schema.sql כבר יצר את הכל

  const tripColumns = columns(db, 'trips');

  // trips.status -> trips.state (מכונת מצבים; המצב הראשון הוא LAUNCHED)
  if (!tripColumns.has('state')) {
    db.exec("ALTER TABLE trips ADD COLUMN state TEXT NOT NULL DEFAULT 'LAUNCHED'");
    if (tripColumns.has('status')) {
      db.exec("UPDATE trips SET state = CASE status WHEN 'closed' THEN 'CLOSED' ELSE 'LAUNCHED' END");
    }
    console.log('[migrate] trips.state נוסף');
  }
  if (tripColumns.has('status')) {
    db.exec('ALTER TABLE trips DROP COLUMN status');
    console.log('[migrate] trips.status הוסר');
  }
  if (!tripColumns.has('leaders_notified_at')) {
    db.exec('ALTER TABLE trips ADD COLUMN leaders_notified_at TEXT');
    console.log('[migrate] trips.leaders_notified_at נוסף');
  }

  // הגשת הגלישה על ידי האופרטיבי - מכאן רשימת המשתתפים קפואה.
  if (!tripColumns.has('submitted_at')) {
    db.exec('ALTER TABLE trips ADD COLUMN submitted_at TEXT');
    console.log('[migrate] trips.submitted_at נוסף');
  }

  // trip_submissions (הגשת רשימה של מפקד) נוצרת ב-schema.sql, שמורץ עם
  // CREATE TABLE IF NOT EXISTS בכל פתיחה של המסד - ולכן אין מה להשלים כאן.

  // תאריך פרסום הגלישה. לגלישות קיימות - יום היצירה.
  if (!tripColumns.has('launch_date')) {
    db.exec("ALTER TABLE trips ADD COLUMN launch_date TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE trips SET launch_date = date(created_at) WHERE launch_date = ''");
    console.log('[migrate] trips.launch_date נוסף');
  }

  // האופרטיבי אינו מזין שם ויעד - השדות האלה הוסרו.
  for (const column of ['description', 'location']) {
    if (tripColumns.has(column)) {
      db.exec(`ALTER TABLE trips DROP COLUMN ${column}`);
      console.log(`[migrate] trips.${column} הוסר`);
    }
  }

  // לגלישה קיים - כל הרמ״דים (כולל האופרטיבי) והרת״חים נחשבים כמי שקיבלו את משימת השיבוץ.
  const backfilled = db
    .prepare(
      `INSERT OR IGNORE INTO trip_leaders (trip_id, manager_id)
       SELECT t.id, u.id
         FROM trips t
         JOIN users u ON u.status = 'approved' AND u.role IN ('sector_leader', 'division_leader', 'to')
        WHERE NOT EXISTS (SELECT 1 FROM trip_leaders tl WHERE tl.trip_id = t.id)`,
    )
    .run();
  if (backfilled.changes > 0) {
    console.log(`[migrate] הושלמו ${backfilled.changes} שיוכי מפקדים לגלישות קיימות`);
  }

  // הפעימה היא גל יציאה של יום אחד - תאריך החזרה הוסר מהמערכת.
  if (tableExists(db, 'cycles') && columns(db, 'cycles').has('return_date')) {
    db.exec('ALTER TABLE cycles DROP COLUMN return_date');
    console.log('[migrate] cycles.return_date הוסר');
  }

  // האופרטיבי יכול לתת שם משלו לפעימה - ראו ההסבר ב-schema.sql וב-renumberCycles.
  if (tableExists(db, 'cycles') && !columns(db, 'cycles').has('custom_name')) {
    db.exec('ALTER TABLE cycles ADD COLUMN custom_name INTEGER NOT NULL DEFAULT 0 CHECK (custom_name IN (0, 1))');
    console.log('[migrate] cycles.custom_name נוסף');
  }

  // שמות הפעימות אינם מוזנים יותר אלא נגזרים מסדר היציאה: הפעימה הראשונה
  // היא "חלוץ" ואחריה "פעימה 1". פעימות שנוצרו עם שם ידני מקבלות את השם החדש.
  if (tableExists(db, 'cycles')) {
    const rows = db
      .prepare('SELECT id, trip_id, name FROM cycles ORDER BY trip_id, exit_date, id')
      .all() as Array<{ id: number; trip_id: number; name: string }>;
    const rename = db.prepare('UPDATE cycles SET name = ? WHERE id = ?');
    let renamed = 0;
    let index = 0;
    let currentTrip: number | null = null;
    for (const row of rows) {
      if (row.trip_id !== currentTrip) {
        currentTrip = row.trip_id;
        index = 0;
      }
      const name = cycleName(index);
      if (row.name !== name) {
        rename.run(name, row.id);
        renamed += 1;
      }
      index += 1;
    }
    if (renamed > 0) console.log(`[migrate] ${renamed} פעימות קיבלו שם לפי סדר היציאה`);
  }

  // signups.created_by - מי שיבץ את האדם לגלישה
  if (tableExists(db, 'signups') && !columns(db, 'signups').has('created_by')) {
    db.exec('ALTER TABLE signups ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    // הרשמות שנוצרו לפני השינוי היו הרשמה עצמית.
    db.exec('UPDATE signups SET created_by = user_id WHERE created_by IS NULL');
    console.log('[migrate] signups.created_by נוסף');
  }

  // הגעה ברכב פרטי - ראו ההסבר ב-schema.sql ליד signups.
  if (tableExists(db, 'signups') && !columns(db, 'signups').has('car_status')) {
    db.exec(
      `ALTER TABLE signups ADD COLUMN car_status TEXT NOT NULL DEFAULT 'none'
         CHECK (car_status IN ('none', 'pending', 'approved', 'rejected'))`,
    );
    db.exec('ALTER TABLE signups ADD COLUMN car_passenger_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    db.exec('ALTER TABLE signups ADD COLUMN car_decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    db.exec('ALTER TABLE signups ADD COLUMN car_decided_at TEXT');
    db.exec('ALTER TABLE signups ADD COLUMN car_decision_note TEXT');
    console.log('[migrate] signups.car_status ועמודות הרכב הפרטי נוספו');
  }

  // אישור האופרטיבי - שכבה נוספת מעל אישור המפקד, ראו ההסבר ב-schema.sql.
  if (tableExists(db, 'signups') && !columns(db, 'signups').has('to_approved_at')) {
    db.exec('ALTER TABLE signups ADD COLUMN to_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    db.exec('ALTER TABLE signups ADD COLUMN to_approved_at TEXT');
    console.log('[migrate] signups.to_approved_at/to_approved_by נוספו');
  }

  // רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - ראו ההסבר ב-schema.sql וב-lib/cars.ts.
  if (tableExists(db, 'users') && !columns(db, 'users').has('car_plate')) {
    db.exec(
      `ALTER TABLE users ADD COLUMN car_plate TEXT
         CHECK (car_plate IS NULL OR (length(car_plate) BETWEEN 7 AND 8 AND car_plate NOT GLOB '*[^0-9]*'))`,
    );
    console.log('[migrate] users.car_plate נוסף');
  }

  // חיילים-לשעבר: מושאל (הצ״ח) או מילואים - ראו ההסבר ב-schema.sql וב-POST /users/ex-workers.
  if (tableExists(db, 'users') && !columns(db, 'users').has('worker_type')) {
    db.exec(
      `ALTER TABLE users ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'regular'
         CHECK (worker_type IN ('regular', 'borrowed', 'reserve'))`,
    );
    db.exec('ALTER TABLE users ADD COLUMN borrowed_from TEXT');
    console.log('[migrate] users.worker_type ו-borrowed_from נוספו');
  }

  // המשימה שבשבילה מבקשים את ההשאלה של חייל מושאל (הצ״ח) - ראו ההסבר ב-schema.sql.
  if (tableExists(db, 'users') && !columns(db, 'users').has('borrowed_mission')) {
    db.exec('ALTER TABLE users ADD COLUMN borrowed_mission TEXT');
    console.log('[migrate] users.borrowed_mission נוסף');
  }

  // אימות בסיסמה - ראו ההסבר ב-schema.sql וב-lib/password.ts. חשבונות שנוצרו
  // לפני השינוי מקבלים password_hash = NULL, וההתחברות שלהם חסומה עד איפוס
  // על ידי האופרטיבי (בדיוק כמו "שכחתי סיסמה" רגיל).
  if (tableExists(db, 'users') && !columns(db, 'users').has('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    db.exec(
      'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))',
    );
    console.log('[migrate] users.password_hash ו-must_change_password נוספו');
  }

  // טלפון ואלרגיות - ראו ההסבר ב-schema.sql. אלרגיות בברירת מחדל 'ללא'
  // גם למשתמשים קיימים, כדי שלא יישארו ריקים בדוחות.
  if (tableExists(db, 'users') && !columns(db, 'users').has('phone')) {
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    console.log('[migrate] users.phone נוסף');
  }
  if (tableExists(db, 'users') && !columns(db, 'users').has('allergies')) {
    db.exec("ALTER TABLE users ADD COLUMN allergies TEXT NOT NULL DEFAULT 'ללא'");
    console.log('[migrate] users.allergies נוסף');
  }

  // אותם שדות בבקשות עדכון פרופיל - ראו ההסבר ב-schema.sql.
  if (tableExists(db, 'profile_edits') && !columns(db, 'profile_edits').has('phone')) {
    db.exec('ALTER TABLE profile_edits ADD COLUMN phone TEXT');
    console.log('[migrate] profile_edits.phone נוסף');
  }
  if (tableExists(db, 'profile_edits') && !columns(db, 'profile_edits').has('allergies')) {
    db.exec("ALTER TABLE profile_edits ADD COLUMN allergies TEXT NOT NULL DEFAULT 'ללא'");
    console.log('[migrate] profile_edits.allergies נוסף');
  }
  if (tableExists(db, 'profile_edits') && !columns(db, 'profile_edits').has('worker_type')) {
    db.exec(
      `ALTER TABLE profile_edits ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'regular'
         CHECK (worker_type IN ('regular', 'borrowed', 'reserve'))`,
    );
    db.exec('ALTER TABLE profile_edits ADD COLUMN borrowed_from TEXT');
    db.exec('ALTER TABLE profile_edits ADD COLUMN borrowed_mission TEXT');
    console.log('[migrate] profile_edits.worker_type/borrowed_from/borrowed_mission נוספו');
  }

  // פירוט תורנות - ראו ההסבר ב-schema.sql.
  if (tableExists(db, 'shift_reports') && !columns(db, 'shift_reports').has('duty_type')) {
    db.exec('ALTER TABLE shift_reports ADD COLUMN duty_type TEXT');
    db.exec('ALTER TABLE shift_reports ADD COLUMN duty_location TEXT');
    db.exec('ALTER TABLE shift_reports ADD COLUMN duty_dates TEXT');
    db.exec('ALTER TABLE shift_reports ADD COLUMN handling_status TEXT');
    console.log('[migrate] shift_reports.duty_type/duty_location/duty_dates/handling_status נוספו');
  }

  // קמב״צים: חיילים בודדים עם הרשאת שיבוץ שקולה לרת״ח שנבחר - ראו ההסבר ב-schema.sql.
  if (!tableExists(db, 'trip_kmbatz')) {
    db.exec(`CREATE TABLE trip_kmbatz (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      leader_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (trip_id, user_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trip_kmbatz_trip ON trip_kmbatz(trip_id)');
    console.log('[migrate] trip_kmbatz נוצרה');
  }
}
