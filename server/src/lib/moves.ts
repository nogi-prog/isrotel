/**
 * העברת אדם בין ענפים בעץ הארגוני - שינוי manager_id שלו למפקד אחר.
 *
 * אישור: אם המפקד היעד נמצא בתוך שרשרת הפיקוד של המבקש (הוא עצמו, או שהמבקש
 * מפקד עליו) ההעברה חלה מיד - המבקש כבר בעל הסמכות משני הצדדים. אחרת היא
 * ממתינה לאישור המפקד היעד, בדיוק כמו רישום או עדכון פרופיל.
 *
 * מי שיש לו כפיפים משלו (מפקד יחידה) לא יכול להיות מועבר בלי שממנים לו
 * ממלא מקום שיירש את היחידה - אחרת היא נשארת בלי מפקד.
 */
import { db } from '../db/index.ts';
import { badRequest, notFound } from './errors.ts';
import { fullName, getUser, isAncestorOf } from './org.ts';
import { PARENT_ROLES, ROLE_LABEL, roleLabels, type RegistrableRole, type Role, type UserRow } from '../types.ts';

/** האם לתפקיד הזה יכול בכלל להיות מפקד חדש - מפמ״ר הוא ראש השרשרת, ולאופרטיבי יש עמדה קבועה. */
function isMovableRole(role: Role): role is RegistrableRole {
  return role !== 'to' && role !== 'ceo';
}

/** האם למשתמש יש כפיפים ישירים מאושרים - כלומר הוא מפקד על יחידה בפועל. */
export function hasDirectReports(userId: number): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM users WHERE manager_id = ? AND status = 'approved' LIMIT 1`).get(userId);
  return row != null;
}

/**
 * בדיקת תקינות היעד: התפקיד שלו חייב להיות מהדרג שמעל תפקיד המועבר -
 * אותו כלל בדיוק כמו בחירת מפקד בהרשמה.
 */
export function validateMoveTarget(target: UserRow, toManager: UserRow): string | null {
  if (!isMovableRole(target.role)) return 'לא ניתן להעביר משתמש בתפקיד הזה';
  if (toManager.id === target.id) return 'אי אפשר להעביר אדם למפקד של עצמו';
  if (isAncestorOf(db, target.id, toManager.id)) return 'המפקד היעד כפוף למי שמנסים להעביר';

  const parentRoles = PARENT_ROLES[target.role];
  if (!parentRoles.includes(toManager.role)) {
    return `המפקד היעד של ${ROLE_LABEL[target.role]} חייב להיות ${roleLabels(parentRoles)}`;
  }
  return null;
}

/**
 * בדיקת תקינות ממלא המקום: מאושר, לא המועבר עצמו, ואין לו כפיפים משלו -
 * כדי לא ליצור יחידה יתומה נוספת כתוצאה מהמינוי.
 */
export function validateSuccessor(target: UserRow, successor: UserRow): string | null {
  if (successor.id === target.id) return 'ממלא המקום לא יכול להיות המועבר עצמו';
  if (successor.status !== 'approved') return 'ממלא המקום חייב להיות משתמש מאושר';
  if (hasDirectReports(successor.id)) return 'ממלא המקום כבר מפקד על יחידה משלו';
  return null;
}

/**
 * מחילה את ההעברה בפועל: אם יש ממלא מקום הוא יורש את התפקיד, שם היחידה,
 * המפקד הקודם וכל הכפיפים הישירים של המועבר - ורק אז המועבר עצמו מקבל את
 * המפקד החדש. נקרא גם מיד (העברה בתוך השרשרת) וגם באישור בקשה ממתינה.
 * לא פותח טרנזקציה משלו - הקורא אחראי לעטוף בטרנזקציה יחד עם שאר הפעולות
 * (עדכון בקשת ההעברה, התראות) כדי שהכול יקרה ביחד או לא בכלל.
 */
export function applyMove(targetId: number, toManagerId: number, successorId: number | null): void {
  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');

  if (successorId != null) {
    db.prepare(`UPDATE users SET role = ?, unit_name = ?, manager_id = ? WHERE id = ?`).run(
      target.role,
      target.unit_name,
      target.manager_id,
      successorId,
    );
    db.prepare(`UPDATE users SET manager_id = ? WHERE manager_id = ? AND id != ?`).run(
      successorId,
      target.id,
      successorId,
    );
  }

  db.prepare(`UPDATE users SET manager_id = ? WHERE id = ?`).run(toManagerId, target.id);
}

/** תיאור קצר של הבקשה, לשימוש בהודעות. */
export function describeMove(target: UserRow, toManager: UserRow): string {
  return `${fullName(target)} מועבר לפיקוד ${fullName(toManager)}`;
}

export function assertValidMoveInput(
  targetId: number,
  toManagerId: number,
  successorId: number | null,
): { target: UserRow; toManager: UserRow; successor: UserRow | null } {
  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');
  const toManager = getUser(db, toManagerId);
  if (!toManager || toManager.status !== 'approved') throw notFound('המפקד היעד לא נמצא');

  const targetError = validateMoveTarget(target, toManager);
  if (targetError) throw badRequest(targetError);

  if (hasDirectReports(target.id) && successorId == null) {
    throw badRequest('יש למנות ממלא מקום שיירש את היחידה - הזן שם או מספר אישי');
  }

  let successor: UserRow | null = null;
  if (successorId != null) {
    successor = getUser(db, successorId);
    if (!successor) throw notFound('ממלא המקום לא נמצא');
    const successorError = validateSuccessor(target, successor);
    if (successorError) throw badRequest(successorError);
  }

  return { target, toManager, successor };
}
