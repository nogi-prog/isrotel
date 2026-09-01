import { db, plain } from '../db/index.ts';
import { notFound, badRequest } from './errors.ts';
import { fullName, rankGroup, resolveUnits } from './org.ts';
import { alwaysBringsOwnCar } from './cars.ts';
import { cycleName } from '../types.ts';
import type {
  CarStatus,
  CycleRow,
  Diet,
  Gender,
  RankGroup,
  Role,
  SignupRow,
  TripRow,
  UserRow,
  WorkerType,
} from '../types.ts';
import type { BusParticipant } from '../services/busAllocation.ts';
import type { DormParticipant, DormRoom } from '../services/dormAllocation.ts';

export function getTripOr404(tripId: number): TripRow {
  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!row) throw notFound('הגלישה לא נמצא');
  return plain<TripRow>(row);
}

export function getCycleOr404(tripId: number, cycleId: number): CycleRow {
  const row = db.prepare('SELECT * FROM cycles WHERE id = ? AND trip_id = ?').get(cycleId, tripId);
  if (!row) throw notFound('הפעימה לא נמצאה');
  return plain<CycleRow>(row);
}

/** הפעימות בסדר היציאה - אותו סדר שממנו נגזרים השמות. */
export function listCycles(tripId: number): CycleRow[] {
  return db
    .prepare('SELECT * FROM cycles WHERE trip_id = ? ORDER BY exit_date, id')
    .all(tripId)
    .map((row) => plain<CycleRow>(row));
}

/**
 * מחשב מחדש את שמות הפעימות לפי סדר היציאה: הראשונה "חלוץ" ואחריה
 * "פעימה 1" וכן הלאה. נקרא אחרי כל הוספה, שינוי תאריך או מחיקה, כדי
 * שהמספור יישאר רצוף וישקף את הסדר בפועל.
 */
export function renumberCycles(tripId: number): void {
  const rows = db.prepare('SELECT id, name FROM cycles WHERE trip_id = ? ORDER BY exit_date, id').all(tripId) as Array<{
    id: number;
    name: string;
  }>;
  const rename = db.prepare('UPDATE cycles SET name = ? WHERE id = ?');
  rows.forEach((row, index) => {
    const name = cycleName(index);
    if (row.name !== name) rename.run(name, row.id);
  });
}

export function getSignup(tripId: number, userId: number): SignupRow | null {
  const row = db.prepare('SELECT * FROM signups WHERE trip_id = ? AND user_id = ?').get(tripId, userId);
  return row ? plain<SignupRow>(row) : null;
}

/** משתתף מאושר בפעימה, מועשר בשיוך הארגוני ובהעדפות הלינה שלו. */
export interface ParticipantRecord {
  signupId: number;
  userId: number;
  companyId: string;
  name: string;
  gender: Gender;
  role: Role;
  rankGroup: RankGroup;
  diet: Diet;
  managerId: number | null;
  managerName: string | null;
  teamId: number | null;
  teamName: string | null;
  sectorId: number | null;
  sectorName: string | null;
  divisionId: number | null;
  divisionName: string | null;
  /** שם הרת״ח האחראי (לא שם היחידה) - ראו lib/org.ts:resolveUnits. */
  divisionLeaderName: string | null;
  preferences: number[];
  carStatus: CarStatus;
  carPassengerId: number | null;
  workerType: WorkerType;
  borrowedFrom: string | null;
  borrowedMission: string | null;
}

/**
 * טוען את כל המשתתפים המאושרים בפעימה.
 * רק הרשמות שאושרו על ידי המפקד נכנסות לשיבוצים.
 */
export function loadCycleParticipants(cycleId: number): ParticipantRecord[] {
  const rows = db
    .prepare(
      `SELECT s.id AS signup_id, s.diet AS signup_diet, s.car_status AS signup_car_status,
              s.car_passenger_id AS signup_car_passenger_id, u.*
         FROM signups s
         JOIN users u ON u.id = s.user_id
        WHERE s.cycle_id = ? AND s.status = 'approved'
        ORDER BY u.id`,
    )
    .all(cycleId)
    .map((row) =>
      plain<
        UserRow & {
          signup_id: number;
          signup_diet: Diet;
          signup_car_status: CarStatus;
          signup_car_passenger_id: number | null;
        }
      >(row),
    );

  if (rows.length === 0) return [];

  const signupIds = rows.map((row) => row.signup_id);
  const placeholders = signupIds.map(() => '?').join(',');
  const preferenceRows = db
    .prepare(
      `SELECT signup_id, preferred_user_id, priority
         FROM dorm_preferences
        WHERE signup_id IN (${placeholders})
        ORDER BY priority`,
    )
    .all(...signupIds) as Array<{ signup_id: number; preferred_user_id: number; priority: number }>;

  const preferencesBySignup = new Map<number, number[]>();
  for (const row of preferenceRows) {
    const list = preferencesBySignup.get(row.signup_id) ?? [];
    list.push(row.preferred_user_id);
    preferencesBySignup.set(row.signup_id, list);
  }

  // מי שלא בחר שותפים לגלישה הזאת נופל להעדפות הקבועות מהפרופיל שלו. מנוע
  // השיבוץ מתעלם ממי שאינו במאגר (לא נרשם לפעימה / מין או דרגה אחרת), ולכן
  // אפשר להעביר את הרשימה כמו שהיא בלי סינון נוסף כאן.
  const userIds = rows.map((row) => row.id);
  const userPlaceholders = userIds.map(() => '?').join(',');
  const standingRows = db
    .prepare(
      `SELECT user_id, preferred_user_id, priority
         FROM user_roommate_preferences
        WHERE user_id IN (${userPlaceholders})
        ORDER BY priority`,
    )
    .all(...userIds) as Array<{ user_id: number; preferred_user_id: number; priority: number }>;

  const standingByUser = new Map<number, number[]>();
  for (const row of standingRows) {
    const list = standingByUser.get(row.user_id) ?? [];
    list.push(row.preferred_user_id);
    standingByUser.set(row.user_id, list);
  }

  const namesById = new Map<number, string>();
  const lookupName = (id: number): string | null => {
    if (!namesById.has(id)) {
      const found = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(id) as
        | { first_name: string; last_name: string }
        | undefined;
      namesById.set(id, found ? `${found.first_name} ${found.last_name}` : '');
    }
    return namesById.get(id) || null;
  };

  return rows.map((row) => {
    const units = resolveUnits(db, row.id);
    const managerName = row.manager_id != null ? lookupName(row.manager_id) : null;
    const divisionLeaderName = units.division ? lookupName(units.division.id) : null;

    return {
      signupId: row.signup_id,
      userId: row.id,
      companyId: row.company_id,
      name: fullName(row),
      gender: row.gender,
      role: row.role,
      rankGroup: rankGroup(row.role),
      diet: row.signup_diet,
      managerId: row.manager_id,
      managerName,
      teamId: units.team?.id ?? null,
      teamName: units.team?.name ?? null,
      sectorId: units.sector?.id ?? null,
      sectorName: units.sector?.name ?? null,
      divisionId: units.division?.id ?? null,
      divisionName: units.division?.name ?? null,
      divisionLeaderName,
      preferences: preferencesBySignup.get(row.signup_id) ?? standingByUser.get(row.id) ?? [],
      carStatus: row.signup_car_status,
      carPassengerId: row.signup_car_passenger_id,
      workerType: row.worker_type,
      borrowedFrom: row.borrowed_from,
      borrowedMission: row.borrowed_mission,
    };
  });
}

/**
 * מי מהמשתתפים לא צריך מקום באוטובוס: רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי
 * שלהם (עובדה קבועה בתפקיד, לא תלויה בבקשה), ומי שקיבל אישור לבקשת רכב -
 * הוא והנוסע שלו. משמש לסינון לפני שיבוץ האוטובוסים (ראו buses.routes.ts).
 */
export function carTravelerIds(records: readonly ParticipantRecord[]): Set<number> {
  const ids = new Set<number>();
  for (const record of records) {
    if (alwaysBringsOwnCar(record.role)) {
      ids.add(record.userId);
      continue;
    }
    if (record.carStatus !== 'approved') continue;
    ids.add(record.userId);
    if (record.carPassengerId != null) ids.add(record.carPassengerId);
  }
  return ids;
}

export function toBusParticipant(record: ParticipantRecord): BusParticipant {
  return {
    userId: record.userId,
    name: record.name,
    teamId: record.teamId,
    teamName: record.teamName,
    sectorId: record.sectorId,
    sectorName: record.sectorName,
  };
}

export function toDormParticipant(record: ParticipantRecord): DormParticipant {
  return {
    userId: record.userId,
    name: record.name,
    gender: record.gender,
    rankGroup: record.rankGroup,
    sectorId: record.sectorId,
    sectorName: record.sectorName,
    teamId: record.teamId,
    teamName: record.teamName,
    managerId: record.managerId,
    preferences: record.preferences,
  };
}

/** כל חדרי הלינה של הגלישה, בפורמט שמנוע השיבוץ מצפה לו. */
export function loadTripRooms(tripId: number): DormRoom[] {
  return (
    db
      .prepare(
        `SELECT r.id AS room_id, r.name AS room_name, r.beds,
                st.id AS structure_id, st.name AS structure_name, st.gender
           FROM rooms r
           JOIN structures st ON st.id = r.structure_id
          WHERE st.trip_id = ?
          ORDER BY st.name, r.name`,
      )
      .all(tripId) as Array<{
      room_id: number;
      room_name: string;
      beds: number;
      structure_id: number;
      structure_name: string;
      gender: Gender;
    }>
  ).map((row) => ({
    roomId: row.room_id,
    roomName: row.room_name,
    structureId: row.structure_id,
    structureName: row.structure_name,
    gender: row.gender,
    beds: row.beds,
  }));
}

/**
 * בדיקת האילוצים לבחירת שותף לחדר.
 * מוחזר הסבר בעברית כדי שהלקוח יציג אותו כפי שהוא.
 */
export function checkRoommateEligibility(requester: UserRow, candidate: UserRow): string | null {
  if (requester.id === candidate.id) return 'אי אפשר לבחור את עצמך';
  if (candidate.status !== 'approved') return `${fullName(candidate)} אינו מאושר במערכת`;
  if (requester.gender !== candidate.gender) return 'בנים משובצים עם בנים ובנות עם בנות';
  if (rankGroup(requester.role) !== rankGroup(candidate.role)) {
    return 'חיילים משובצים עם חיילים, וכל דרג ניהולי משובץ רק עם בני אותו דרג בדיוק';
  }
  return null;
}

/** מוודא שהשיבוץ המבוקש עוד לא נעול. */
export function assertNotLocked(trip: TripRow, kind: 'buses' | 'dorms'): void {
  if (kind === 'buses' && trip.buses_locked_at) throw badRequest('שיבוץ האוטובוסים של הגלישה נעול');
  if (kind === 'dorms' && trip.dorms_locked_at) throw badRequest('שיבוץ הלינה של הגלישה נעול');
}
