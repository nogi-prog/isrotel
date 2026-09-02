-- ===========================================================================
-- trip-organize :: סכמת מסד הנתונים
-- ---------------------------------------------------------------------------
-- ההיררכיה הארגונית נגזרת משרשרת המפקדים (manager_id):
--   חייל -> ר״צ -> רמ״ד / אופרטיבי -> רת״ח -> מפמ״ר
-- "המדור" של אדם = האב הקרוב ביותר בשרשרת שתפקידו רמ״ד או אופרטיבי (או הוא
-- עצמו) - לאופרטיבי מדור משלו, מלבד היותו מנהל המערכת.
-- המפמ״ר הוא ראש השרשרת ולכן המפקד של כל אנשי החברה, דרך הרת״חים.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- משתמשים -------------------------------------------------------------------
-- על role אין CHECK בכוונה: התפקידים נבדקים בקצה על ידי Zod ועל ידי איחוד
-- הטיפוסים Role ב-types.ts. CHECK כאן היה מחייב בנייה מחדש של הטבלה בכל
-- הוספת תפקיד (SQLite אינו מאפשר לשנות CHECK בטבלה קיימת) - וזה כבר קרה
-- פעמיים, עם האופרטיבי ועם המפמ״ר. ה-CHECK על gender, diet ו-status נשאר,
-- כי אלה קבוצות ערכים סגורות ויציבות.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT    NOT NULL UNIQUE CHECK (length(company_id) = 7 AND company_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  first_name   TEXT    NOT NULL,
  last_name    TEXT    NOT NULL,
  gender       TEXT    NOT NULL CHECK (gender IN ('male', 'female')),
  role         TEXT    NOT NULL,  -- נבדק ב-Zod ובטיפוס Role, ולא ב-CHECK (ראה ההסבר מעל)
  diet         TEXT    NOT NULL CHECK (diet IN ('all', 'vegetarian', 'vegan')),
  manager_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unit_name    TEXT,                      -- שם היחידה שהמשתמש מפקד עליה (למפקדים בלבד)
  phone        TEXT,                      -- מספר טלפון ליצירת קשר
  allergies    TEXT    NOT NULL DEFAULT 'ללא',  -- אלרגיות מזון - 'ללא' כברירת מחדל כשלא הוזן
  -- מספר רכב, 7-8 ספרות: רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם, ושולטים
  -- בשדה הזה בעצמם בפרופיל - ראו lib/cars.ts.
  car_plate    TEXT    CHECK (car_plate IS NULL OR (length(car_plate) BETWEEN 7 AND 8 AND car_plate NOT GLOB '*[^0-9]*')),
  -- חייל-לשעבר: מושאל (הצ״ח, מגיע מיחידה אחרת - ראו borrowed_from) או
  -- מילואים. חייל רגיל הוא 'regular'. ראו POST /users/ex-workers.
  worker_type      TEXT    NOT NULL DEFAULT 'regular' CHECK (worker_type IN ('regular', 'borrowed', 'reserve')),
  borrowed_from    TEXT,
  -- המשימה שבשבילה מבקשים את ההשאלה - רלוונטי רק כש-worker_type = 'borrowed'.
  borrowed_mission TEXT,
  -- גיבוב הסיסמה (scrypt, מלוח ומעוגן - ראו lib/password.ts). NULL = טרם
  -- הוגדרה סיסמה (חשבון שנוצר לפני הוספת האימות בסיסמה) - ההתחברות חסומה
  -- עד שהאופרטיבי מאפס עבור המשתמש, בדיוק כמו איפוס רגיל (ראו forgot-password).
  password_hash TEXT,
  -- נדלק אחרי איפוס סיסמה על ידי האופרטיבי: מחייב את המשתמש להחליף לסיסמה
  -- קבועה משלו מיד אחרי הכניסה עם הסיסמה הזמנית, לפני המשך שימוש במערכת.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);

-- מפמ״ר ואופרטיבי הם תפקידים ייחודיים בחברה - לכל היותר אחד מכל אחד מהם.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_singleton_ceo_to ON users(role) WHERE role IN ('ceo', 'to');

-- בקשות איפוס סיסמה --------------------------------------------------------
-- "שכחתי סיסמה": המשתמש מבקש איפוס, והבקשה ממתינה לאופרטיבי (לא למפקד -
-- זו סמכות ניהול מערכת, לא סמכות ארגונית). האופרטיבי מאפס ומקבל סיסמה
-- זמנית להעביר למשתמש מחוץ למערכת (בעל פה / פנים אל פנים) - הסיסמה הזמנית
-- עצמה אינה נשמרת בשום מקום בטקסט גלוי, רק הגיבוב שלה ב-users.password_hash.
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  requested_at TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TEXT
);

-- בקשה ממתינה אחת בלבד לכל משתמש בכל רגע נתון - כמו profile_edits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_resets_one_pending
  ON password_reset_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_password_resets_status ON password_reset_requests(status);

-- בקשות עדכון פרופיל ---------------------------------------------------------
-- עדכון פרטים אישיים ביוזמת המשתמש עצמו עובר את אותו תהליך אישור כמו הרשמה
-- ראשונית: השינוי מוצע כאן וממתין למפקד (assertCanManage ב-users.routes.ts),
-- ומוחל על users רק כשהוא מאושר. מפקד שעורך ישירות את הפרטים של כפיף (גם
-- דרך users.routes.ts) לא עובר דרך הטבלה הזאת - הוא כבר בעל הסמכות לאשר.
-- company_id, role ו-manager_id אינם ניתנים לעריכה כאן - אלה שדות זהות/ניהול.
CREATE TABLE IF NOT EXISTS profile_edits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  gender        TEXT    NOT NULL CHECK (gender IN ('male', 'female')),
  diet          TEXT    NOT NULL CHECK (diet IN ('all', 'vegetarian', 'vegan')),
  unit_name     TEXT,
  phone         TEXT,
  allergies     TEXT    NOT NULL DEFAULT 'ללא',
  -- ראו users.worker_type - עדכון עצמי (לחייל) עובר גם הוא דרך אישור המפקד.
  worker_type      TEXT NOT NULL DEFAULT 'regular' CHECK (worker_type IN ('regular', 'borrowed', 'reserve')),
  borrowed_from    TEXT,
  borrowed_mission TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- בקשה ממתינה אחת בלבד לכל משתמש בכל רגע נתון.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_edits_one_pending
  ON profile_edits(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_profile_edits_status ON profile_edits(status);

-- בקשות העברה בהיררכיה ---------------------------------------------------
-- מפקד מבקש להעביר כפיף שלו למפקד אחר בעץ הארגוני. אם המפקד היעד נמצא
-- מחוץ לשרשרת הפיקוד של המבקש (הוא אינו המבקש עצמו ואינו כפוף לו), ההעברה
-- ממתינה לאישור המפקד היעד - בדיוק כמו בקשת רישום. אם המפקד היעד נמצא
-- בתוך השרשרת של המבקש, ההעברה חלה מיד (users.routes.ts, applyMove).
-- successor_id הוא מי שממלא את מקומו של המועבר ביחידה הישנה שלו, נדרש רק
-- כשלמועבר יש כפיפים משלו (הוא מפקד יחידה, לא רק חייל).
CREATE TABLE IF NOT EXISTS move_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_manager_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  successor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TEXT,
  decision_note   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_move_requests_one_pending
  ON move_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_move_requests_status ON move_requests(status);

-- העדפות שותפים קבועות (ברמת המשתמש) ---------------------------------------
-- "עם מי הייתי רוצה לישון" באופן כללי, לא לגלישה מסוימת: נשאל (לא חובה) בהרשמה
-- וניתן לעריכה במסך הפרופיל. ההעדפות האלה מזינות כברירת מחדל את העדפות
-- הלינה של כל גלישה (dorm_preferences) כשהמשתמש לא בחר העדפות ספציפיות לגלישה
-- ההוא - ראו loadCycleParticipants ב-lib/trips.ts.
-- האילוצים הקשיחים (אותו מין, אותה קבוצת דרגה) נאכפים בשכבת ה-API דרך
-- checkRoommateEligibility, ובכל מקרה מנוע השיבוץ מתעלם מהעדפה שאינה במאגר.
CREATE TABLE IF NOT EXISTS user_roommate_preferences (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferred_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  UNIQUE (user_id, preferred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roommate_prefs_user ON user_roommate_preferences(user_id);

-- גלישות --------------------------------------------------------------------
-- מכונת המצבים של הגלישה. המצב הראשון הוא LAUNCHED, ונקבע כשהאופרטיבי יוצר גלישה.
-- ב-LAUNCHED הפעולה היחידה של האופרטיבי היא להודיע לרמ״דים ולרת״חים שעליהם לשבץ
-- את האנשים שלהם. המצבים שאחריו יוגדרו בהמשך; CLOSED הוא מצב סופי.
-- האופרטיבי אינו מזין שם או יעד: השם נוצר אוטומטית ("גלישה #1"), והשדות
-- היחידות שהוא בוחר הן תאריך הפרסום והמפקדים שקיבלו את משימת השיבוץ.
CREATE TABLE IF NOT EXISTS trips (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  state                TEXT    NOT NULL DEFAULT 'LAUNCHED' CHECK (state IN ('LAUNCHED', 'CLOSED')),
  launch_date          TEXT    NOT NULL,
  bus_capacity         INTEGER NOT NULL DEFAULT 50 CHECK (bus_capacity > 0),
  leaders_notified_at  TEXT,
  buses_locked_at      TEXT,
  dorms_locked_at      TEXT,
  -- הרגע שבו האופרטיבי הגיש את הגלישה. מכאן רשימת המשתתפים קפואה לכולם:
  -- אי אפשר להוסיף או להסיר אנשים, אבל כן אפשר להשלים פרטים אישיים
  -- (שותפים לחדר ותזונה), כי שיבוץ הלינה מתבצע אחרי ההגשה.
  submitted_at         TEXT,
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- המפקדים שקיבלו את המשימה לשבץ את האנשים שלהם בגלישה.
-- רק מי שנמצא כאן (או מי שקיבל מהם האצלה) רשאי לשבץ.
CREATE TABLE IF NOT EXISTS trip_leaders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, manager_id)
);

-- הגשת רשימת האנשים על ידי מפקד ------------------------------------------
-- מפקד עם הרשאת שיבוץ מצהיר שסיים לשבץ את האנשים שלו. קיום שורה = הרשימה הוגשה.
-- ההגשה אינה נועלת: אם אדם חדש מאושר ליחידה שלו אחרי ההגשה, הוא מקבל התראה
-- ורשאי להוסיף אותו לגלישה - עד שהאופרטיבי מגיש את הגלישה (trips.submitted_at).
CREATE TABLE IF NOT EXISTS trip_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  manager_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- רזולוציית מילישנייה: מכאן נגזר מי אושר ליחידה אחרי ההגשה (NOW_MS ב-types.ts).
  submitted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  UNIQUE (trip_id, manager_id)
);

-- פעימות יציאה --------------------------------------------------------------
-- השם נגזר מסדר היציאה ואינו מוזן: הראשונה "חלוץ", ואחריה "פעימה 1" וכן הלאה.
-- הפעימה היא גל יציאה של יום אחד; אין תאריך חזרה.
CREATE TABLE IF NOT EXISTS cycles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  exit_date   TEXT    NOT NULL,
  -- כשהאופרטיבי בוחר שם משלו ל-name, custom_name=1 - renumberCycles (lib/trips.ts)
  -- מדלג על פעימה כזאת ולא דורס את השם בסידור מחדש לפי תאריך.
  custom_name INTEGER NOT NULL DEFAULT 0 CHECK (custom_name IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cycles_trip ON cycles(trip_id);

-- הרשמות לגלישה -------------------------------------------------------------
-- חייל אינו משבץ את עצמו: המפקד הוא שמשבץ אותו (created_by).
-- רמ״ד/רת״ח שמשבץ בעצמו -> 'approved' מיד. ר״צ שקיבל האצלה -> 'pending',
-- והרמ״ד מאשר בהמשך.
-- הגעה ברכב פרטי -----------------------------------------------------------
-- רמ״ד ורת״ח רשאים להביא רכב פרטי בלי אישור; כל תפקיד אחר ממתין לאישור
-- הרת״ח הקרוב ביותר בשרשרת שלו (או האופרטיבי, אם אין רת״ח בשרשרת - כמו
-- אישור רישום ראש שרשרת). לכל רכב נהג ונוסע אחד לכל היותר.
CREATE TABLE IF NOT EXISTS signups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id             INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  cycle_id            INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  diet                TEXT    NOT NULL CHECK (diet IN ('all', 'vegetarian', 'vegan')),
  diet_confirmed      INTEGER NOT NULL DEFAULT 0 CHECK (diet_confirmed IN (0, 1)),
  notes               TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at          TEXT,
  decision_note       TEXT,
  car_status          TEXT    NOT NULL DEFAULT 'none' CHECK (car_status IN ('none', 'pending', 'approved', 'rejected')),
  car_passenger_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  car_decided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  car_decided_at      TEXT,
  car_decision_note   TEXT,
  -- אישור האופרטיבי - שכבה נוספת מעל אישור המפקד (status='approved'): עד
  -- שהאופרטיבי מאשר, האדם לא נכנס לשיבוץ אוטובוסים/לינה ולא נספר בדוח המזון
  -- (ראו loadCycleParticipants ב-lib/trips.ts). האישור עצמו נשאר החלטת המפקד,
  -- זו רק בדיקה נוספת של האופרטיבי לפני שהשיבוץ נחשב סופי.
  to_approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_approved_at      TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_signups_cycle  ON signups(cycle_id, status);
CREATE INDEX IF NOT EXISTS idx_signups_user   ON signups(user_id);

-- האצלת שיבוץ: רמ״ד/רת״ח שמאציל את השיבוץ למפקדים שמתחתיו.
-- קיום שורה = המפקדים שמתחת רשאים לשבץ את האנשים שלהם בגלישה הזאת.
CREATE TABLE IF NOT EXISTS trip_delegations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, manager_id)
);

-- העדפות שותפים לחדר (עד 3) ------------------------------------------------
CREATE TABLE IF NOT EXISTS dorm_preferences (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  signup_id         INTEGER NOT NULL REFERENCES signups(id) ON DELETE CASCADE,
  preferred_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  UNIQUE (signup_id, preferred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_prefs_signup ON dorm_preferences(signup_id);

-- מבני לינה וחדרים ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS structures (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL,
  gender  TEXT    NOT NULL CHECK (gender IN ('male', 'female')),
  UNIQUE (trip_id, name)
);

CREATE TABLE IF NOT EXISTS rooms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  structure_id INTEGER NOT NULL REFERENCES structures(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  beds         INTEGER NOT NULL CHECK (beds > 0),
  UNIQUE (structure_id, name)
);

CREATE INDEX IF NOT EXISTS idx_rooms_structure ON rooms(structure_id);

-- שיבוץ אוטובוסים ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS bus_assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  cycle_id   INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bus_number INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cycle_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bus_trip ON bus_assignments(trip_id);

-- שיבוץ חדרים --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  cycle_id   INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cycle_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_assign_trip ON room_assignments(trip_id);
CREATE INDEX IF NOT EXISTS idx_room_assign_room ON room_assignments(room_id);

-- בעיות שיבוץ לינה שדורשות טיפול מפקד --------------------------------------
CREATE TABLE IF NOT EXISTS dorm_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  cycle_id    INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('no_preference_met', 'unassigned')),
  message     TEXT    NOT NULL,
  suggestions TEXT    NOT NULL DEFAULT '[]',   -- JSON: הצעות שיבוץ אפשריות
  resolved    INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_manager ON dorm_issues(manager_id, resolved);
CREATE INDEX IF NOT EXISTS idx_issues_cycle   ON dorm_issues(cycle_id);

-- דיווח על ביטול משמרות (שבצ״ק) --------------------------------------------
-- המערכת אינה יודעת אילו משמרות אדם נמצא בהן כרגע - זה ידרוש מערכת נפרדת
-- שעוד לא נכתבה. לכן ר״צ, שהוא המפקד הישיר של חייליו, מדווח ידנית לכל
-- גלישה אם לחייל שלו (או לעצמו - גם לר״צ יכולה להיות משמרת) יש משמרת שצריך
-- לבטל בגללו. שורה אחת לכל (גלישה, אדם), ולכן דיווח חוזר מעדכן את הקיימת.
-- duty_type/duty_location/duty_dates ו-handling_status מקבילים לגיליון
-- "תורנויות" שבו נוהל הדבר לפני המערכת - ראו POST/PUT ב-trips.routes.ts.
CREATE TABLE IF NOT EXISTS shift_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  has_shift       INTEGER NOT NULL DEFAULT 0 CHECK (has_shift IN (0, 1)),
  details         TEXT,
  duty_type       TEXT,
  duty_location   TEXT,
  duty_dates      TEXT,
  handling_status TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_reports_trip ON shift_reports(trip_id, has_shift);

-- התראות --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
