import type { Db } from '../db/index.ts';
import { plain } from '../db/index.ts';
import {
  MANAGER_ROLES,
  SECTOR_ROLES,
  type PublicUser,
  type RankGroup,
  type Role,
  type UserRow,
} from '../types.ts';

/** עומק מקסימלי לטיפוס בשרשרת הפיקוד - הגנה מפני לופ בנתונים. */
const MAX_CHAIN_DEPTH = 12;

interface UnitNode {
  id: number;
  name: string | null;
}

export function isManagerRole(role: Role): boolean {
  return MANAGER_ROLES.includes(role);
}

/**
 * קבוצת הדרגה לצורך שיבוץ לינה. חיילים לא ישנים עם מפקדים, וכל דרג ניהולי
 * ישן רק עם בני אותו דרג בדיוק - רמ״ד עם רמ״ד, רת״ח עם רת״ח, לא כל המפקדים
 * ביחד. חיילים נשארים קבוצה אחת, כי אין ביניהם דרגים נוספים.
 * האופרטיבי שקול לרמ״ד לצורך הזה - יש לו מדור משלו בדיוק כמו לרמ״ד (ראו
 * SECTOR_ROLES / resolveUnits), ולכן הוא חולק קבוצת דרגה עם הרמ״דים.
 */
export function rankGroup(role: Role): RankGroup {
  if (role === 'employee') return 'soldier';
  if (role === 'to') return 'sector_leader';
  return role;
}

export function getUser(db: Db, id: number): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? plain<UserRow>(row) : null;
}

export function getUserByCompanyId(db: Db, companyId: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE company_id = ?').get(companyId);
  return row ? plain<UserRow>(row) : null;
}

export function fullName(user: Pick<UserRow, 'first_name' | 'last_name'>): string {
  return `${user.first_name} ${user.last_name}`.trim();
}

/**
 * שרשרת הפיקוד של המשתמש, מהמשתמש עצמו ומעלה (עומק 0 = המשתמש).
 */
/**
 * שרשרת הפיקוד מעל `userId`, מוגנת מפני לופ בנתונים (manager_id שמצביע חזרה
 * על מישהו שכבר נמצא בשרשרת - כולל מקרה של מפקד שהוא המפקד של עצמו).
 * `path` עוקב אחרי כל ה-id-ים שכבר ביקרנו בהם במסלול הנוכחי (מחרוזת
 * מופרדת ב-"/"), והתנאי `instr` עוצר את הרקורסיה ברגע שהיא הייתה חוזרת על
 * מישהו שכבר נספר - כך שהתוצאה עוצרת בלי לחזור על אותו אדם שוב ושוב, במקום
 * להסתמך רק על MAX_CHAIN_DEPTH כרשת ביטחון (שהייתה מייצרת חזרות עד העומק
 * המקסימלי בלי לעצור בפועל על הלופ עצמו).
 */
export function chainUp(db: Db, userId: number): UserRow[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE chain(id, depth, path) AS (
         SELECT id, 0, '/' || id || '/' FROM users WHERE id = ?
         UNION ALL
         SELECT u.manager_id, chain.depth + 1, chain.path || u.manager_id || '/'
           FROM users u JOIN chain ON u.id = chain.id
          WHERE u.manager_id IS NOT NULL
            AND chain.depth < ${MAX_CHAIN_DEPTH}
            AND instr(chain.path, '/' || u.manager_id || '/') = 0
       )
       SELECT users.*, chain.depth AS depth
         FROM chain JOIN users ON users.id = chain.id
        ORDER BY chain.depth`,
    )
    .all(userId);
  return rows.map((row) => plain<UserRow>(row));
}

/**
 * מוצא את היחידות שהמשתמש שייך אליהן: הצומת הקרוב ביותר בשרשרת (כולל עצמו)
 * שתפקידו ר״צ / רמ״ד / רת״ח.
 * המדור הוא רמ״ד **או אופרטיבי**, כי לאופרטיבי מדור משלו - וכך הכלל
 * "חייל בוחר שותפים רק מאותו מדור" וקיבוץ המדורים בשיבוץ האוטובוסים
 * עובדים גם לאנשים שכפופים לאופרטיבי.
 */
export function resolveUnits(
  db: Db,
  userId: number,
): { team: UnitNode | null; sector: UnitNode | null; division: UnitNode | null } {
  const chain = chainUp(db, userId);
  const find = (roles: readonly Role[]): UnitNode | null => {
    const node = chain.find((entry) => roles.includes(entry.role));
    return node ? { id: node.id, name: node.unit_name ?? fullName(node) } : null;
  };
  return { team: find(['team_leader']), sector: find(SECTOR_ROLES), division: find(['division_leader']) };
}

/**
 * כל הכפיפים של מפקד, בכל העומקים - מוגן מפני לופ בנתונים באותו אופן כמו
 * chainUp (ראו שם): `path` עוצר את הרקורסיה לפני שהיא חוזרת על מישהו
 * שכבר נספר, כדי שלופ (למשל מפקד שהוא המפקד של עצמו) לא ייצור כפילויות.
 */
export function subordinateIds(db: Db, managerId: number): number[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id, depth, path) AS (
         SELECT id, 1, '/' || id || '/' FROM users WHERE manager_id = ?
         UNION ALL
         SELECT u.id, sub.depth + 1, sub.path || u.id || '/'
           FROM users u JOIN sub ON u.manager_id = sub.id
          WHERE sub.depth < ${MAX_CHAIN_DEPTH}
            AND instr(sub.path, '/' || u.id || '/') = 0
       )
       SELECT DISTINCT id FROM sub`,
    )
    .all(managerId);
  return rows.map((row) => (row as { id: number }).id);
}

/** האם `managerId` נמצא בשרשרת הפיקוד שמעל `userId`. */
export function isAncestorOf(db: Db, managerId: number, userId: number): boolean {
  if (managerId === userId) return false;
  return chainUp(db, userId).some((entry) => entry.id === managerId);
}

/** מזהה המדור של המשתמש (המשמש למגבלת "רק מאותו מדור"). */
export function sectorIdOf(db: Db, userId: number): number | null {
  return resolveUnits(db, userId).sector?.id ?? null;
}

/** ממיר שורת משתמש לייצוג ה־API, כולל שדות היררכיה מחושבים. */
export function toPublicUser(db: Db, user: UserRow): PublicUser {
  const units = resolveUnits(db, user.id);
  const manager = user.manager_id ? getUser(db, user.manager_id) : null;
  return {
    id: user.id,
    companyId: user.company_id,
    firstName: user.first_name,
    lastName: user.last_name,
    fullName: fullName(user),
    gender: user.gender,
    role: user.role,
    diet: user.diet,
    managerId: user.manager_id,
    managerName: manager ? fullName(manager) : null,
    unitName: user.unit_name,
    phone: user.phone,
    allergies: user.allergies,
    status: user.status,
    rankGroup: rankGroup(user.role),
    sectorId: units.sector?.id ?? null,
    sectorName: units.sector?.name ?? null,
    teamId: units.team?.id ?? null,
    teamName: units.team?.name ?? null,
    divisionId: units.division?.id ?? null,
    divisionName: units.division?.name ?? null,
    isManager: isManagerRole(user.role),
    isTripOrganizer: user.role === 'to',
    carPlate: user.car_plate,
    workerType: user.worker_type,
    borrowedFrom: user.borrowed_from,
    borrowedMission: user.borrowed_mission,
    hasPassword: user.password_hash != null,
    mustChangePassword: user.must_change_password === 1,
  };
}

/** תיאור קצר של השיוך הארגוני, לתצוגה ברשימות. */
export function unitPath(db: Db, userId: number): string {
  const units = resolveUnits(db, userId);
  return [units.division?.name, units.sector?.name, units.team?.name].filter(Boolean).join(' / ');
}
