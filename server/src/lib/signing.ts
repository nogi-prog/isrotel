/**
 * מי רשאי לשבץ את מי לגלישה.
 *
 * הכלל: חייל אינו משבץ את עצמו. האחראים לשיבוץ הם המפקדים שקיבלו את המשימה
 * מהאופרטיבי, שיכולים לבחור את האנשים שלהם בעצמם או להאציל את השיבוץ
 * למפקדים שמתחתיהם.
 *
 *   מפמ״ר / רת״ח / רמ״ד - משבצים תמיד את כל מי שכפוף להם (ואת עצמם).
 *   אופרטיבי            - מלבד ניהול המערכת הוא מפקד על מדור משלו, ולכן
 *                         כשהוא מקבל את משימת השיבוץ הוא משבץ אותו כרמ״ד.
 *   ר״צ                 - רק אם המפקד שמעליו האציל לו את השיבוץ בגלישה הזאת.
 *   חייל                - לעולם לא.
 */
import { db, plain } from '../db/index.ts';
import { forbidden } from './errors.ts';
import { notify } from './notify.ts';
import { chainUp, fullName, isAncestorOf } from './org.ts';
import { MANAGER_ROLES, SIGNING_LEADER_ROLES, type Role, type TripRow, type UserRow } from '../types.ts';

/**
 * הכפיפים הישירים של מפקד שהם עצמם מפקדים (לא חיילים) - הדרג שמאציל
 * מאציל אליו: רת״ח מאציל לרמ״דים הישירים שלו, רמ״ד/אופרטיבי לר״צים שלו.
 * חיילים אינם מקבלים האצלה - הם לעולם אינם משבצים.
 */
export function directReportManagers(managerId: number): UserRow[] {
  return db
    .prepare(`SELECT * FROM users WHERE manager_id = ? AND status = 'approved' AND role != 'employee'`)
    .all(managerId)
    .map((row) => plain<UserRow>(row));
}

/** ההסבר שמוצג כשהאופרטיבי הגיש את הגלישה ורשימת המשתתפים קפואה. */
export const TRIP_SUBMITTED_NOTE = 'האופרטיבי הגיש את הגלישה. אי אפשר להוסיף או להסיר אנשים.';

/** האם התפקיד אחראי לשיבוץ מתוקף תפקידו (מפמ״ר / רת״ח / רמ״ד / אופרטיבי). */
export function isSigningLeader(role: Role): boolean {
  return SIGNING_LEADER_ROLES.includes(role);
}

/** האם המפקד הזה האציל את השיבוץ למפקדים שמתחתיו בגלישה הזאת. */
export function hasDelegated(tripId: number, managerId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM trip_delegations WHERE trip_id = ? AND manager_id = ?')
    .get(tripId, managerId);
  return row != null;
}

/** האם המפקד קיבל מהאופרטיבי את משימת השיבוץ בגלישה הזאת. */
export function isAssignedLeader(tripId: number, managerId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM trip_leaders WHERE trip_id = ? AND manager_id = ?')
    .get(tripId, managerId);
  return row != null;
}

/**
 * קמב״צ: חייל בודד שהאופרטיבי בחר לו רת״ח "להשאיל" ממנו את הסמכות - ראו
 * ההסבר ב-schema.sql ליד trip_kmbatz. מחזיר את מזהה הרת״ח שהוקצה לו בגלישה
 * הזאת, או null אם החייל אינו קמב״ץ בגלישה הזאת.
 */
export function kmbatzLeaderId(tripId: number, userId: number): number | null {
  const row = db
    .prepare('SELECT leader_id FROM trip_kmbatz WHERE trip_id = ? AND user_id = ?')
    .get(tripId, userId) as { leader_id: number } | undefined;
  return row?.leader_id ?? null;
}

/** כל החיילים שמונו כקמב״צים בגלישה. */
export function kmbatzUserIds(tripId: number): number[] {
  return (
    db.prepare('SELECT user_id FROM trip_kmbatz WHERE trip_id = ? ORDER BY user_id').all(tripId) as Array<{
      user_id: number;
    }>
  ).map((row) => row.user_id);
}

/**
 * שורש השיבוץ בפועל: עצמו, חוץ מקמב״ץ - שם זה הרת״ח שהוקצה לו, כי לחייל
 * עצמו אין כפיפים משלו. משמש גם ב-signableUserIds וגם ב-assertCanSign, כדי
 * ששני המקומות יסכימו בדיוק על מי הקמב״ץ רשאי לשבץ.
 */
function effectiveSigningRootId(tripId: number, user: UserRow): number {
  if (user.role === 'employee') return kmbatzLeaderId(tripId, user.id) ?? user.id;
  return user.id;
}

/** המפקדים שקיבלו את משימת השיבוץ בגלישה. */
export function assignedLeaderIds(tripId: number): number[] {
  return (
    db.prepare('SELECT manager_id FROM trip_leaders WHERE trip_id = ? ORDER BY manager_id').all(tripId) as Array<{
      manager_id: number;
    }>
  ).map((row) => row.manager_id);
}

/** רשימת המפקדים שהאצילו שיבוץ בגלישה. */
export function delegatedManagerIds(tripId: number): number[] {
  return (
    db.prepare('SELECT manager_id FROM trip_delegations WHERE trip_id = ?').all(tripId) as Array<{
      manager_id: number;
    }>
  ).map((row) => row.manager_id);
}

/**
 * כל המפקדים שיש להם הרשאת שיבוץ בגלישה: מי שקיבל את המשימה מהאופרטיבי,
 * ומי שקיבל האצלה (המפקדים שמתחת למאציל). זו קבוצת הנמענים של הודעות
 * שנוגעות לשיבוץ עצמו - למשל שהאופרטיבי הגיש את הגלישה והרשימה קפואה.
 */
export function signingManagerIds(tripId: number): number[] {
  const placeholders = MANAGER_ROLES.map(() => '?').join(',');
  const delegates = (
    db
      .prepare(
        `WITH RECURSIVE sub(id, depth) AS (
           SELECT manager_id, 0 FROM trip_delegations WHERE trip_id = ?
           UNION
           SELECT u.id, sub.depth + 1
             FROM users u JOIN sub ON u.manager_id = sub.id
            WHERE sub.depth < 12
         )
         SELECT DISTINCT users.id
           FROM sub JOIN users ON users.id = sub.id
          WHERE users.status = 'approved' AND users.role IN (${placeholders})`,
      )
      .all(tripId, ...MANAGER_ROLES) as Array<{ id: number }>
  ).map((row) => row.id);

  return [...new Set([...assignedLeaderIds(tripId), ...delegates, ...kmbatzUserIds(tripId)])];
}

/**
 * האם ל־`user` יש הרשאת שיבוץ בגלישה, ואם כן מאיזה סוג.
 * `leader`    - מפקד שקיבל את המשימה מהאופרטיבי: השיבוץ שלו נכנס לגלישה מיד.
 * `delegated` - מפקד שקיבל האצלה ממפקד מעליו: השיבוץ שלו ממתין לאישור המאציל.
 *
 * חייל לעולם אינו משבץ. האופרטיבי כן - הוא מפקד על מדור משלו, ולכן כשהוא
 * מקבל את משימת השיבוץ הוא משבץ את המדור שלו בדיוק כמו רמ״ד.
 */
export function signingAuthority(trip: TripRow, user: UserRow): 'leader' | 'delegated' | null {
  if (user.role === 'employee') {
    // חייל רגיל לעולם אינו משבץ - חוץ מקמב״ץ, שקיבל הרשאה שקולה לרת״ח שהוקצה לו.
    return kmbatzLeaderId(trip.id, user.id) != null ? 'leader' : null;
  }
  if (isAssignedLeader(trip.id, user.id)) return 'leader';

  // אחרת - רק אם מפקד בשרשרת שמעליו האציל את השיבוץ בגלישה הזאת.
  const delegated = chainUp(db, user.id)
    .slice(1)
    .some((ancestor) => hasDelegated(trip.id, ancestor.id));
  return delegated ? 'delegated' : null;
}

/** המפקד שהאציל למשתמש את השיבוץ - אליו מגיעה הרשימה לאישור. */
export function responsibleLeaderId(tripId: number, userId: number): number | null {
  return chainUp(db, userId).slice(1).find((ancestor) => hasDelegated(tripId, ancestor.id))?.id ?? null;
}

/**
 * כל מי שהמפקד רשאי לשבץ: הוא עצמו וכל מי שכפוף לו.
 * ר״צ שקיבל האצלה מוגבל לצוות שלו בלבד.
 */
export function signableUserIds(trip: TripRow, user: UserRow): number[] {
  if (signingAuthority(trip, user) == null) return [];

  const rootId = effectiveSigningRootId(trip.id, user);
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 0 FROM users WHERE id = ?
         UNION
         SELECT u.id, sub.depth + 1
           FROM users u JOIN sub ON u.manager_id = sub.id
          WHERE sub.depth < 12
       )
       SELECT users.id
         FROM sub JOIN users ON users.id = sub.id
        WHERE users.status = 'approved'`,
    )
    .all(rootId) as Array<{ id: number }>;

  return rows.map((row) => row.id);
}

/** מוודא שיש למשתמש הרשאת שיבוץ בגלישה, וזורק שגיאה מוסברת אם לא. */
export function assertSigningAuthority(trip: TripRow, user: UserRow): 'leader' | 'delegated' {
  const authority = signingAuthority(trip, user);
  if (authority == null) {
    throw forbidden(
      user.role === 'employee'
        ? 'חייל אינו משבץ את עצמו לגלישה. המפקד שלך משבץ אותך.'
        : 'לא קיבלת את משימת השיבוץ בגלישה הזאת',
    );
  }
  return authority;
}

/** מוודא שהמשתמש רשאי לשבץ את היעד, וזורק שגיאה מוסברת אם לא. */
export function assertCanSign(trip: TripRow, user: UserRow, targetId: number): 'leader' | 'delegated' {
  const authority = assertSigningAuthority(trip, user);

  const rootId = effectiveSigningRootId(trip.id, user);
  if (targetId !== rootId && !isAncestorOf(db, rootId, targetId)) {
    throw forbidden('האדם הזה אינו כפוף לך');
  }
  return authority;
}

/** מביא משתמש מאושר לפי מזהה, או null. */
export function getApprovedUser(userId: number): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'approved'").get(userId);
  return row ? plain<UserRow>(row) : null;
}

// --- הגשת רשימות וקיפאון רשימת המשתתפים -----------------------------------
// שני מנעולים שונים, ובכוונה:
//   רשימת המשתתפים (מי יוצא) - נקפאת כשהאופרטיבי מגיש את הגלישה.
//   הפרטים האישיים (שותפים ותזונה) - נשארים פתוחים גם אחרי ההגשה, כי שיבוץ
//   הלינה מתבצע אחר כך וזקוק להם.
// הגשת מפקד (trip_submissions) אינה נועלת דבר: היא הצהרה שהוא סיים, ומה
// שהיא מאפשרת הוא לזהות מי שנוסף ליחידה שלו אחריה (lateAdditions).

/** הרגע שבו המפקד הגיש את רשימת האנשים שלו בגלישה, או null אם לא הגיש. */
export function submittedAt(tripId: number, managerId: number): string | null {
  const row = db
    .prepare('SELECT submitted_at FROM trip_submissions WHERE trip_id = ? AND manager_id = ?')
    .get(tripId, managerId) as { submitted_at: string } | undefined;
  return row?.submitted_at ?? null;
}

/** האם המפקד הגיש את רשימת האנשים שלו בגלישה. */
export function hasSubmitted(tripId: number, managerId: number): boolean {
  return submittedAt(tripId, managerId) != null;
}

/** המפקדים שכבר הגישו את הרשימה שלהם בגלישה. */
export function submittedManagerIds(tripId: number): number[] {
  return (
    db.prepare('SELECT manager_id FROM trip_submissions WHERE trip_id = ? ORDER BY manager_id').all(tripId) as Array<{
      manager_id: number;
    }>
  ).map((row) => row.manager_id);
}

/**
 * ההסבר בעברית מדוע רשימת המשתתפים קפואה, או null אם היא פתוחה.
 * זו ההגדרה היחידה של "הרשימה סגורה" - הן לבדיקות בנקודות הקצה והן לתשובות.
 */
export function rosterClosedNote(trip: TripRow): string | null {
  if (trip.state !== 'LAUNCHED') return 'הגלישה סגורה.';
  if (trip.buses_locked_at || trip.dorms_locked_at) return 'השיבוצים נעולים.';
  if (trip.submitted_at != null) return TRIP_SUBMITTED_NOTE;
  return null;
}

/** כמה מהאנשים שהמפקד רשאי לשבץ משובצים כבר בגלישה. */
export function signedCount(trip: TripRow, user: UserRow): number {
  const ids = signableUserIds(trip, user);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM signups WHERE trip_id = ? AND user_id IN (${placeholders})`)
    .get(trip.id, ...ids) as { count: number };
  return row.count;
}

/**
 * כמה אנשים מהיחידה של המפקד משובצים בגלישה: כל מי שהוא עצמו שיבץ, וכל מי
 * שנמצא ביחידה שלו (הוא וכל הכפופים לו) - זה המספר שמעניין את האופרטיבי.
 */
export function leaderSignedCount(tripId: number, leaderId: number): number {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 0 FROM users WHERE id = ?
         UNION
         SELECT u.id, sub.depth + 1
           FROM users u JOIN sub ON u.manager_id = sub.id
          WHERE sub.depth < 12
       )
       SELECT COUNT(*) AS count
         FROM signups s
        WHERE s.trip_id = ? AND (s.created_by = ? OR s.user_id IN (SELECT id FROM sub))`,
    )
    .get(leaderId, tripId, leaderId) as { count: number };
  return row.count;
}

/**
 * מי שנוסף ליחידה של המפקד אחרי שהגיש את הרשימה, וטרם שובץ לגלישה.
 * אלה האנשים שהמפקד צריך להחליט לגביהם - הוא עוד רשאי להוסיף אותם,
 * כל עוד האופרטיבי לא הגיש את הגלישה.
 */
export function lateAdditionIds(trip: TripRow, manager: UserRow): number[] {
  const since = submittedAt(trip.id, manager.id);
  if (since == null) return [];

  const ids = signableUserIds(trip, manager);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return (
    db
      .prepare(
        `SELECT u.id
           FROM users u
          WHERE u.id IN (${placeholders})
            AND u.status = 'approved'
            AND COALESCE(u.approved_at, u.created_at) > ?
            AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.trip_id = ? AND s.user_id = u.id)
          ORDER BY u.id`,
      )
      .all(...ids, since, trip.id) as Array<{ id: number }>
  ).map((row) => row.id);
}

/**
 * אחרי אישור רישום של אדם חדש: מודיע לכל מפקד בשרשרת שמעליו שכבר הגיש את
 * הרשימה שלו, כדי שיוכל להחליט אם להוסיף אותו לגלישה. רלוונטי רק לגלישות
 * שהאופרטיבי עוד לא הגיש - אחריהם הרשימה קפואה ואין מה להציע.
 */
export function notifyLateAddition(target: UserRow): void {
  const trips = db
    .prepare("SELECT * FROM trips WHERE state = 'LAUNCHED' AND submitted_at IS NULL")
    .all()
    .map((row) => plain<TripRow>(row));
  if (trips.length === 0) return;

  const ancestors = chainUp(db, target.id).slice(1);
  const ancestorAndSelfIds = new Set([target.id, ...ancestors.map((ancestor) => ancestor.id)]);

  for (const trip of trips) {
    for (const ancestor of ancestors) {
      if (signingAuthority(trip, ancestor) == null) continue;
      if (!hasSubmitted(trip.id, ancestor.id)) continue;

      notify(db, {
        userId: ancestor.id,
        kind: 'late_addition',
        title: `${fullName(target)} נוסף ליחידה שלך אחרי שהגשת`,
        body: `אפשר להוסיף אותו לרשימת האנשים בגלישה ${trip.name}, כל עוד האופרטיבי לא הגיש את הגלישה.`,
        link: `/trips/${trip.id}/signing`,
      });
    }

    // קמב״צים שהוקצו לרת״ח שנמצא בשרשרת של האדם החדש (או שהוקצו אליו עצמו) -
    // בדיוק כמו רת״ח רגיל, יש להם עכשיו אדם חדש שהם רשאים להוסיף.
    for (const kmbatzUserId of kmbatzUserIds(trip.id)) {
      const leaderId = kmbatzLeaderId(trip.id, kmbatzUserId);
      if (leaderId == null || !ancestorAndSelfIds.has(leaderId)) continue;
      if (!hasSubmitted(trip.id, kmbatzUserId)) continue;

      notify(db, {
        userId: kmbatzUserId,
        kind: 'late_addition',
        title: `${fullName(target)} נוסף ליחידה שאתה קמב״ץ שלה`,
        body: `אפשר להוסיף אותו לרשימת האנשים בגלישה ${trip.name}, כל עוד האופרטיבי לא הגיש את הגלישה.`,
        link: `/trips/${trip.id}/signing`,
      });
    }
  }
}
