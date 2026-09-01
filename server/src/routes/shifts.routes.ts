/**
 * דיווח על ביטול משמרות (שבצ״ק) לקראת גלישה.
 *
 * המערכת אינה יודעת אילו משמרות אדם נמצא בהן כרגע - זה ידרוש מערכת נפרדת
 * שעוד לא נכתבה (ראו הערת השרת ב-schema.sql). לכן ר״צ, שהוא המפקד הישיר של
 * חייליו, מדווח ידנית לכל גלישה אם לחייל שלו - או לעצמו, גם לר״צ יכולה
 * להיות משמרת - יש משמרת שצריך לבטל בגללו. האופרטיבי רואה את הסיכום
 * המלא, כדי לדעת למי לפנות כדי לבטל משמרות בפועל.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db, plain } from '../db/index.ts';
import { requireApproved, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import { fullName, getUser, unitPath } from '../lib/org.ts';
import { getTripOr404 } from '../lib/trips.ts';
import type { ShiftReportRow, UserRow } from '../types.ts';

export const shiftsRouter = Router();

shiftsRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();

function getShiftReport(tripId: number, userId: number): ShiftReportRow | null {
  const row = db.prepare(`SELECT * FROM shift_reports WHERE trip_id = ? AND user_id = ?`).get(tripId, userId);
  return row ? plain<ShiftReportRow>(row) : null;
}

function toPublicReport(subject: UserRow, isSelf: boolean, report: ShiftReportRow | null) {
  return {
    userId: subject.id,
    fullName: fullName(subject),
    companyId: subject.company_id,
    isSelf,
    hasShift: report?.has_shift === 1,
    details: report?.details ?? null,
    dutyType: report?.duty_type ?? null,
    dutyLocation: report?.duty_location ?? null,
    dutyDates: report?.duty_dates ?? null,
    handlingStatus: report?.handling_status ?? null,
    updatedAt: report?.updated_at ?? null,
  };
}

/**
 * מי מותר לר״צ המחובר לדווח עליו: עצמו, או חייל שכפוף אליו ישירות.
 * שונה מ-assertCanManage הרגיל - כאן זה תמיד מפקד ישיר, לא כל השרשרת, כי
 * הדיווח הוא על "החיילים שלי" ולא על כל מי שמתחתיי בעץ.
 */
function assertCanReportOn(actor: UserRow, subject: UserRow): void {
  if (actor.role !== 'team_leader') {
    throw forbidden('רק ר״צ יכול לדווח על ביטול משמרות - עבור עצמו ועבור החיילים הישירים שלו');
  }
  if (subject.id === actor.id) return;
  if (subject.manager_id === actor.id) return;
  throw forbidden('אפשר לדווח רק על עצמך או על חייל שכפוף אליך ישירות');
}

/**
 * הרשימה שר״צ מדווח עליה: עצמו וכל החיילים הישירים שלו, כל אחד עם הדיווח
 * הקיים לגלישה הזאת אם יש (has_shift=false כברירת מחדל כשעוד לא דווח).
 */
shiftsRouter.get('/:id/shift-reports/mine', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  if (user.role !== 'team_leader') {
    throw forbidden('רק ר״צ מדווח על ביטול משמרות');
  }

  const directReports = (
    db.prepare(`SELECT * FROM users WHERE manager_id = ? ORDER BY last_name, first_name`).all(user.id) as unknown[]
  ).map((row) => plain<UserRow>(row));

  const subjects = [user, ...directReports];

  res.json({
    tripId: trip.id,
    subjects: subjects.map((subject) => toPublicReport(subject, subject.id === user.id, getShiftReport(trip.id, subject.id))),
  });
});

const shiftReportSchema = z.object({
  hasShift: z.boolean(),
  details: z.string().trim().max(300).nullish(),
  dutyType: z.string().trim().max(60).nullish(),
  dutyLocation: z.string().trim().max(60).nullish(),
  dutyDates: z.string().trim().max(60).nullish(),
});

/** דיווח או עדכון דיווח על משמרת של עצמו או של חייל ישיר. */
shiftsRouter.put('/:id/shift-reports/:userId', (req, res) => {
  const actor = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const subjectId = idParam.parse(req.params.userId);

  const subject = getUser(db, subjectId);
  if (!subject) throw badRequest('המשתמש לא נמצא');
  assertCanReportOn(actor, subject);

  const parsed = shiftReportSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים');
  const input = parsed.data;

  if (input.hasShift && !input.details) {
    throw badRequest('יש לפרט על איזו משמרת מדובר');
  }

  db.prepare(
    `INSERT INTO shift_reports
       (trip_id, user_id, reported_by, has_shift, details, duty_type, duty_location, duty_dates, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(trip_id, user_id) DO UPDATE SET
       has_shift = excluded.has_shift,
       details = excluded.details,
       duty_type = excluded.duty_type,
       duty_location = excluded.duty_location,
       duty_dates = excluded.duty_dates,
       reported_by = excluded.reported_by,
       updated_at = datetime('now')`,
  ).run(
    trip.id,
    subject.id,
    actor.id,
    input.hasShift ? 1 : 0,
    input.hasShift ? (input.details ?? null) : null,
    input.hasShift ? (input.dutyType ?? null) : null,
    input.hasShift ? (input.dutyLocation ?? null) : null,
    input.hasShift ? (input.dutyDates ?? null) : null,
  );

  res.json(toPublicReport(subject, subject.id === actor.id, getShiftReport(trip.id, subject.id)));
});

/**
 * סיכום כל הדיווחים לגלישה - אופרטיבי בלבד, כדי לדעת למי לפנות ולבטל משמרת.
 * מציג רק מי שדווח עבורו שיש לו משמרת (has_shift=1); מי שלא דווח עליו כלל,
 * או שדווח שאין לו משמרת, אינו רלוונטי לרשימה הזו.
 */
shiftsRouter.get('/:id/shift-reports', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));

  const rows = db
    .prepare(
      `SELECT sr.*, u.first_name, u.last_name, u.company_id, u.role,
              rb.first_name AS reporter_first, rb.last_name AS reporter_last
         FROM shift_reports sr
         JOIN users u ON u.id = sr.user_id
         JOIN users rb ON rb.id = sr.reported_by
        WHERE sr.trip_id = ? AND sr.has_shift = 1
        ORDER BY sr.updated_at DESC`,
    )
    .all(trip.id) as unknown as Array<
    ShiftReportRow & {
      first_name: string;
      last_name: string;
      company_id: string;
      role: string;
      reporter_first: string;
      reporter_last: string;
    }
  >;

  res.json({
    reports: rows.map((row) => ({
      userId: row.user_id,
      fullName: `${row.first_name} ${row.last_name}`,
      companyId: row.company_id,
      role: row.role,
      unitPath: unitPath(db, row.user_id),
      details: row.details,
      dutyType: row.duty_type,
      dutyLocation: row.duty_location,
      dutyDates: row.duty_dates,
      handlingStatus: row.handling_status,
      reportedByName: `${row.reporter_first} ${row.reporter_last}`,
      updatedAt: row.updated_at,
    })),
  });
});

const handlingStatusSchema = z.object({ handlingStatus: z.string().trim().max(120).nullish() });

/**
 * עדכון סטאטוס הטיפול בתורנות - אופרטיבי בלבד, כדי לתעד מול מי תואם הביטול.
 * בניגוד לדיווח עצמו (has_shift/details/duty_*), זה שדה שהאופרטיבי מנהל,
 * לא הר״צ שמדווח - ולכן נקודת קצה נפרדת מ-PUT :userId.
 */
shiftsRouter.patch('/:id/shift-reports/:userId/handling-status', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  const subjectId = idParam.parse(req.params.userId);

  const parsed = handlingStatusSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים');

  const existing = getShiftReport(trip.id, subjectId);
  if (!existing) throw badRequest('לא קיים דיווח תורנות למשתמש הזה בגלישה הזאת');

  db.prepare(`UPDATE shift_reports SET handling_status = ? WHERE trip_id = ? AND user_id = ?`).run(
    parsed.data.handlingStatus ?? null,
    trip.id,
    subjectId,
  );

  res.json({ handlingStatus: parsed.data.handlingStatus ?? null });
});
