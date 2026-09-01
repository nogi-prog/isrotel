/**
 * העדפות שותפים קבועות ברמת המשתמש - "עם מי הייתי רוצה לישון" באופן כללי,
 * ולא לגלישה מסוימת.
 *
 * נשאלות (לא חובה) בהרשמה וניתנות לעריכה במסך הפרופיל. הן מזינות כברירת
 * מחדל את העדפות הלינה של כל גלישה, כשהמשתמש לא בחר העדפות ספציפיות לגלישה
 * ההוא (ראו loadCycleParticipants ב-trips.ts).
 *
 * האילוצים זהים לאלה של בחירת שותפים בגלישה: אותו מין ואותו דרג ניהולי
 * בדיוק (לא כל המפקדים יחד) - כלומר בדיוק מה שמנוע השיבוץ יכול לכבד בפועל.
 */
import { db, plain } from '../db/index.ts';
import { badRequest, notFound } from './errors.ts';
import { fullName, getUser, rankGroup, unitPath } from './org.ts';
import { checkRoommateEligibility } from './trips.ts';
import type { UserRow } from '../types.ts';

/** מספר השותפים המרבי שאפשר לבקש - תואם ל-CHECK על priority בסכמה. */
export const MAX_ROOMMATE_PREFERENCES = 3;

export interface RoommateOption {
  id: number;
  fullName: string;
  companyId: string;
  unitPath: string;
}

const toOption = (user: UserRow): RoommateOption => ({
  id: user.id,
  fullName: fullName(user),
  companyId: user.company_id,
  unitPath: unitPath(db, user.id),
});

/**
 * המועמדים לשותפות עבור אדם נתון: מאושרים, מאותו מין ומאותה קבוצת דרגה
 * בדיוק - חיילים עם חיילים, רמ״ד (והאופרטיבי, השקול לרמ״ד) עם רמ״ד, רת״ח
 * עם רת״ח וכן הלאה, לא כל המפקדים יחד. הסינון לפי rankGroup ולא role, כדי
 * שהאופרטיבי ורמ״ד ייחשבו לאותה קבוצה (ראו rankGroup ב-org.ts).
 */
export function listRoommateCandidates(viewer: Pick<UserRow, 'id' | 'gender' | 'role'>): RoommateOption[] {
  const rows = db
    .prepare(
      `SELECT * FROM users
        WHERE status = 'approved' AND id != ? AND gender = ?
        ORDER BY last_name, first_name`,
    )
    .all(viewer.id, viewer.gender)
    .map((row) => plain<UserRow>(row));

  const viewerRank = rankGroup(viewer.role);
  return rows.filter((row) => rankGroup(row.role) === viewerRank).map(toOption);
}

/** ההעדפות הקבועות השמורות של המשתמש, לפי סדר העדיפות. */
export function getStandingPreferences(userId: number): RoommateOption[] {
  const rows = db
    .prepare(
      `SELECT u.* FROM user_roommate_preferences p
         JOIN users u ON u.id = p.preferred_user_id
        WHERE p.user_id = ? ORDER BY p.priority`,
    )
    .all(userId)
    .map((row) => plain<UserRow>(row));
  return rows.map(toOption);
}

/**
 * שומר את ההעדפות הקבועות של המשתמש, אחרי בדיקת כל האילוצים (מין ודרג ניהולי
 * מדויק - ראו checkRoommateEligibility). רשימה ריקה מוחקת את ההעדפות - הן
 * אינן חובה.
 */
export function saveStandingPreferences(requester: UserRow, preferences: number[]): void {
  const unique = [...new Set(preferences)];
  if (unique.length !== preferences.length) throw badRequest('לא ניתן לבחור את אותו אדם פעמיים');
  if (unique.length > MAX_ROOMMATE_PREFERENCES) {
    throw badRequest(`אפשר לבחור עד ${MAX_ROOMMATE_PREFERENCES} שותפים`);
  }

  db.prepare('DELETE FROM user_roommate_preferences WHERE user_id = ?').run(requester.id);

  const insert = db.prepare(
    'INSERT INTO user_roommate_preferences (user_id, preferred_user_id, priority) VALUES (?, ?, ?)',
  );
  unique.forEach((candidateId, index) => {
    const candidate = getUser(db, candidateId);
    if (!candidate) throw notFound('אחד השותפים שנבחרו לא נמצא במערכת');
    const problem = checkRoommateEligibility(requester, candidate);
    if (problem) throw badRequest(`${fullName(candidate)}: ${problem}`);
    insert.run(requester.id, candidateId, index + 1);
  });
}
