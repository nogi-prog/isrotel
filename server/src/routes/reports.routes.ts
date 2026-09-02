import ExcelJS from 'exceljs';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { requireApproved, requireAuth, requireRole, requireTO, requireUser } from '../lib/auth.ts';
import { resolveUnits, subordinateIds } from '../lib/org.ts';
import { getSignup, getTripOr404, listCycles, loadCycleParticipants } from '../lib/trips.ts';
import { fullName, getUser } from '../lib/org.ts';
import { alwaysBringsOwnCar } from '../lib/cars.ts';
import { writeDataRow, writeSectionTitle, writeTableHeader } from '../lib/xlsx.ts';
import { ROLE_LABEL } from '../types.ts';
import type { Diet, WorkerType } from '../types.ts';

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();

const MEALS_PER_DAY = 3;
const DIETS: Diet[] = ['all', 'vegetarian', 'vegan'];

/**
 * דוח הזמנת מזון - אופרטיבי בלבד.
 * מפרט לכל פעימה כמה מנות נדרשות מכל סוג, וכמה סה״כ להזמנה מהספק.
 * הפעימה היא גל יציאה של יום אחד, ולכן המנות הן משתתפים כפול ארוחות ליום.
 */
reportsRouter.get('/:id/food', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));

  const rows = db
    .prepare(
      `SELECT s.cycle_id, s.diet, COUNT(*) AS count
         FROM signups s
        WHERE s.trip_id = ? AND s.status = 'approved' AND s.to_approved_at IS NOT NULL
        GROUP BY s.cycle_id, s.diet`,
    )
    .all(trip.id) as Array<{ cycle_id: number; diet: Diet; count: number }>;

  const byCycle = new Map<number, Map<Diet, number>>();
  for (const row of rows) {
    const entry = byCycle.get(row.cycle_id) ?? new Map<Diet, number>();
    entry.set(row.diet, row.count);
    byCycle.set(row.cycle_id, entry);
  }

  const cycles = listCycles(trip.id).map((cycle) => {
    const counts = byCycle.get(cycle.id) ?? new Map<Diet, number>();
    const participants = DIETS.reduce((sum, diet) => sum + (counts.get(diet) ?? 0), 0);

    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      exitDate: cycle.exit_date,
      mealsPerDay: MEALS_PER_DAY,
      participants,
      diets: DIETS.map((diet) => {
        const count = counts.get(diet) ?? 0;
        return { diet, participants: count, portions: count * MEALS_PER_DAY };
      }),
      totalPortions: participants * MEALS_PER_DAY,
    };
  });

  const totals = DIETS.map((diet) => ({
    diet,
    participants: cycles.reduce(
      (sum, cycle) => sum + (cycle.diets.find((entry) => entry.diet === diet)?.participants ?? 0),
      0,
    ),
    portions: cycles.reduce(
      (sum, cycle) => sum + (cycle.diets.find((entry) => entry.diet === diet)?.portions ?? 0),
      0,
    ),
  }));

  res.json({
    tripName: trip.name,
    mealsPerDay: MEALS_PER_DAY,
    cycles,
    totals,
    grandTotalPortions: totals.reduce((sum, entry) => sum + entry.portions, 0),
    grandTotalParticipants: totals.reduce((sum, entry) => sum + entry.participants, 0),
  });
});

/**
 * סיכום הגלישה האישי: הפעימה, מצב האישור, האוטובוס והחדר.
 * זה המסך שכל חייל רואה לפני היציאה.
 */
reportsRouter.get('/:id/summary', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const signup = getSignup(trip.id, user.id);

  if (!signup) {
    res.json({ signedUp: false });
    return;
  }

  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(signup.cycle_id) as
    | { id: number; name: string; exit_date: string }
    | undefined;

  const bus = db
    .prepare('SELECT bus_number FROM bus_assignments WHERE trip_id = ? AND user_id = ?')
    .get(trip.id, user.id) as { bus_number: number } | undefined;

  const room = db
    .prepare(
      `SELECT r.id AS room_id, r.name AS room_name, r.beds, st.name AS structure_name
         FROM room_assignments ra
         JOIN rooms r ON r.id = ra.room_id
         JOIN structures st ON st.id = r.structure_id
        WHERE ra.trip_id = ? AND ra.user_id = ?`,
    )
    .get(trip.id, user.id) as
    | { room_id: number; room_name: string; beds: number; structure_name: string }
    | undefined;

  const roommates = room
    ? (
        db
          .prepare(
            `SELECT u.id, u.first_name, u.last_name
               FROM room_assignments ra JOIN users u ON u.id = ra.user_id
              WHERE ra.room_id = ? AND ra.cycle_id = ? AND ra.user_id != ?
              ORDER BY u.last_name, u.first_name`,
          )
          .all(room.room_id, signup.cycle_id, user.id) as Array<{
          id: number;
          first_name: string;
          last_name: string;
        }>
      ).map((mate) => ({ id: mate.id, fullName: `${mate.first_name} ${mate.last_name}` }))
    : [];

  const preferences = db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name, p.priority
         FROM dorm_preferences p JOIN users u ON u.id = p.preferred_user_id
        WHERE p.signup_id = ? ORDER BY p.priority`,
    )
    .all(signup.id) as Array<{ id: number; first_name: string; last_name: string; priority: number }>;

  const carPassenger = signup.car_passenger_id != null ? getUser(db, signup.car_passenger_id) : null;
  const carPassengerName = carPassenger ? fullName(carPassenger) : null;

  // רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - עובדה קבועה, לא בקשה שממתינה לאישור.
  const ownCar = alwaysBringsOwnCar(user.role);

  res.json({
    signedUp: true,
    trip: { id: trip.id, name: trip.name, launchDate: trip.launch_date },
    signup: {
      status: signup.status,
      diet: signup.diet,
      dietConfirmed: signup.diet_confirmed === 1,
      decisionNote: signup.decision_note,
    },
    cycle: cycle ? { id: cycle.id, name: cycle.name, exitDate: cycle.exit_date } : null,
    preferences: preferences.map((row) => ({
      id: row.id,
      fullName: `${row.first_name} ${row.last_name}`,
      priority: row.priority,
      gotIt: roommates.some((mate) => mate.id === row.id),
    })),
    bus: trip.buses_locked_at ? { published: true, number: bus?.bus_number ?? null } : { published: false },
    car: ownCar
      ? { status: 'approved', passengerName: null, decisionNote: null, ownCar: true, carPlate: user.car_plate }
      : signup.car_status === 'none'
        ? null
        : {
            status: signup.car_status,
            passengerName: carPassengerName,
            decisionNote: signup.car_decision_note,
            ownCar: false,
            carPlate: null,
          },
    dorm: trip.dorms_locked_at
      ? {
          published: true,
          structureName: room?.structure_name ?? null,
          roomName: room?.room_name ?? null,
          beds: room?.beds ?? null,
          roommates,
        }
      : { published: false },
  });
});

/**
 * רשימת המשתתפים המאושרים.
 * אופרטיבי מקבל את כולם; מפקד מקבל רק את האנשים שלו.
 */
reportsRouter.get('/:id/participants', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const visibleIds = user.role === 'to' ? null : new Set([user.id, ...subordinateIds(db, user.id)]);

  const cycles = listCycles(trip.id).map((cycle) => {
    // requireToApproval: false - מציג גם מי שהמפקד אישר אבל האופרטיבי עדיין לא,
    // כדי שיהיה מה לסקור/לאשר במסך הזה (ראו POST .../to-approve).
    const all = loadCycleParticipants(cycle.id, { requireToApproval: false });
    const visible = visibleIds ? all.filter((person) => visibleIds.has(person.userId)) : all;

    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      exitDate: cycle.exit_date,
      totalApproved: all.length,
      totalToApproved: all.filter((person) => person.toApprovedAt != null).length,
      participants: visible.map((person) => ({
        signupId: person.signupId,
        userId: person.userId,
        companyId: person.companyId,
        fullName: person.name,
        gender: person.gender,
        role: person.role,
        diet: person.diet,
        teamName: person.teamName,
        sectorName: person.sectorName,
        managerName: person.managerName,
        toApprovedAt: person.toApprovedAt,
      })),
    };
  });

  res.json({ scope: user.role === 'to' ? 'all' : 'my-people', cycles });
});

// --- ייצוא Excel -------------------------------------------------------------

const GENDER_LABEL_HE: Record<'male' | 'female', string> = { male: 'זכר', female: 'נקבה' };
const DIET_LABEL_HE: Record<Diet, string> = { all: 'הכל', vegetarian: 'צמחוני', vegan: 'טבעוני' };
// מונחי הגיליון המקורי שבו נוהלו הגלישות לפני המערכת (רגיל/הצח/מיל), לא התיוג
// המילולי המלא שמוצג במסך הפרופיל (WORKER_TYPE_LABEL בקליינט).
const WORKER_TYPE_LABEL_HE: Record<WorkerType, string> = { regular: 'רגיל', borrowed: 'הצח', reserve: 'מיל' };

const COLOR_TITLE_FILL = 'FF6C3483'; // סגול כהה - כותרת ראשית, כמו בייצוא בקשת הלינה
const COLOR_HEADER_FILL = 'FFD2B4DE'; // סגול בהיר - שורת כותרות העמודות

const EXPORT_HEADER = [
  'פעימה',
  'תאריך יציאה',
  'שם מלא',
  'מספר אישי',
  'תפקיד',
  'מעמד',
  'מדור',
  'צוות',
  'מפקד ישיר',
  'מין',
  'תזונה',
  'תזונה אושרה',
  'הגעה',
  'מספר רכב',
  'מבנה לינה',
  'חדר',
  'שותפים לחדר',
  'הערות',
];
const EXPORT_COLUMN_WIDTHS = [10, 12, 18, 12, 10, 8, 14, 14, 16, 6, 10, 12, 22, 12, 14, 8, 26, 26];

const BORROWED_HEADER = ['שם חייל', 'איפה נמצא', 'לאן ההצח', 'מה המשימה', 'מי ביצר מטפל'];
const BORROWED_COLUMN_WIDTHS = [18, 16, 16, 40, 16];

const CARS_HEADER = ['פעימה', 'שם נהג', 'תפקיד', 'מספר אישי', 'מספר רכב', 'נוסע'];
const CARS_COLUMN_WIDTHS = [10, 18, 10, 12, 14, 18];

const DORMS_HEADER = ['פעימה', 'מבנה', 'חדר', 'מיטות', 'משתתפים'];
const DORMS_COLUMN_WIDTHS = [10, 16, 10, 8, 40];

const DUTY_HEADER = ['חייל', 'מדור', 'סוג תורנות', 'איפה מתקיימת', 'תאריכים', 'סטאטוס טיפול'];
const DUTY_COLUMN_WIDTHS = [18, 14, 16, 14, 14, 20];

/** גיליון פשוט - כותרת, שורת עמודות ונתונים. לא נוצר כשאין שורות, כדי לא לבלבל עם גיליון ריק. */
function addSimpleSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  title: string,
  header: string[],
  widths: number[],
  rows: Array<Array<string | number>>,
): void {
  if (rows.length === 0) return;
  const sheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  sheet.columns = widths.map((width) => ({ width }));

  let row = 1;
  writeSectionTitle(sheet, row, title, COLOR_TITLE_FILL, header.length);
  row += 1;
  writeTableHeader(sheet, row, header, COLOR_HEADER_FILL);
  row += 1;
  for (const values of rows) {
    writeDataRow(sheet, row, values);
    row += 1;
  }
}

/**
 * סיכום הגלישה ל-Excel, מקביל לגיליון שבו נוהלו הגלישות לפני המערכת - כולל
 * הלשוניות הנוספות שהיו בו. חמישה גיליונות, כל אחד מדולג כשאין לו שורות:
 *  1. "רשימת משתתפים" - שורה אחת לכל משתתף מאושר בכל פעימה: שיוך ארגוני,
 *     מעמד (רגיל/הצח/מיל), תזונה, אופן הגעה ולינה.
 *  2. "הצחים" - כל מי שהוא חייל מושאל (worker_type='borrowed') בגלישה הזאת:
 *     מאיפה, לאן, מה המשימה, ומי הרת״ח שמטפל (הקרוב ביותר בשרשרת - resolveUnits).
 *  3. "רכבים" - כל מי שמגיע ברכב פרטי. בניגוד למסמך המקורי, לכל רכב נהג
 *     ונוסע אחד בלבד לכל היותר - כלל עסקי מכוון (ראו lib/cars.ts).
 *  4. "לינה" - כל חדר בפועל אחרי נעילת שיבוץ הלינה, עם רשימת הדיירים.
 *  5. "תורנויות" - כל מי שדווח שיש לו תורנות/משמרת לבטל (shift_reports).
 * לא כולל אלרגיות - שדה שאין לו מקבילה במסד הנתונים. אופרטיבי מקבל את כל
 * הגלישה; רת״ח מקבל רק את התחום שלו - כמו ב-/participants.
 */
reportsRouter.get('/:id/export.xlsx', requireRole('to', 'division_leader'), async (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const visibleIds = user.role === 'to' ? null : new Set([user.id, ...subordinateIds(db, user.id)]);

  const busRows = db
    .prepare('SELECT cycle_id, user_id, bus_number FROM bus_assignments WHERE trip_id = ?')
    .all(trip.id) as Array<{ cycle_id: number; user_id: number; bus_number: number }>;
  const busByKey = new Map(busRows.map((row) => [`${row.cycle_id}:${row.user_id}`, row.bus_number]));

  const roomRows = db
    .prepare(
      `SELECT ra.cycle_id, ra.user_id, ra.room_id, r.name AS room_name, r.beds, st.name AS structure_name,
              u.first_name, u.last_name
         FROM room_assignments ra
         JOIN rooms r ON r.id = ra.room_id
         JOIN structures st ON st.id = r.structure_id
         JOIN users u ON u.id = ra.user_id
        WHERE ra.trip_id = ?`,
    )
    .all(trip.id) as Array<{
    cycle_id: number;
    user_id: number;
    room_id: number;
    room_name: string;
    beds: number;
    structure_name: string;
    first_name: string;
    last_name: string;
  }>;
  const roomByKey = new Map(roomRows.map((row) => [`${row.cycle_id}:${row.user_id}`, row]));
  const roommateIdsByRoom = new Map<string, number[]>();
  for (const row of roomRows) {
    const key = `${row.cycle_id}:${row.room_id}`;
    const list = roommateIdsByRoom.get(key) ?? [];
    list.push(row.user_id);
    roommateIdsByRoom.set(key, list);
  }

  // גיליון "לינה" - לכל חדר בפועל (אחרי נעילת השיבוץ), פעימה, מבנה, מיטות
  // ורשימת כל הדיירים - כמו הרשימה המלאה שרואים ב-DormsPage, לא רק החדר של
  // אדם אחד כמו בגיליון הראשי. מוצג רק חדר שיש בו לפחות אדם אחד גלוי למבקש -
  // אותו כלל כמו ברכבים (loadCarTravelers ב-buses.routes.ts).
  const cycleNames = new Map(listCycles(trip.id).map((cycle) => [cycle.id, cycle.name]));
  const dormGroups = new Map<
    string,
    { cycleId: number; roomId: number; structureName: string; roomName: string; beds: number; occupants: string[] }
  >();
  for (const row of roomRows) {
    const key = `${row.cycle_id}:${row.room_id}`;
    const group = dormGroups.get(key) ?? {
      cycleId: row.cycle_id,
      roomId: row.room_id,
      structureName: row.structure_name,
      roomName: row.room_name,
      beds: row.beds,
      occupants: [],
    };
    group.occupants.push(`${row.first_name} ${row.last_name}`);
    dormGroups.set(key, group);
  }
  const dormRows = [...dormGroups.values()]
    .filter((group) =>
      visibleIds ? (roommateIdsByRoom.get(`${group.cycleId}:${group.roomId}`) ?? []).some((id) => visibleIds.has(id)) : true,
    )
    .sort((a, b) => a.structureName.localeCompare(b.structureName) || a.roomName.localeCompare(b.roomName))
    .map((group) => [
      cycleNames.get(group.cycleId) ?? '',
      group.structureName,
      group.roomName,
      group.beds,
      group.occupants.join(', '),
    ]);

  const signupExtraRows = db
    .prepare(
      `SELECT s.id AS signup_id, s.notes, s.diet_confirmed, u.car_plate
         FROM signups s
         JOIN users u ON u.id = s.user_id
        WHERE s.trip_id = ? AND s.status = 'approved'`,
    )
    .all(trip.id) as Array<{ signup_id: number; notes: string | null; diet_confirmed: number; car_plate: string | null }>;
  const extraBySignup = new Map(signupExtraRows.map((row) => [row.signup_id, row]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('רשימת משתתפים', { views: [{ rightToLeft: true }] });
  sheet.columns = EXPORT_COLUMN_WIDTHS.map((width) => ({ width }));

  let row = 1;
  writeSectionTitle(sheet, row, `רשימת משתתפים · ${trip.name}`, COLOR_TITLE_FILL, EXPORT_HEADER.length);
  row += 1;
  writeTableHeader(sheet, row, EXPORT_HEADER, COLOR_HEADER_FILL);
  row += 1;

  const borrowedRows: Array<Array<string | number>> = [];
  const carRows: Array<Array<string | number>> = [];

  for (const cycle of listCycles(trip.id)) {
    // הרשימה המלאה נשארת לחיפוש שמות (נהג/נוסע/שותף לחדר עשויים להיות מחוץ
    // לתחום של הרת״ח), אבל שורה מיוצאת רק למי שנמצא ב-visibleIds.
    // ייצוא ביניים שימושי גם באמצע הגלישה - כמו מסך המשתתפים, מציג גם מי
    // שממתין לאישור האופרטיבי (requireToApproval: false).
    const participants = loadCycleParticipants(cycle.id, { requireToApproval: false });
    if (participants.length === 0) continue;
    const visible = visibleIds ? participants.filter((person) => visibleIds.has(person.userId)) : participants;
    if (visible.length === 0) continue;

    const byUserId = new Map(participants.map((person) => [person.userId, person]));
    const passengerToDriver = new Map<number, (typeof participants)[number]>();
    for (const person of participants) {
      if (person.carStatus === 'approved' && person.carPassengerId != null) {
        passengerToDriver.set(person.carPassengerId, person);
      }
    }

    for (const person of visible) {
      const extra = extraBySignup.get(person.signupId);
      const room = roomByKey.get(`${cycle.id}:${person.userId}`);
      const roommates = room
        ? (roommateIdsByRoom.get(`${cycle.id}:${room.room_id}`) ?? [])
            .filter((id) => id !== person.userId)
            .map((id) => byUserId.get(id)?.name)
            .filter((name): name is string => !!name)
        : [];

      let arrival: string;
      let carPlate = '';
      const ownCar = alwaysBringsOwnCar(person.role);
      if (ownCar || person.carStatus === 'approved') {
        const passengerName = person.carPassengerId != null ? byUserId.get(person.carPassengerId)?.name : null;
        arrival = passengerName ? `רכב פרטי (עם ${passengerName})` : 'רכב פרטי';
        carPlate = extra?.car_plate ?? '';
        carRows.push([
          cycle.name,
          person.name,
          ROLE_LABEL[person.role],
          person.companyId,
          carPlate || 'לא הוזן',
          passengerName ?? '',
        ]);
      } else {
        const driver = passengerToDriver.get(person.userId);
        const busNumber = busByKey.get(`${cycle.id}:${person.userId}`);
        arrival = driver ? `נוסע ברכב עם ${driver.name}` : busNumber != null ? `אוטובוס ${busNumber}` : '—';
      }

      writeDataRow(sheet, row, [
        cycle.name,
        cycle.exit_date,
        person.name,
        person.companyId,
        ROLE_LABEL[person.role],
        WORKER_TYPE_LABEL_HE[person.workerType],
        person.sectorName ?? '',
        person.teamName ?? '',
        person.managerName ?? '',
        GENDER_LABEL_HE[person.gender],
        DIET_LABEL_HE[person.diet],
        extra?.diet_confirmed ? 'כן' : 'לא',
        arrival,
        carPlate,
        room?.structure_name ?? '',
        room?.room_name ?? '',
        roommates.join(', '),
        extra?.notes ?? '',
      ]);
      row += 1;

      if (person.workerType === 'borrowed') {
        borrowedRows.push([
          person.name,
          person.borrowedFrom ?? '',
          person.teamName ?? person.sectorName ?? '',
          person.borrowedMission ?? '',
          person.divisionLeaderName ?? '',
        ]);
      }
    }
  }

  // גיליון "הצחים" - כמו הלשונית המקבילה במסמך המקורי, רק מי שהוא חייל מושאל בגלישה הזאת.
  addSimpleSheet(workbook, 'הצחים', `הצחים · ${trip.name}`, BORROWED_HEADER, BORROWED_COLUMN_WIDTHS, borrowedRows);

  // גיליון "רכבים" - כמו הלשונית המקבילה במסמך המקורי, כל מי שמגיע ברכב פרטי.
  // בניגוד למסמך המקורי, לכל רכב נהג ונוסע אחד בלבד לכל היותר - זה כלל עסקי
  // מכוון של המערכת (ראו lib/cars.ts), לא מגבלה טכנית.
  addSimpleSheet(workbook, 'רכבים', `רכבים · ${trip.name}`, CARS_HEADER, CARS_COLUMN_WIDTHS, carRows);

  // גיליון "לינה" - כמו הלשונית המקבילה במסמך המקורי, קיים רק אחרי נעילת
  // שיבוץ הלינה (לפני כן אין עדיין room_assignments אמיתיים).
  addSimpleSheet(workbook, 'לינה', `לינה · ${trip.name}`, DORMS_HEADER, DORMS_COLUMN_WIDTHS, dormRows);

  // גיליון "תורנויות" - כמו הלשונית המקבילה במסמך המקורי, כל מי שדווח שיש לו
  // תורנות/משמרת שצריך לבטל בגלל הגלישה (shift_reports, ראו shifts.routes.ts).
  // לא תלוי בפעימה/שיבוץ - דיווח עצמאי על אדם בגלישה, ולכן נטען בנפרד.
  const dutyRows = (
    db
      .prepare(
        `SELECT sr.user_id, sr.duty_type, sr.duty_location, sr.duty_dates, sr.handling_status,
                u.first_name, u.last_name
           FROM shift_reports sr
           JOIN users u ON u.id = sr.user_id
          WHERE sr.trip_id = ? AND sr.has_shift = 1`,
      )
      .all(trip.id) as Array<{
      user_id: number;
      duty_type: string | null;
      duty_location: string | null;
      duty_dates: string | null;
      handling_status: string | null;
      first_name: string;
      last_name: string;
    }>
  )
    .filter((row) => !visibleIds || visibleIds.has(row.user_id))
    .map((row) => [
      `${row.first_name} ${row.last_name}`,
      resolveUnits(db, row.user_id).sector?.name ?? '',
      row.duty_type ?? '',
      row.duty_location ?? '',
      row.duty_dates ?? '',
      row.handling_status ?? '',
    ]);
  addSimpleSheet(workbook, 'תורנויות', `תורנויות · ${trip.name}`, DUTY_HEADER, DUTY_COLUMN_WIDTHS, dutyRows);

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="trip-${trip.id}-roster.xlsx"`);
  res.send(Buffer.from(buffer));
});
