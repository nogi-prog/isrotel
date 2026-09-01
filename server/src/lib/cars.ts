/**
 * הגעה ברכב פרטי לגלישה, במקום אוטובוס.
 *
 * רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - זו עובדה קבועה שהם שולטים בה
 * בפרופיל (מספר הרכב, ראו users.car_plate), לא בקשה לכל גלישה. הם עדיין
 * צריכים מיטה בלינה - רק האוטובוס מיותר עבורם.
 *
 * כל תפקיד אחר (חייל, ר״צ, רמ״ד, אופרטיבי) ממתין לאישור הרת״ח הקרוב ביותר
 * בשרשרת הפיקוד שלו; אם אין רת״ח בשרשרת (למשל מי שכפוף ישירות למפמ״ר בלי
 * רת״ח ביניהם) האופרטיבי מאשר - כמו רישום ראש שרשרת. ההעדפה היא שכמה שיותר
 * אנשים יגיעו באוטובוס, ולכן האישור אינו אוטומטי.
 *
 * לכל רכב נהג ונוסע אחד לכל היותר: מי שמבקש רכב יכול לצרף נוסע קיים שגם
 * הוא רשום לאותה פעימה, ושניהם יוצאים מהאוטובוס. השילוב הזה הוא הבסיס
 * לחישוב "כמה אוטובוסים צריך" - ראו buses.routes.ts.
 */
import { db, plain } from '../db/index.ts';
import { badRequest, notFound } from './errors.ts';
import { chainUp, isAncestorOf } from './org.ts';
import type { Role, SignupRow, UserRow } from '../types.ts';

/** מספר רכב תקין: 7-8 ספרות בלבד. */
export const CAR_PLATE_PATTERN = /^\d{7,8}$/;

/** רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - עובדה קבועה בפרופיל, לא בקשה לכל גלישה. */
export function alwaysBringsOwnCar(role: Role): boolean {
  return role === 'division_leader' || role === 'ceo';
}

/** הרת״ח הקרוב ביותר בשרשרת הפיקוד של המשתמש, או null אם אין. */
function nearestDivisionLeader(userId: number): UserRow | null {
  return chainUp(db, userId).slice(1).find((entry) => entry.role === 'division_leader') ?? null;
}

/**
 * מי שמאשר בקשת רכב: הרת״ח הקרוב בשרשרת, או האופרטיבי אם אין רת״ח בשרשרת -
 * למשל רת״ח עצמו, או מי שכפוף ישירות למפמ״ר בלי רת״ח ביניהם.
 */
export function carApproverOf(userId: number): UserRow | null {
  const leader = nearestDivisionLeader(userId);
  if (leader) return leader;
  const row = db.prepare("SELECT * FROM users WHERE role = 'to' AND status = 'approved' ORDER BY id LIMIT 1").get();
  return row ? plain<UserRow>(row) : null;
}

/**
 * בדיקת תקינות הנוסע שמצטרף לרכב: רשום ומאושר לאותה פעימה, לא המבקש עצמו,
 * לא נוהג רכב בעצמו, ולא כבר נוסע אצל מישהו אחר.
 */
export function validateCarPassenger(requesterSignup: SignupRow, passengerId: number): string | null {
  if (passengerId === requesterSignup.user_id) return 'אי אפשר לבחור את עצמך כנוסע';

  const passengerSignup = db
    .prepare(
      `SELECT * FROM signups WHERE trip_id = ? AND cycle_id = ? AND user_id = ? AND status = 'approved'`,
    )
    .get(requesterSignup.trip_id, requesterSignup.cycle_id, passengerId);
  if (!passengerSignup) return 'הנוסע חייב להיות רשום ומאושר לאותה פעימה';

  const passenger = plain<SignupRow>(passengerSignup);
  if (passenger.car_status === 'approved' || passenger.car_status === 'pending') {
    return 'הנוסע כבר ביקש רכב בעצמו';
  }

  const takenBy = db
    .prepare(
      `SELECT 1 AS ok FROM signups
        WHERE trip_id = ? AND cycle_id = ? AND car_passenger_id = ? AND id != ?
          AND car_status IN ('pending', 'approved')`,
    )
    .get(requesterSignup.trip_id, requesterSignup.cycle_id, passengerId, requesterSignup.id);
  if (takenBy) return 'הנוסע כבר רשום ברכב של מישהו אחר';

  return null;
}

export function getSignupOr404(signupId: number): SignupRow {
  const row = db.prepare('SELECT * FROM signups WHERE id = ?').get(signupId);
  if (!row) throw notFound('ההרשמה לא נמצאה');
  return plain<SignupRow>(row);
}

export function assertCarRequestPending(signup: SignupRow): void {
  if (signup.car_status !== 'pending') throw badRequest('אין בקשת רכב ממתינה להרשמה הזו');
}

/**
 * מי רשאי להחליט על בקשת רכב: רת״ח כלשהו בשרשרת הפיקוד שמעל המבקש (לא רק
 * הקרוב ביותר - כמו assertCanManage, מפקד בכיר יותר יכול להחליט גם הוא),
 * או האופרטיבי תמיד.
 */
export function canApproveCarRequest(approver: UserRow, requesterId: number): boolean {
  if (approver.role === 'to') return true;
  if (approver.role !== 'division_leader') return false;
  return isAncestorOf(db, approver.id, requesterId);
}
