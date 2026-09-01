import ExcelJS from 'exceljs';
import { Router } from 'express';
import { z } from 'zod';
import { db, plain, tx } from '../db/index.ts';
import { requireApproved, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { subordinateIds } from '../lib/org.ts';
import { notify, notifyMany } from '../lib/notify.ts';
import {
  getTripOr404,
  listCycles,
  loadCycleParticipants,
  loadTripRooms,
  toDormParticipant,
} from '../lib/trips.ts';
import {
  allocateDorms,
  MAX_ROOM_BEDS,
  planDormRooms,
  type DormAllocationResult,
  type DormParticipant,
  type DormPlanRoom,
  type DormPlanSizeCount,
} from '../services/dormAllocation.ts';
import { ROLE_LABEL_PLURAL } from '../types.ts';
import type { DormIssueRow, Gender, RankGroup, StructureRow } from '../types.ts';
import { CELL_BORDER, writeDataRow, writeSectionTitle, writeTableHeader } from '../lib/xlsx.ts';

export const dormsRouter = Router();

dormsRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();

const structureSchema = z.object({
  name: z.string().trim().min(1, 'חובה להזין שם למבנה').max(60),
  gender: z.enum(['male', 'female'], { message: 'כל מבנה משויך למין אחד: בנים או בנות' }),
  rooms: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'חובה להזין מספר או שם לחדר').max(20),
        beds: z.number().int().positive('מספר המיטות חייב להיות חיובי').max(30),
      }),
    )
    .default([]),
});

const roomSchema = z.object({
  name: z.string().trim().min(1, 'חובה להזין מספר או שם לחדר').max(20),
  beds: z.number().int().positive('מספר המיטות חייב להיות חיובי').max(30),
});

// --- מלאי הלינה (אופרטיבי מגדיר, כולם יכולים לראות) ----------------------

/** כל מבני הלינה של הגלישה, כולל חדרים ותפוסה נוכחית. */
dormsRouter.get('/:id/structures', (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));

  const structures = db
    .prepare('SELECT * FROM structures WHERE trip_id = ? ORDER BY gender, name')
    .all(trip.id)
    .map((row) => plain<StructureRow>(row));

  const rooms = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM room_assignments ra WHERE ra.room_id = r.id) AS assigned
         FROM rooms r
         JOIN structures st ON st.id = r.structure_id
        WHERE st.trip_id = ?
        ORDER BY r.name`,
    )
    .all(trip.id) as Array<{ id: number; structure_id: number; name: string; beds: number; assigned: number }>;

  res.json({
    structures: structures.map((structure) => {
      const structureRooms = rooms.filter((room) => room.structure_id === structure.id);
      return {
        id: structure.id,
        name: structure.name,
        gender: structure.gender,
        totalBeds: structureRooms.reduce((sum, room) => sum + room.beds, 0),
        rooms: structureRooms.map((room) => ({
          id: room.id,
          name: room.name,
          beds: room.beds,
          assigned: room.assigned,
        })),
      };
    }),
  });
});

dormsRouter.post('/:id/structures', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.dorms_locked_at) throw badRequest('שיבוץ הלינה נעול - יש לבטל את הנעילה לפני שינוי מבנים');

  const parsed = structureSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני המבנה אינם תקינים');
  const input = parsed.data;

  const structureId = tx(() => {
    const row = db
      .prepare('INSERT INTO structures (trip_id, name, gender) VALUES (?, ?, ?) RETURNING id')
      .get(trip.id, input.name, input.gender) as { id: number };

    const insertRoom = db.prepare('INSERT INTO rooms (structure_id, name, beds) VALUES (?, ?, ?)');
    for (const room of input.rooms) insertRoom.run(row.id, room.name, room.beds);
    return row.id;
  });

  res.status(201).json({ structureId });
});

dormsRouter.delete('/:id/structures/:structureId', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.dorms_locked_at) throw badRequest('שיבוץ הלינה נעול - יש לבטל את הנעילה לפני שינוי מבנים');

  const structureId = idParam.parse(req.params.structureId);
  const result = db.prepare('DELETE FROM structures WHERE id = ? AND trip_id = ?').run(structureId, trip.id);
  if (result.changes === 0) throw notFound('המבנה לא נמצא');

  res.json({ ok: true });
});

dormsRouter.post('/:id/structures/:structureId/rooms', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.dorms_locked_at) throw badRequest('שיבוץ הלינה נעול - יש לבטל את הנעילה לפני שינוי חדרים');

  const structureId = idParam.parse(req.params.structureId);
  const structure = db.prepare('SELECT * FROM structures WHERE id = ? AND trip_id = ?').get(structureId, trip.id);
  if (!structure) throw notFound('המבנה לא נמצא');

  const parsed = roomSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני החדר אינם תקינים');

  db.prepare('INSERT INTO rooms (structure_id, name, beds) VALUES (?, ?, ?)').run(
    structureId,
    parsed.data.name,
    parsed.data.beds,
  );

  res.status(201).json({ ok: true });
});

dormsRouter.delete('/:id/rooms/:roomId', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.dorms_locked_at) throw badRequest('שיבוץ הלינה נעול - יש לבטל את הנעילה לפני שינוי חדרים');

  const roomId = idParam.parse(req.params.roomId);
  const result = db
    .prepare(
      `DELETE FROM rooms
        WHERE id = ? AND structure_id IN (SELECT id FROM structures WHERE trip_id = ?)`,
    )
    .run(roomId, trip.id);
  if (result.changes === 0) throw notFound('החדר לא נמצא');

  res.json({ ok: true });
});

// --- שיבוץ הלינה ----------------------------------------------------------

interface CycleDormResult {
  cycleId: number;
  cycleName: string;
  exitDate: string;
  participants: DormParticipant[];
  result: DormAllocationResult;
}

/**
 * מריץ את מנוע שיבוץ הלינה לכל פעימה בנפרד.
 * אותם חדרים משמשים בכל פעימה, כי הפעימות יוצאות בתאריכים שונים.
 */
function computeAllCycles(tripId: number): CycleDormResult[] {
  const rooms = loadTripRooms(tripId);
  return listCycles(tripId).map((cycle) => {
    const participants = loadCycleParticipants(cycle.id).map(toDormParticipant);
    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      exitDate: cycle.exit_date,
      participants,
      result: allocateDorms(participants, rooms),
    };
  });
}

/** מבנה "תוספת" למי שאין לו מקום במבנים הקיימים - נוצר לפי הצורך, לא מראש. */
function ensureOverflowStructureId(tripId: number, gender: Gender): number {
  const name = gender === 'male' ? 'מבנה תוספת (בנים)' : 'מבנה תוספת (בנות)';
  const existing = db
    .prepare('SELECT id FROM structures WHERE trip_id = ? AND gender = ? AND name = ?')
    .get(tripId, gender, name) as { id: number } | undefined;
  if (existing) return existing.id;

  const created = db
    .prepare('INSERT INTO structures (trip_id, name, gender) VALUES (?, ?, ?) RETURNING id')
    .get(tripId, name, gender) as { id: number };
  return created.id;
}

/**
 * אין אפשרות שמישהו יישאר בלי מיטה: אם אחרי שיבוץ כל הפעימות נשארו אנשים
 * לא משובצים, פותחים עוד חדרים (בגודל המועדף, 8 מיטות - ראו dormAllocation.ts)
 * במבנה "תוספת" לפי מין, ומריצים שוב. החוסר נמדד כמקסימום בין הפעימות ולא
 * כסכומן, כי אותם חדרים משמשים כל פעימה בנפרד (ראו computeAllCycles).
 * חוזר עם התוצאה הסופית וכמה חדרים נוספו בפועל.
 */
function ensureEveryoneHasABed(
  tripId: number,
  computed: CycleDormResult[],
): { computed: CycleDormResult[]; roomsAdded: number } {
  let current = computed;
  let roomsAdded = 0;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const worstDeficitByGender = new Map<Gender, number>();
    for (const entry of current) {
      const placedIds = new Set(entry.result.placements.map((placement) => placement.userId));
      const unassigned = entry.participants.filter((person) => !placedIds.has(person.userId));
      const byGender = new Map<Gender, number>();
      for (const person of unassigned) byGender.set(person.gender, (byGender.get(person.gender) ?? 0) + 1);
      for (const [gender, count] of byGender) {
        worstDeficitByGender.set(gender, Math.max(worstDeficitByGender.get(gender) ?? 0, count));
      }
    }

    if (worstDeficitByGender.size === 0) break;

    const insertRoom = db.prepare('INSERT INTO rooms (structure_id, name, beds) VALUES (?, ?, ?)');
    for (const [gender, deficit] of worstDeficitByGender) {
      const structureId = ensureOverflowStructureId(tripId, gender);
      const alreadyThere = (
        db.prepare('SELECT COUNT(*) AS c FROM rooms WHERE structure_id = ?').get(structureId) as { c: number }
      ).c;
      const roomsNeeded = Math.ceil(deficit / MAX_ROOM_BEDS);
      for (let index = 0; index < roomsNeeded; index += 1) {
        insertRoom.run(structureId, `תוספת ${alreadyThere + index + 1}`, MAX_ROOM_BEDS);
      }
      roomsAdded += roomsNeeded;
    }

    current = computeAllCycles(tripId);
  }

  return { computed: current, roomsAdded };
}

/** תצוגה מקדימה של שיבוץ הלינה, ללא שמירה - אופרטיבי בלבד. */
dormsRouter.get('/:id/dorms/preview', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  res.json({ cycles: computeAllCycles(trip.id) });
});

/**
 * כמה חדרים *נוספים* על מה שכבר סופק לפעימות קודמות (לפי סדר יציאה) תדרוש כל
 * פעימה - כי אותם חדרים משמשים את כל הפעימות בתורן (מי שיצא קודם כבר פינה
 * עד שהפעימה הבאה יוצאת). פעימה קטנה מהמצטבר עד כה לא דורשת שום חדר נוסף -
 * היא פשוט נכנסת לחדרים שכבר הוזמנו; רק חריגה מעל השיא שנראה עד כה, לכל מין
 * בנפרד, דורשת הזמנה נוספת מהספק.
 */
function extraRoomsNeededPerCycle(cyclePlans: readonly { sizeCounts: DormPlanSizeCount[] }[]): number[] {
  const cumulativeMaxByGender = new Map<Gender, number>();
  return cyclePlans.map((plan) => {
    const roomsByGender = new Map<Gender, number>();
    for (const entry of plan.sizeCounts) {
      roomsByGender.set(entry.gender, (roomsByGender.get(entry.gender) ?? 0) + entry.count);
    }
    let extra = 0;
    for (const [gender, count] of roomsByGender) {
      const previousMax = cumulativeMaxByGender.get(gender) ?? 0;
      if (count > previousMax) extra += count - previousMax;
      cumulativeMaxByGender.set(gender, Math.max(previousMax, count));
    }
    return extra;
  });
}

/**
 * תוכנית לינה מוקדמת - כמה חדרים ובאיזה גודל (4-8 מיטות) צריך להזמין מהספק,
 * לפני שיש מבני לינה אמיתיים במערכת. אופרטיבי בלבד. ראו planDormRooms
 * ב-dormAllocation.ts להסבר המלא על השיטה. `extraRoomsNeeded` לכל פעימה
 * מניח שאותם חדרים מתפנים ומשמשים שוב לפעימה הבאה - ראו extraRoomsNeededPerCycle.
 */
dormsRouter.get('/:id/dorms/plan', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycles = listCycles(trip.id).map((cycle) => ({
    cycleId: cycle.id,
    cycleName: cycle.name,
    exitDate: cycle.exit_date,
    plan: planDormRooms(loadCycleParticipants(cycle.id).map(toDormParticipant)),
  }));
  const extras = extraRoomsNeededPerCycle(cycles.map((cycle) => cycle.plan));
  res.json({ cycles: cycles.map((cycle, index) => ({ ...cycle, extraRoomsNeeded: extras[index] })) });
});

const GENDER_LABEL_HE: Record<Gender, string> = { male: 'בנים', female: 'בנות' };

const NO_DIVISION_LABEL = 'ללא שיוך לתחום';

/** שם קבוצת הדרג בעברית, לכותרת חדר - "חיילים" לחיילים, אחרת שם התפקיד ברבים. */
function rankGroupLabelHe(group: RankGroup): string {
  return group === 'soldier' ? ROLE_LABEL_PLURAL.employee : ROLE_LABEL_PLURAL[group];
}

// צבעי עיצוב לגיליון - בהשראת הטבלאות הצבעוניות שמשמשות בפועל לבקשת לינה מהספק.
const COLOR_TITLE_FILL = 'FF6C3483'; // סגול כהה - כותרת ראשית
const COLOR_SUMMARY_HEADER_FILL = 'FFD2B4DE'; // סגול בהיר - כותרת טבלת הסיכום
const COLOR_DIVISION_HEADER_FILL = 'FFA9CCE3'; // תכלת - כותרת טבלת תחום
const COLOR_ROOM_HEADER_FILL: Record<Gender, string> = {
  male: 'FFAED6F1', // תכלת בהיר - כותרת חדר בנים
  female: 'FFF5B7B1', // ורוד בהיר - כותרת חדר בנות
};
const COLUMN_COUNT = 3;

const COLOR_CYCLE_SUBHEADER_FILL = 'FFEDEDED'; // אפור בהיר - כותרת משנה של פעימה בתוך בלוק חדר

/** כותרת משנה בתוך בלוק חדר - איזו פעימה בדיוק ישנה בו, עדינה יותר מכותרת הבלוק. */
function writeCycleSubHeader(sheet: ExcelJS.Worksheet, row: number, text: string): void {
  sheet.mergeCells(row, 1, row, COLUMN_COUNT);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, italic: true, size: 10 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_CYCLE_SUBHEADER_FILL } };
  cell.border = CELL_BORDER;
  cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
}

/**
 * ייצוא ה-Excel של תוכנית הלינה המוקדמת - אופרטיבי בלבד. שלושה חלקים, בסדר
 * הזה: (1) כמה חדרים ובאיזה גודל לבקש מהספק לכל מין - המקסימום הנדרש בכל
 * פעימה, כי אותם חדרים משמשים בכל הפעימות (ראו planDormRooms); (2) טבלה
 * נפרדת לכל תחום עם פילוח האנשים שלו לפי מין, לתיאום מול המדורים - לא כי
 * החדרים בפועל שמורים לתחום מסוים; (3) לכל פעימה, טבלה נפרדת לכל חדר
 * מתוכנן עם מי בדיוק ישן בו - כדי לראות "מי ישן עם מי" עוד לפני שידועים
 * מבני הלינה האמיתיים. הגיליון בנוי RTL ומעוצב בהשראת טבלאות הלינה הנהוגות
 * בפועל (כותרות צבעוניות, מסגרות לכל תא, בלוק נפרד לכל חדר).
 */
dormsRouter.get('/:id/dorms/plan.xlsx', requireTO, async (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycles = listCycles(trip.id).map((cycle) => {
    const participants = loadCycleParticipants(cycle.id);
    const divisionByUserId = new Map(participants.map((person) => [person.userId, person.divisionName]));
    return {
      cycleName: cycle.name,
      exitDate: cycle.exit_date,
      participants,
      divisionByUserId,
      plan: planDormRooms(participants.map(toDormParticipant)),
    };
  });

  const peakByGender = new Map<Gender, number>();
  for (const cycle of cycles) {
    for (const entry of cycle.plan.sizeCounts) {
      peakByGender.set(entry.gender, Math.max(peakByGender.get(entry.gender) ?? 0, entry.count));
    }
  }

  // פילוח אנשים (לא חדרים - החדרים אינם מופרדים לפי תחום) לפי תחום ומין,
  // באותה שיטת "שיא בין הפעימות" כמו סיכום החדרים למעלה.
  const peakByDivisionGender = new Map<string, Map<Gender, number>>();
  for (const cycle of cycles) {
    const counts = new Map<string, Map<Gender, number>>();
    for (const person of cycle.participants) {
      const division = person.divisionName ?? NO_DIVISION_LABEL;
      const byGender = counts.get(division) ?? new Map<Gender, number>();
      byGender.set(person.gender, (byGender.get(person.gender) ?? 0) + 1);
      counts.set(division, byGender);
    }
    for (const [division, byGender] of counts) {
      const peak = peakByDivisionGender.get(division) ?? new Map<Gender, number>();
      for (const [gender, count] of byGender) {
        peak.set(gender, Math.max(peak.get(gender) ?? 0, count));
      }
      peakByDivisionGender.set(division, peak);
    }
  }
  const divisionNames = [...peakByDivisionGender.keys()].sort((a, b) => a.localeCompare(b));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('בקשת לינה', { views: [{ rightToLeft: true }] });
  sheet.columns = [{ width: 16 }, { width: 30 }, { width: 22 }];

  let row = 1;

  // (1) סיכום הבקשה לספק.
  writeSectionTitle(sheet, row, `סיכום הבקשה לספק · ${trip.name}`, COLOR_TITLE_FILL, COLUMN_COUNT);
  row += 1;
  writeTableHeader(sheet, row, ['מין', 'גודל חדר (מיטות)', 'כמות חדרים לבקש'], COLOR_SUMMARY_HEADER_FILL);
  row += 1;
  if (peakByGender.size === 0) {
    writeDataRow(sheet, row, ['אין עדיין משתתפים מאושרים באף פעימה', '', '']);
    row += 1;
  } else {
    for (const [gender, count] of peakByGender) {
      writeDataRow(sheet, row, [GENDER_LABEL_HE[gender], MAX_ROOM_BEDS, count]);
      row += 1;
    }
  }

  // (2) טבלה נפרדת לכל תחום.
  for (const division of divisionNames) {
    const byGender = peakByDivisionGender.get(division)!;
    row += 1;
    writeSectionTitle(sheet, row, division, COLOR_TITLE_FILL, COLUMN_COUNT);
    row += 1;
    writeTableHeader(sheet, row, ['מין', 'אנשים', ''], COLOR_DIVISION_HEADER_FILL);
    row += 1;
    for (const [gender, count] of byGender) {
      writeDataRow(sheet, row, [GENDER_LABEL_HE[gender], count, '']);
      row += 1;
    }
  }

  // (3) בלוק אחד לכל חדר מתוכנן (מין+דרג), לא לכל פעימה - כי אותו חדר מתפנה
  // ומשמש שוב בפעימה הבאה. בתוך כל בלוק, כותרת-משנה לכל פעימה שבאמת ישנה בו,
  // בסדר יציאה - כך רואים בבירור שמדובר באותו חדר "מתגלגל" ולא בחדר נוסף.
  const cyclesWithPeople = cycles.filter((cycle) => cycle.plan.totalPeople > 0);
  if (cyclesWithPeople.length > 0) {
    row += 1;
    writeSectionTitle(
      sheet,
      row,
      'חדרים מתוכננים - אותו חדר משמש כל פעימה בתורה, לפי סדר היציאה',
      COLOR_TITLE_FILL,
      COLUMN_COUNT,
    );
    row += 1;

    // עבור כל פעימה, קיבוץ החדרים שלה לפי (מין, דרג), בסדר שהמנוע החזיר - ראו
    // הסבר סדר הבלוקים והשיבוץ לתוך "משבצת" קבועה למטה.
    type Bucket = `${Gender}:${RankGroup}`;
    const bucketOrder: Bucket[] = [];
    // לכל משבצת (מין+דרג): מערך לפי מספר סידורי של החדר (0, 1, 2, ...), וכל
    // איבר בו - רשימת הפעימות שבאמת השתמשו במשבצת הזאת, עם הדיירים שלהן.
    const slotsByBucket = new Map<Bucket, Array<Array<{ cycle: (typeof cyclesWithPeople)[number]; room: DormPlanRoom }>>>();

    for (const cycle of cyclesWithPeople) {
      const roomsByBucket = new Map<Bucket, DormPlanRoom[]>();
      for (const dormRoom of cycle.plan.rooms) {
        const key: Bucket = `${dormRoom.gender}:${dormRoom.rankGroup}`;
        const list = roomsByBucket.get(key) ?? [];
        list.push(dormRoom);
        roomsByBucket.set(key, list);
      }
      for (const [bucket, dormRooms] of roomsByBucket) {
        if (!slotsByBucket.has(bucket)) {
          slotsByBucket.set(bucket, []);
          bucketOrder.push(bucket);
        }
        const slots = slotsByBucket.get(bucket)!;
        dormRooms.forEach((room, slotIndex) => {
          const entry = (slots[slotIndex] ??= []);
          entry.push({ cycle, room });
        });
      }
    }

    for (const bucket of bucketOrder) {
      const [gender, rankGroup] = bucket.split(':') as [Gender, RankGroup];
      const slots = slotsByBucket.get(bucket)!;
      slots.forEach((entries, slotIndex) => {
        row += 1;
        writeSectionTitle(
          sheet,
          row,
          `חדר מתוכנן ${slotIndex + 1} · ${GENDER_LABEL_HE[gender]} · ${rankGroupLabelHe(rankGroup)}`,
          COLOR_ROOM_HEADER_FILL[gender],
          COLUMN_COUNT,
        );
        row += 1;
        for (const { cycle, room } of entries) {
          writeCycleSubHeader(sheet, row, `${cycle.cycleName} · יציאה ${cycle.exitDate}`);
          row += 1;
          writeTableHeader(sheet, row, ['מיטה', 'שם', 'תחום'], COLOR_ROOM_HEADER_FILL[gender]);
          row += 1;
          room.occupants.forEach((occupant, index) => {
            const division = cycle.divisionByUserId.get(occupant.userId) ?? NO_DIVISION_LABEL;
            writeDataRow(sheet, row, [index + 1, occupant.name, division]);
            row += 1;
          });
        }
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="trip-${trip.id}-dorm-request.xlsx"`);
  res.send(Buffer.from(buffer));
});

/**
 * נעילת שיבוץ הלינה - אופרטיבי בלבד.
 * מריץ, שומר, פותח בעיות לטיפול המפקדים, ומודיע למשתתפים.
 */
dormsRouter.post('/:id/dorms/lock', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.dorms_locked_at) throw badRequest('שיבוץ הלינה כבר נעול');

  const rooms = loadTripRooms(trip.id);
  if (rooms.length === 0) throw badRequest('לא הוגדרו מבני לינה לגלישה');

  const preview = computeAllCycles(trip.id);
  const total = preview.reduce((sum, entry) => sum + entry.result.stats.participants, 0);
  if (total === 0) throw badRequest('אין נרשמים מאושרים לגלישה - אין מה לשבץ');

  const locked = tx(() => {
    // אף אחד לא נשאר בלי מיטה: אם המבנים הקיימים לא מספיקים, פותחים עוד
    // חדרים ומריצים שוב לפני שממשיכים - ראו ensureEveryoneHasABed למעלה.
    const { computed, roomsAdded } = ensureEveryoneHasABed(trip.id, preview);

    db.prepare('DELETE FROM room_assignments WHERE trip_id = ?').run(trip.id);
    db.prepare('DELETE FROM dorm_issues WHERE trip_id = ?').run(trip.id);

    const insertAssignment = db.prepare(
      'INSERT INTO room_assignments (trip_id, cycle_id, room_id, user_id) VALUES (?, ?, ?, ?)',
    );
    const insertIssue = db.prepare(
      `INSERT INTO dorm_issues (trip_id, cycle_id, user_id, manager_id, kind, message, suggestions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const participantIds: number[] = [];
    const managersWithIssues = new Set<number>();

    for (const entry of computed) {
      for (const placement of entry.result.placements) {
        insertAssignment.run(trip.id, entry.cycleId, placement.roomId, placement.userId);
        participantIds.push(placement.userId);
      }

      for (const issue of entry.result.issues) {
        insertIssue.run(
          trip.id,
          entry.cycleId,
          issue.userId,
          issue.managerId,
          issue.kind,
          issue.message,
          JSON.stringify(issue.suggestions),
        );

        if (issue.managerId != null && !managersWithIssues.has(issue.managerId)) {
          managersWithIssues.add(issue.managerId);
        }
      }
    }

    db.prepare("UPDATE trips SET dorms_locked_at = datetime('now') WHERE id = ?").run(trip.id);

    notifyMany(db, participantIds, {
      kind: 'dorms_published',
      title: 'שיבוץ הלינה פורסם',
      body: `שיבוץ הלינה לגלישה ${trip.name} פורסם. אפשר לראות את החדר שלך בסיכום הגלישה.`,
      link: `/trips/${trip.id}`,
    });

    // המפקדים מקבלים התראה על בעיות שדורשות פתרון מולם.
    for (const managerId of managersWithIssues) {
      const count = computed.reduce(
        (sum, entry) => sum + entry.result.issues.filter((issue) => issue.managerId === managerId).length,
        0,
      );
      notify(db, {
        userId: managerId,
        kind: 'dorm_issue',
        title: `${count} בעיות שיבוץ לינה דורשות טיפול`,
        body: 'יש אנשים בצוות שלך שלא קיבלו אף אחת מהעדפות השותפים שלהם, או שלא נמצאה עבורם מיטה.',
        link: `/trips/${trip.id}/dorm-issues`,
      });
    }

    return { computed, roomsAdded };
  });

  res.json({ ok: true, cycles: locked.computed, roomsAdded: locked.roomsAdded });
});

dormsRouter.post('/:id/dorms/unlock', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (!trip.dorms_locked_at) throw badRequest('שיבוץ הלינה אינו נעול');

  tx(() => {
    db.prepare('DELETE FROM room_assignments WHERE trip_id = ?').run(trip.id);
    db.prepare('DELETE FROM dorm_issues WHERE trip_id = ?').run(trip.id);
    db.prepare('UPDATE trips SET dorms_locked_at = NULL WHERE id = ?').run(trip.id);
  });

  res.json({ ok: true });
});

/**
 * שיבוץ הלינה השמור.
 * אופרטיבי מקבל את כל החדרים; מפקד רק חדרים שיש בהם אנשים שלו.
 */
dormsRouter.get('/:id/dorms', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  if (!trip.dorms_locked_at) {
    res.json({ locked: false, cycles: [] });
    return;
  }

  const visibleIds = user.role === 'to' ? null : new Set([user.id, ...subordinateIds(db, user.id)]);

  const rows = db
    .prepare(
      `SELECT ra.cycle_id, ra.room_id, ra.user_id, r.name AS room_name, r.beds,
              st.name AS structure_name, st.gender,
              u.first_name, u.last_name, u.company_id, u.role,
              c.name AS cycle_name, c.exit_date
         FROM room_assignments ra
         JOIN rooms r ON r.id = ra.room_id
         JOIN structures st ON st.id = r.structure_id
         JOIN users u ON u.id = ra.user_id
         JOIN cycles c ON c.id = ra.cycle_id
        WHERE ra.trip_id = ?
        ORDER BY c.exit_date, st.name, r.name, u.last_name, u.first_name`,
    )
    .all(trip.id) as Array<{
    cycle_id: number;
    room_id: number;
    user_id: number;
    room_name: string;
    beds: number;
    structure_name: string;
    gender: Gender;
    first_name: string;
    last_name: string;
    company_id: string;
    role: string;
    cycle_name: string;
    exit_date: string;
  }>;

  interface RoomBucket {
    roomId: number;
    roomName: string;
    structureName: string;
    gender: Gender;
    beds: number;
    totalOccupancy: number;
    members: Array<{ userId: number; fullName: string; companyId: string; role: string }>;
  }

  const cycles = new Map<
    number,
    { cycleId: number; cycleName: string; exitDate: string; rooms: Map<number, RoomBucket> }
  >();

  for (const row of rows) {
    let cycle = cycles.get(row.cycle_id);
    if (!cycle) {
      cycle = { cycleId: row.cycle_id, cycleName: row.cycle_name, exitDate: row.exit_date, rooms: new Map() };
      cycles.set(row.cycle_id, cycle);
    }

    let room = cycle.rooms.get(row.room_id);
    if (!room) {
      room = {
        roomId: row.room_id,
        roomName: row.room_name,
        structureName: row.structure_name,
        gender: row.gender,
        beds: row.beds,
        totalOccupancy: 0,
        members: [],
      };
      cycle.rooms.set(row.room_id, room);
    }
    room.totalOccupancy += 1;

    if (visibleIds && !visibleIds.has(row.user_id)) continue;
    room.members.push({
      userId: row.user_id,
      fullName: `${row.first_name} ${row.last_name}`,
      companyId: row.company_id,
      role: row.role,
    });
  }

  res.json({
    locked: true,
    lockedAt: trip.dorms_locked_at,
    scope: user.role === 'to' ? 'all' : 'my-people',
    cycles: [...cycles.values()].map((cycle) => ({
      cycleId: cycle.cycleId,
      cycleName: cycle.cycleName,
      exitDate: cycle.exitDate,
      rooms: [...cycle.rooms.values()]
        // מפקד רואה רק חדרים שיש בהם אנשים שלו.
        .filter((room) => !visibleIds || room.members.length > 0)
        .map((room) => ({ ...room, freeBeds: room.beds - room.totalOccupancy })),
    })),
  });
});

/** החדר של המשתמש המחובר, כולל שמות השותפים. */
dormsRouter.get('/:id/dorms/mine', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  const row = db
    .prepare(
      `SELECT ra.room_id, r.name AS room_name, r.beds, st.name AS structure_name, st.gender,
              c.name AS cycle_name, c.exit_date, ra.cycle_id
         FROM room_assignments ra
         JOIN rooms r ON r.id = ra.room_id
         JOIN structures st ON st.id = r.structure_id
         JOIN cycles c ON c.id = ra.cycle_id
        WHERE ra.trip_id = ? AND ra.user_id = ?`,
    )
    .get(trip.id, user.id) as
    | {
        room_id: number;
        room_name: string;
        beds: number;
        structure_name: string;
        gender: Gender;
        cycle_name: string;
        exit_date: string;
        cycle_id: number;
      }
    | undefined;

  if (!row) {
    res.json({ locked: trip.dorms_locked_at != null, assignment: null });
    return;
  }

  const roommates = db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name
         FROM room_assignments ra JOIN users u ON u.id = ra.user_id
        WHERE ra.room_id = ? AND ra.cycle_id = ? AND ra.user_id != ?
        ORDER BY u.last_name, u.first_name`,
    )
    .all(row.room_id, row.cycle_id, user.id) as Array<{ id: number; first_name: string; last_name: string }>;

  res.json({
    locked: true,
    assignment: {
      structureName: row.structure_name,
      roomName: row.room_name,
      beds: row.beds,
      gender: row.gender,
      cycleName: row.cycle_name,
      exitDate: row.exit_date,
      roommates: roommates.map((mate) => ({ id: mate.id, fullName: `${mate.first_name} ${mate.last_name}` })),
    },
  });
});

// --- בעיות שיבוץ לינה ------------------------------------------------------

/** בעיות השיבוץ הפתוחות. אופרטיבי רואה הכל; מפקד רק את של האנשים שלו. */
dormsRouter.get('/:id/dorm-issues', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  const rows = db
    .prepare(
      `SELECT di.*, u.first_name, u.last_name, u.company_id, c.name AS cycle_name
         FROM dorm_issues di
         JOIN users u ON u.id = di.user_id
         JOIN cycles c ON c.id = di.cycle_id
        WHERE di.trip_id = ?
        ORDER BY di.resolved, di.kind, u.last_name`,
    )
    .all(trip.id)
    .map((row) =>
      plain<DormIssueRow & { first_name: string; last_name: string; company_id: string; cycle_name: string }>(row),
    );

  const managed = user.role === 'to' ? null : new Set(subordinateIds(db, user.id));
  const visible = rows.filter((row) => !managed || managed.has(row.user_id) || row.manager_id === user.id);

  res.json({
    issues: visible.map((row) => ({
      id: row.id,
      cycleId: row.cycle_id,
      cycleName: row.cycle_name,
      kind: row.kind,
      message: row.message,
      resolved: row.resolved === 1,
      createdAt: row.created_at,
      user: {
        id: row.user_id,
        fullName: `${row.first_name} ${row.last_name}`,
        companyId: row.company_id,
      },
      suggestions: JSON.parse(row.suggestions) as unknown,
    })),
  });
});

/** סימון בעיה כטופלה על ידי המפקד. */
dormsRouter.post('/:id/dorm-issues/:issueId/resolve', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const issueId = idParam.parse(req.params.issueId);

  const row = db.prepare('SELECT * FROM dorm_issues WHERE id = ? AND trip_id = ?').get(issueId, trip.id);
  if (!row) throw notFound('הבעיה לא נמצאה');
  const issue = plain<DormIssueRow>(row);

  const managed = new Set(subordinateIds(db, user.id));
  if (user.role !== 'to' && issue.manager_id !== user.id && !managed.has(issue.user_id)) {
    throw badRequest('הבעיה הזו אינה משויכת אליך');
  }

  db.prepare('UPDATE dorm_issues SET resolved = 1 WHERE id = ?').run(issueId);
  res.json({ ok: true });
});
