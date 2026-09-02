import { Router } from 'express';
import { z } from 'zod';
import { db, plain, tx } from '../db/index.ts';
import { requireApproved, requireAuth, requireUser } from '../lib/auth.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import {
  chainUp,
  fullName,
  getUser,
  getUserByCompanyId,
  isAncestorOf,
  isManagerRole,
  rankGroup,
  subordinateIds,
  toPublicUser,
  unitPath,
} from '../lib/org.ts';
import { notify, notifyMany } from '../lib/notify.ts';
import { notifyLateAddition } from '../lib/signing.ts';
import { applyMove, assertValidMoveInput, describeMove, hasDirectReports } from '../lib/moves.ts';
import { CAR_PLATE_PATTERN } from '../lib/cars.ts';
import { PHONE_PATTERN, normalizePhone } from '../lib/phone.ts';
import {
  MAX_ROOMMATE_PREFERENCES,
  getStandingPreferences,
  listRoommateCandidates,
  saveStandingPreferences,
} from '../lib/roommates.ts';
import { NOW_MS, roleOrderSql } from '../types.ts';
import type { MoveRequestRow, ProfileEditRow, UserRow } from '../types.ts';

export const usersRouter = Router();

usersRouter.use(requireAuth);

const idParam = z.coerce.number().int().positive();

/**
 * האם המשתמש המחובר רשאי לנהל את המשתמש היעד.
 * מפקד ישיר או מפקד בשרשרת; והאופרטיבי רשאי לנהל את כולם, בלי קשר לשרשרת.
 */
function assertCanManage(manager: UserRow, target: UserRow): void {
  if (manager.role === 'to') return;
  if (target.manager_id === manager.id) return;
  if (isAncestorOf(db, manager.id, target.id)) return;
  throw forbidden('המשתמש הזה אינו כפוף לך');
}

/**
 * האם `actor` רשאי להחליט בשם `subjectManager` - הוא עצמו, מפקד בשרשרת
 * שמעליו, או האופרטיבי. שונה מ-assertCanManage: כאן הנבדק הוא מפקד, לא כפיף,
 * ולכן "actor === subjectManager" הוא מקרה תקין (מפקד מחליט על עצמו).
 * משמש בהעברות: מי רשאי לאשר בקשה בשם המפקד היעד, ומתי העברה חלה מיד.
 */
function canActFor(actor: UserRow, subjectManager: UserRow): boolean {
  return actor.role === 'to' || actor.id === subjectManager.id || isAncestorOf(db, actor.id, subjectManager.id);
}

/** בקשות רישום שממתינות לאישור המשתמש המחובר (שלו או של כפיפיו); לאופרטיבי - של כל החברה. */
usersRouter.get('/pending', (req, res) => {
  const manager = requireUser(req);

  const raw =
    manager.role === 'to'
      ? db.prepare(`SELECT * FROM users WHERE status = 'pending' ORDER BY created_at`).all()
      : (() => {
          const managed = [manager.id, ...subordinateIds(db, manager.id)];
          const placeholders = managed.map(() => '?').join(',');
          return db
            .prepare(
              `SELECT * FROM users WHERE status = 'pending' AND manager_id IN (${placeholders}) ORDER BY created_at`,
            )
            .all(...managed);
        })();

  const rows = raw.map((row) => plain<UserRow>(row));

  res.json({
    pending: rows.map((row) => ({
      ...toPublicUser(db, row),
      isDirectReport: row.manager_id === manager.id,
      createdAt: row.created_at,
    })),
  });
});

const decisionSchema = z.object({ note: z.string().trim().max(300).optional() });

/** אישור רישום של כפיף. */
usersRouter.post('/:id/approve', (req, res) => {
  const manager = requireUser(req);
  const targetId = idParam.parse(req.params.id);
  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');
  if (target.status === 'approved') throw badRequest('הרישום כבר אושר');
  assertCanManage(manager, target);

  tx(() => {
    db.prepare(
      // NOW_MS ולא datetime('now'): מכאן נגזר "מי נוסף אחרי שהמפקד הגיש".
      `UPDATE users SET status = 'approved', approved_by = ?, approved_at = ${NOW_MS} WHERE id = ?`,
    ).run(manager.id, targetId);

    notify(db, {
      userId: targetId,
      kind: 'registration_approved',
      title: 'הרישום שלך אושר',
      body: `${fullName(manager)} אישר את הרישום שלך. אפשר להתחיל להירשם לגלישות.`,
      link: '/',
    });

    // מפקד בשרשרת שכבר הגיש את רשימת האנשים שלו צריך לדעת שנוסף לו אדם,
    // כדי שיוכל להוסיף אותו לגלישה לפני שהאופרטיבי מגיש אותו.
    notifyLateAddition(getUser(db, targetId)!);
  });

  res.json({ user: toPublicUser(db, getUser(db, targetId)!) });
});

/** דחיית רישום של כפיף. */
usersRouter.post('/:id/reject', (req, res) => {
  const manager = requireUser(req);
  const targetId = idParam.parse(req.params.id);
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('הערה אינה תקינה');

  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');
  assertCanManage(manager, target);

  tx(() => {
    db.prepare("UPDATE users SET status = 'rejected', approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(
      manager.id,
      targetId,
    );

    notify(db, {
      userId: targetId,
      kind: 'registration_rejected',
      title: 'הרישום שלך נדחה',
      body: parsed.data.note ? `סיבה: ${parsed.data.note}` : 'יש לפנות למפקד לקבלת פרטים.',
    });
  });

  res.json({ user: toPublicUser(db, getUser(db, targetId)!) });
});

/** כל הכפיפים של המשתמש המחובר, בכל העומקים; לאופרטיבי - כל אנשי החברה. */
usersRouter.get('/my-team', requireApproved, (req, res) => {
  const manager = requireUser(req);

  if (manager.role === 'to') {
    const rows = db
      .prepare(`SELECT * FROM users WHERE id != ? ORDER BY ${roleOrderSql('role')}, unit_name, last_name, first_name`)
      .all(manager.id)
      .map((row) => plain<UserRow>(row));

    res.json({
      team: rows.map((row) => ({
        ...toPublicUser(db, row),
        unitPath: unitPath(db, row.id),
        isDirectReport: row.manager_id === manager.id,
        hasDirectReports: hasDirectReports(row.id),
      })),
    });
    return;
  }

  const ids = subordinateIds(db, manager.id);
  if (ids.length === 0) {
    res.json({ team: [] });
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM users WHERE id IN (${placeholders}) ORDER BY ${roleOrderSql('role')}, unit_name, last_name, first_name`)
    .all(...ids)
    .map((row) => plain<UserRow>(row));

  res.json({
    team: rows.map((row) => ({
      ...toPublicUser(db, row),
      unitPath: unitPath(db, row.id),
      isDirectReport: row.manager_id === manager.id,
      hasDirectReports: hasDirectReports(row.id),
    })),
  });
});

/**
 * שרשרת הפיקוד של המשתמש המחובר, מעצמו ועד ראש השרשרת (מפמ״ר) - להצגה כעץ
 * "מלמטה למעלה" במסך הפרופיל.
 */
usersRouter.get('/me/hierarchy', requireApproved, (req, res) => {
  const user = requireUser(req);
  const chain = chainUp(db, user.id).map((row) => ({
    id: row.id,
    fullName: fullName(row),
    role: row.role,
    unitName: row.unit_name,
  }));
  res.json({ chain });
});

/**
 * ההעדפות הקבועות של המשתמש לשותפים לחדר, יחד עם המועמדים האפשריים -
 * שניהם יחד כדי שמסך הפרופיל יוכל להציג את הבחירה בקריאה אחת.
 */
usersRouter.get('/me/roommate-preferences', requireApproved, (req, res) => {
  const user = requireUser(req);
  res.json({
    max: MAX_ROOMMATE_PREFERENCES,
    preferences: getStandingPreferences(user.id),
    candidates: listRoommateCandidates(user),
  });
});

/**
 * עדכון ההעדפות הקבועות. אינן חובה - רשימה ריקה פשוט מוחקת אותן.
 * בניגוד לשאר פרטי הפרופיל, ההעדפות אינן דורשות אישור מפקד: הן בקשה רכה
 * שמנוע השיבוץ מנסה לספק, ולא שינוי בזהות או בשיוך הארגוני.
 */
usersRouter.put('/me/roommate-preferences', requireApproved, (req, res) => {
  const user = requireUser(req);
  const parsed = z
    .object({ preferences: z.array(z.number().int().positive()).max(MAX_ROOMMATE_PREFERENCES).default([]) })
    .safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('רשימת השותפים אינה תקינה');

  tx(() => saveStandingPreferences(user, parsed.data.preferences));
  res.json({ preferences: getStandingPreferences(user.id) });
});

/**
 * מספר הרכב הפרטי בפרופיל - כל משתמש יכול לשמור אותו, לא רק רת״ח ומפמ״ר.
 * לרת״ח ולמפמ״ר (alwaysBringsOwnCar) זו עובדה קבועה - הם תמיד מגיעים ברכב
 * הפרטי שלהם בלי בקשה לכל גלישה. לכל תפקיד אחר זהו פרט מידע בלבד: הוא מוצג
 * בבקשת הרכב הפרטי לגלישה (ראו lib/cars.ts, signups.routes.ts), אבל עדיין
 * טעון בקשה ואישור רת״ח לכל גלישה בנפרד.
 * בניגוד לשאר פרטי הפרופיל, השדה הזה אינו דורש אישור מפקד: הוא פרט מנהלי
 * שאינו נוגע לזהות או לשיוך הארגוני.
 */
usersRouter.put('/me/car-plate', requireApproved, (req, res) => {
  const user = requireUser(req);

  const parsed = z
    .object({ carPlate: z.string().trim().regex(CAR_PLATE_PATTERN, 'מספר רכב חייב להיות בן 7-8 ספרות').nullable() })
    .safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'מספר הרכב אינו תקין');

  db.prepare('UPDATE users SET car_plate = ? WHERE id = ?').run(parsed.data.carPlate, user.id);
  res.json({ carPlate: parsed.data.carPlate });
});

// --- עובדים-לשעבר: מושאלים (הצ״ח) ומילואים --------------------------------

const exWorkerSchema = z
  .object({
    companyId: z.string().trim().regex(/^\d{7}$/, 'מספר אישי חייב להיות בן 7 ספרות'),
    firstName: z.string().trim().min(2, 'שם פרטי חייב להכיל לפחות 2 תווים').max(40),
    lastName: z.string().trim().min(2, 'שם משפחה חייב להכיל לפחות 2 תווים').max(40),
    gender: z.enum(['male', 'female']),
    diet: z.enum(['all', 'vegetarian', 'vegan']),
    workerType: z.enum(['borrowed', 'reserve']),
    borrowedFrom: z.string().trim().min(2, 'יש לציין מאיפה הושאל העובד').max(80).optional(),
    borrowedMission: z.string().trim().min(2, 'יש לציין את המשימה שבשבילה מבקשים את ההשאלה').max(200).optional(),
  })
  .refine((value) => value.workerType !== 'borrowed' || !!value.borrowedFrom, {
    message: 'לעובד מושאל (הצ״ח) חובה לציין מאיפה הושאל',
    path: ['borrowedFrom'],
  })
  .refine((value) => value.workerType !== 'borrowed' || !!value.borrowedMission, {
    message: 'לעובד מושאל (הצ״ח) חובה לציין את המשימה שבשבילה מבקשים את ההשאלה',
    path: ['borrowedMission'],
  });

/**
 * הוספת עובד-לשעבר (מושאל מיחידה אחרת - הצ״ח, או מילואים) ישירות תחת מפקד.
 * בניגוד להרשמה רגילה אין כאן תהליך אישור: המפקד שמוסיף כבר ערב לזהות העובד,
 * ולכן הוא מצטרף מאושר ומיד תחתיו, בדיוק כמו חייל רגיל - גלישות, אוטובוסים
 * ולינה מתייחסים אליו זהה, ורק מסכי הצוות מציגים אותו בסעיף נפרד (worker_type).
 * זמין לכל מפקד: לפי PARENT_ROLES חייל יכול להיות כפוף ישירות לכל דרג מפקד.
 */
usersRouter.post('/ex-workers', requireApproved, (req, res) => {
  const manager = requireUser(req);
  if (!isManagerRole(manager.role)) {
    throw forbidden('רק מפקד יכול להוסיף עובד מושאל או מילואים לצוות');
  }

  const parsed = exWorkerSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים', parsed.error.issues);
  }
  const input = parsed.data;

  if (getUserByCompanyId(db, input.companyId)) {
    throw conflict('המספר האישי הזה כבר רשום במערכת');
  }

  const created = tx(() => {
    const row = db
      .prepare(
        `INSERT INTO users
           (company_id, first_name, last_name, gender, role, diet, manager_id, status,
            worker_type, borrowed_from, borrowed_mission, approved_by, approved_at)
         VALUES (?, ?, ?, ?, 'employee', ?, ?, 'approved', ?, ?, ?, ?, ${NOW_MS})
         RETURNING *`,
      )
      .get(
        input.companyId,
        input.firstName,
        input.lastName,
        input.gender,
        input.diet,
        manager.id,
        input.workerType,
        input.workerType === 'borrowed' ? (input.borrowedFrom ?? null) : null,
        input.workerType === 'borrowed' ? (input.borrowedMission ?? null) : null,
        manager.id,
      );

    const user = plain<UserRow>(row);

    notify(db, {
      userId: user.id,
      kind: 'registration_approved',
      title: 'התווספת למערכת',
      body:
        input.workerType === 'borrowed'
          ? `${fullName(manager)} הוסיף אותך לצוות כעובד מושאל (הצ״ח) מ${input.borrowedFrom}.`
          : `${fullName(manager)} הוסיף אותך לצוות כאיש מילואים.`,
      link: '/',
    });

    return user;
  });

  res.status(201).json({ user: toPublicUser(db, created) });
});

const profileEditSchema = z
  .object({
    firstName: z.string().trim().min(2, 'שם פרטי חייב להכיל לפחות 2 תווים').max(40),
    lastName: z.string().trim().min(2, 'שם משפחה חייב להכיל לפחות 2 תווים').max(40),
    gender: z.enum(['male', 'female']),
    diet: z.enum(['all', 'vegetarian', 'vegan']),
    unitName: z.string().trim().min(2).max(60).optional(),
    phone: z
      .string()
      .trim()
      .transform(normalizePhone)
      .pipe(z.string().regex(PHONE_PATTERN, 'מספר טלפון לא תקין - יש להזין מספר ישראלי בן 9-10 ספרות')),
    allergies: z.string().trim().max(200).optional(),
    /** רלוונטי לחיילים בלבד (users.worker_type) - ראו deriveWorkerType למטה. */
    workerType: z.enum(['regular', 'borrowed', 'reserve']).optional(),
    borrowedFrom: z.string().trim().min(2, 'יש לציין מאיפה הושאל העובד').max(80).optional(),
    borrowedMission: z.string().trim().min(2, 'יש לציין את המשימה שבשבילה מבקשים את ההשאלה').max(200).optional(),
  })
  .refine((value) => value.workerType !== 'borrowed' || !!value.borrowedFrom, {
    message: 'לעובד מושאל (הצ״ח) חובה לציין מאיפה הושאל',
    path: ['borrowedFrom'],
  })
  .refine((value) => value.workerType !== 'borrowed' || !!value.borrowedMission, {
    message: 'לעובד מושאל (הצ״ח) חובה לציין את המשימה שבשבילה מבקשים את ההשאלה',
    path: ['borrowedMission'],
  });

type ProfileEditInput = z.infer<typeof profileEditSchema>;

/**
 * סוג העובד ניתן לעריכה עצמית לחיילים בלבד (worker_type - ראו types.ts):
 * מפקד תמיד נשאר 'regular'. כשלא נשלח ערך (למשל מפקד עורך את עצמו, או טופס
 * שלא כלל את השדה) נשמר הערך הנוכחי - כדי שעדכון שם/תזונה לא יאפס בטעות
 * מעמד "מושאל"/"מילואים" קיים.
 */
function deriveWorkerType(
  target: UserRow,
  input: ProfileEditInput,
): { workerType: UserRow['worker_type']; borrowedFrom: string | null; borrowedMission: string | null } {
  if (target.role !== 'employee') return { workerType: 'regular', borrowedFrom: null, borrowedMission: null };
  const workerType = input.workerType ?? target.worker_type;
  return {
    workerType,
    borrowedFrom: workerType === 'borrowed' ? (input.borrowedFrom ?? target.borrowed_from) : null,
    borrowedMission: workerType === 'borrowed' ? (input.borrowedMission ?? target.borrowed_mission) : null,
  };
}

/** ייצוג ה־API של בקשת עדכון פרופיל, עם הערכים הנוכחיים לצד המוצעים לתצוגת השוואה. */
function toPublicProfileEdit(edit: ProfileEditRow) {
  const user = getUser(db, edit.user_id)!;
  return {
    id: edit.id,
    userId: edit.user_id,
    userFullName: fullName(user),
    companyId: user.company_id,
    current: {
      firstName: user.first_name,
      lastName: user.last_name,
      gender: user.gender,
      diet: user.diet,
      unitName: user.unit_name,
      phone: user.phone,
      allergies: user.allergies,
      workerType: user.worker_type,
      borrowedFrom: user.borrowed_from,
      borrowedMission: user.borrowed_mission,
    },
    proposed: {
      firstName: edit.first_name,
      lastName: edit.last_name,
      gender: edit.gender,
      diet: edit.diet,
      unitName: edit.unit_name,
      phone: edit.phone,
      allergies: edit.allergies,
      workerType: edit.worker_type,
      borrowedFrom: edit.borrowed_from,
      borrowedMission: edit.borrowed_mission,
    },
    status: edit.status,
    decisionNote: edit.decision_note,
    createdAt: edit.created_at,
  };
}

function getPendingProfileEdit(userId: number): ProfileEditRow | null {
  const row = db.prepare(`SELECT * FROM profile_edits WHERE user_id = ? AND status = 'pending'`).get(userId);
  return row ? plain<ProfileEditRow>(row) : null;
}

/** בקשת עדכון הפרופיל הממתינה של המשתמש המחובר, אם יש. */
usersRouter.get('/me/profile-edit', requireApproved, (req, res) => {
  const user = requireUser(req);
  const pending = getPendingProfileEdit(user.id);
  res.json({ pending: pending ? toPublicProfileEdit(pending) : null });
});

/**
 * הגשת בקשה לעדכון פרטים אישיים - ממתינה לאישור המפקד, בדיוק כמו בהרשמה.
 * company_id, role ו-manager_id אינם ניתנים לעריכה כאן.
 * אם כבר יש בקשה ממתינה היא מתעדכנת במקום להיווצר עותק נוסף.
 */
usersRouter.post('/me/profile-edit', requireApproved, (req, res) => {
  const user = requireUser(req);
  const parsed = profileEditSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים', parsed.error.issues);
  }
  const input = parsed.data;

  if (user.role !== 'employee' && !input.unitName) {
    throw badRequest('למפקד חובה להזין שם יחידה');
  }
  const unitName = user.role === 'employee' ? null : (input.unitName ?? null);
  const allergies = input.allergies?.trim() || 'ללא';
  const { workerType, borrowedFrom, borrowedMission } = deriveWorkerType(user, input);

  const unchanged =
    input.firstName === user.first_name &&
    input.lastName === user.last_name &&
    input.gender === user.gender &&
    input.diet === user.diet &&
    unitName === user.unit_name &&
    input.phone === user.phone &&
    allergies === user.allergies &&
    workerType === user.worker_type &&
    borrowedFrom === user.borrowed_from &&
    borrowedMission === user.borrowed_mission;

  const existing = getPendingProfileEdit(user.id);

  if (unchanged) {
    // חזרה לערכים המקוריים מבטלת בקשה ממתינה קודמת - אין מה לאשר.
    if (existing) db.prepare(`DELETE FROM profile_edits WHERE id = ?`).run(existing.id);
    res.json({ pending: null });
    return;
  }

  const row = tx(() => {
    if (existing) {
      return plain<ProfileEditRow>(
        db
          .prepare(
            `UPDATE profile_edits
                SET first_name = ?, last_name = ?, gender = ?, diet = ?, unit_name = ?,
                    phone = ?, allergies = ?, worker_type = ?, borrowed_from = ?, borrowed_mission = ?
              WHERE id = ? RETURNING *`,
          )
          .get(
            input.firstName,
            input.lastName,
            input.gender,
            input.diet,
            unitName,
            input.phone,
            allergies,
            workerType,
            borrowedFrom,
            borrowedMission,
            existing.id,
          ),
      );
    }

    const created = plain<ProfileEditRow>(
      db
        .prepare(
          `INSERT INTO profile_edits
             (user_id, first_name, last_name, gender, diet, unit_name, phone, allergies,
              worker_type, borrowed_from, borrowed_mission)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          user.id,
          input.firstName,
          input.lastName,
          input.gender,
          input.diet,
          unitName,
          input.phone,
          allergies,
          workerType,
          borrowedFrom,
          borrowedMission,
        ),
    );

    const title = 'בקשת עדכון פרופיל';
    const body = `${fullName(user)} (מספר אישי ${user.company_id}) ביקש לעדכן את הפרטים האישיים שלו.`;
    if (user.manager_id) {
      notify(db, { userId: user.manager_id, kind: 'profile_edit_pending', title, body, link: '/approvals' });
    } else {
      // אין מפקד בשרשרת (למשל מפמ״ר) - האופרטיבי מאשר, כמו בהרשמה.
      const organizers = (
        db.prepare("SELECT id FROM users WHERE role = 'to' AND status = 'approved'").all() as Array<{ id: number }>
      ).map((entry) => entry.id);
      notifyMany(db, organizers, { kind: 'profile_edit_pending', title, body, link: '/approvals' });
    }

    return created;
  });

  res.json({ pending: toPublicProfileEdit(row) });
});

/** ביטול בקשת עדכון פרופיל ממתינה, ביוזמת המשתמש עצמו. */
usersRouter.delete('/me/profile-edit', requireApproved, (req, res) => {
  const user = requireUser(req);
  const result = db.prepare(`DELETE FROM profile_edits WHERE user_id = ? AND status = 'pending'`).run(user.id);
  if (result.changes === 0) throw notFound('אין בקשת עדכון ממתינה');
  res.json({ ok: true });
});

/** בקשות עדכון פרופיל שממתינות לאישור המשתמש המחובר (שלו או של כפיפיו); לאופרטיבי - של כל החברה. */
usersRouter.get('/profile-edits/pending', (req, res) => {
  const manager = requireUser(req);

  const raw =
    manager.role === 'to'
      ? db.prepare(`SELECT * FROM profile_edits WHERE status = 'pending' ORDER BY created_at`).all()
      : (() => {
          const managed = [manager.id, ...subordinateIds(db, manager.id)];
          const placeholders = managed.map(() => '?').join(',');
          return db
            .prepare(
              `SELECT pe.* FROM profile_edits pe
                 JOIN users u ON u.id = pe.user_id
                WHERE pe.status = 'pending' AND u.manager_id IN (${placeholders})
                ORDER BY pe.created_at`,
            )
            .all(...managed);
        })();

  const rows = raw.map((row) => plain<ProfileEditRow>(row));
  res.json({ pending: rows.map((row) => toPublicProfileEdit(row)) });
});

/** אישור בקשת עדכון פרופיל - מחיל את השינויים המוצעים על המשתמש. */
usersRouter.post('/profile-edits/:id/approve', (req, res) => {
  const manager = requireUser(req);
  const editId = idParam.parse(req.params.id);
  const editRow = db.prepare(`SELECT * FROM profile_edits WHERE id = ?`).get(editId);
  if (!editRow) throw notFound('הבקשה לא נמצאה');
  const edit = plain<ProfileEditRow>(editRow);
  if (edit.status !== 'pending') throw badRequest('הבקשה כבר טופלה');

  const target = getUser(db, edit.user_id);
  if (!target) throw notFound('המשתמש לא נמצא');
  assertCanManage(manager, target);

  tx(() => {
    db.prepare(
      `UPDATE users
          SET first_name = ?, last_name = ?, gender = ?, diet = ?, unit_name = ?,
              phone = ?, allergies = ?, worker_type = ?, borrowed_from = ?, borrowed_mission = ?
        WHERE id = ?`,
    ).run(
      edit.first_name,
      edit.last_name,
      edit.gender,
      edit.diet,
      edit.unit_name,
      edit.phone,
      edit.allergies,
      edit.worker_type,
      edit.borrowed_from,
      edit.borrowed_mission,
      target.id,
    );

    db.prepare(
      `UPDATE profile_edits SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?`,
    ).run(manager.id, editId);

    notify(db, {
      userId: target.id,
      kind: 'profile_edit_approved',
      title: 'עדכון הפרופיל שלך אושר',
      body: `${fullName(manager)} אישר את השינוי בפרטים שלך.`,
      link: '/profile',
    });
  });

  res.json({ user: toPublicUser(db, getUser(db, target.id)!) });
});

/** דחיית בקשת עדכון פרופיל. */
usersRouter.post('/profile-edits/:id/reject', (req, res) => {
  const manager = requireUser(req);
  const editId = idParam.parse(req.params.id);
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('הערה אינה תקינה');

  const editRow = db.prepare(`SELECT * FROM profile_edits WHERE id = ?`).get(editId);
  if (!editRow) throw notFound('הבקשה לא נמצאה');
  const edit = plain<ProfileEditRow>(editRow);
  if (edit.status !== 'pending') throw badRequest('הבקשה כבר טופלה');

  const target = getUser(db, edit.user_id);
  if (!target) throw notFound('המשתמש לא נמצא');
  assertCanManage(manager, target);

  tx(() => {
    db.prepare(
      `UPDATE profile_edits SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ?
        WHERE id = ?`,
    ).run(manager.id, parsed.data.note ?? null, editId);

    notify(db, {
      userId: target.id,
      kind: 'profile_edit_rejected',
      title: 'עדכון הפרופיל שלך נדחה',
      body: parsed.data.note ? `סיבה: ${parsed.data.note}` : 'יש לפנות למפקד לקבלת פרטים.',
      link: '/profile',
    });
  });

  res.json({ ok: true });
});

/**
 * עריכה ישירה של פרטי כפיף על ידי המפקד - חלה מיד, בלי אישור נוסף: המפקד
 * שעורך כבר מחזיק בסמכות האישור (assertCanManage), אז אין למי לחכות.
 * לא זמין על העורך עצמו - אדם שרוצה לשנות את הפרטים שלו עובר דרך
 * POST /me/profile-edit, שממתין לאישור המפקד *שלו*.
 * עריכה ישירה מבטלת גם בקשה ממתינה קודמת של אותו אדם, כדי שלא תישאר תלויה
 * מול ערכים שכבר הוחלפו.
 */
usersRouter.patch('/:id/profile', (req, res) => {
  const manager = requireUser(req);
  const targetId = idParam.parse(req.params.id);
  if (targetId === manager.id) {
    throw badRequest('לעריכת הפרטים שלך יש להשתמש במסך הפרופיל - השינוי שם ממתין לאישור המפקד שלך');
  }

  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');
  assertCanManage(manager, target);

  const parsed = profileEditSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים', parsed.error.issues);
  }
  const input = parsed.data;

  if (target.role !== 'employee' && !input.unitName) {
    throw badRequest('למפקד חובה להזין שם יחידה');
  }
  const unitName = target.role === 'employee' ? null : (input.unitName ?? null);
  const allergies = input.allergies?.trim() || 'ללא';
  const { workerType, borrowedFrom, borrowedMission } = deriveWorkerType(target, input);

  tx(() => {
    db.prepare(
      `UPDATE users
          SET first_name = ?, last_name = ?, gender = ?, diet = ?, unit_name = ?,
              phone = ?, allergies = ?, worker_type = ?, borrowed_from = ?, borrowed_mission = ?
        WHERE id = ?`,
    ).run(
      input.firstName,
      input.lastName,
      input.gender,
      input.diet,
      unitName,
      input.phone,
      allergies,
      workerType,
      borrowedFrom,
      borrowedMission,
      target.id,
    );

    // עריכה ישירה מייתרת כל בקשה ממתינה של האדם עצמו - היא כבר לא רלוונטית.
    db.prepare(`DELETE FROM profile_edits WHERE user_id = ? AND status = 'pending'`).run(target.id);

    notify(db, {
      userId: target.id,
      kind: 'profile_updated_by_manager',
      title: 'הפרטים שלך עודכנו',
      body: `${fullName(manager)} עדכן את הפרטים האישיים שלך.`,
      link: '/profile',
    });
  });

  res.json({ user: toPublicUser(db, getUser(db, target.id)!) });
});

// --- העברה בהיררכיה --------------------------------------------------------

/** אנשים לבחירה כממלא מקום: חיפוש חופשי לפי שם או מספר אישי, בין המאושרים בלבד. */
usersRouter.get('/search', requireApproved, (req, res) => {
  const term = z.string().trim().min(1).max(60).safeParse(req.query.q);
  if (!term.success) {
    res.json({ results: [] });
    return;
  }
  const like = `%${term.data}%`;
  const rows = db
    .prepare(
      `SELECT * FROM users
        WHERE status = 'approved' AND (first_name || ' ' || last_name LIKE ? OR company_id LIKE ?)
        ORDER BY last_name, first_name
        LIMIT 20`,
    )
    .all(like, like)
    .map((row) => plain<UserRow>(row));

  res.json({
    results: rows.map((row) => ({
      id: row.id,
      fullName: fullName(row),
      companyId: row.company_id,
      role: row.role,
      unitPath: unitPath(db, row.id),
      hasDirectReports: hasDirectReports(row.id),
    })),
  });
});

function toPublicMoveRequest(row: MoveRequestRow) {
  const target = getUser(db, row.user_id)!;
  const toManager = getUser(db, row.to_manager_id)!;
  const successor = row.successor_id != null ? getUser(db, row.successor_id) : null;
  const requestedBy = getUser(db, row.requested_by)!;
  return {
    id: row.id,
    user: { id: target.id, fullName: fullName(target), companyId: target.company_id, role: target.role },
    toManager: { id: toManager.id, fullName: fullName(toManager), unitName: toManager.unit_name },
    successor: successor ? { id: successor.id, fullName: fullName(successor), companyId: successor.company_id } : null,
    requestedBy: { id: requestedBy.id, fullName: fullName(requestedBy) },
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
  };
}

const moveSchema = z.object({
  toManagerId: z.number().int().positive(),
  successorId: z.number().int().positive().nullish(),
});

/** בקשת העברת מפקד ממתינה של המשתמש המחובר עצמו, אם יש - ראו POST /:id/move. */
usersRouter.get('/me/move', requireApproved, (req, res) => {
  const user = requireUser(req);
  const row = db.prepare(`SELECT * FROM move_requests WHERE user_id = ? AND status = 'pending'`).get(user.id);
  res.json({ pending: row ? toPublicMoveRequest(plain<MoveRequestRow>(row)) : null });
});

/**
 * בקשה להעביר כפיף למפקד אחר בעץ. אם המפקד היעד בתוך שרשרת הפיקוד של
 * המבקש - שהוא כבר בעל סמכות עליו - ההעברה חלה מיד. אחרת היא ממתינה
 * לאישור המפקד היעד.
 *
 * זמין גם על עצמו (בקשת שינוי מפקד עצמאית, למשל חייל שרוצה לעבור מפקד) -
 * assertCanManage לא נבדק במקרה הזה, כי אדם תמיד "רשאי" לבקש להעביר את
 * עצמו. ההעברה עצמה עדיין ממתינה לאישור המפקד היעד, בדיוק כמו הרשמה.
 */
usersRouter.post('/:id/move', (req, res) => {
  const acting = requireUser(req);
  const targetId = idParam.parse(req.params.id);
  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');
  if (acting.id !== target.id) assertCanManage(acting, target);

  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים');
  const { toManagerId, successorId } = parsed.data;

  const existing = db
    .prepare(`SELECT 1 AS ok FROM move_requests WHERE user_id = ? AND status = 'pending'`)
    .get(targetId);
  if (existing) throw badRequest('כבר קיימת בקשת העברה ממתינה לאדם הזה');

  const { toManager, successor } = assertValidMoveInput(targetId, toManagerId, successorId ?? null);

  // המבקש כבר בעל סמכות על המפקד היעד (הוא עצמו, או שהוא כפוף למבקש) - אין למי לחכות.
  const needsApproval = !canActFor(acting, toManager);

  if (!needsApproval) {
    tx(() => {
      applyMove(target.id, toManager.id, successor?.id ?? null);
      notify(db, {
        userId: target.id,
        kind: 'moved',
        title: 'המפקד שלך השתנה',
        body: `${fullName(acting)} העביר אותך לפיקוד ${fullName(toManager)}.`,
        link: '/profile',
      });
      if (successor) {
        notify(db, {
          userId: successor.id,
          kind: 'promoted',
          title: 'מוניתם למפקד יחידה',
          body: `${fullName(acting)} מינה אותך למלא את מקומו של ${fullName(target)}.`,
          link: '/my-team',
        });
      }
    });
    res.json({ applied: true, pending: null, user: toPublicUser(db, getUser(db, target.id)!) });
    return;
  }

  const row = plain<MoveRequestRow>(
    db
      .prepare(
        `INSERT INTO move_requests (user_id, to_manager_id, successor_id, requested_by)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(target.id, toManager.id, successor?.id ?? null, acting.id),
  );

  notify(db, {
    userId: toManager.id,
    kind: 'move_pending',
    title: 'בקשת העברה ממתינה לאישורך',
    body: `${fullName(acting)} מבקש להעביר את ${describeMove(target, toManager)}.`,
    link: '/approvals',
  });

  res.json({ applied: false, pending: toPublicMoveRequest(row), user: toPublicUser(db, target) });
});

/** ביטול בקשת העברה ממתינה, ביוזמת מי שביקש אותה. */
usersRouter.delete('/:id/move', (req, res) => {
  const acting = requireUser(req);
  const targetId = idParam.parse(req.params.id);

  const row = db
    .prepare(`SELECT * FROM move_requests WHERE user_id = ? AND status = 'pending'`)
    .get(targetId);
  if (!row) throw notFound('אין בקשת העברה ממתינה לאדם הזה');
  const move = plain<MoveRequestRow>(row);
  if (move.requested_by !== acting.id) throw forbidden('רק מי שביקש את ההעברה יכול לבטל אותה');

  db.prepare(`DELETE FROM move_requests WHERE id = ?`).run(move.id);
  res.json({ ok: true });
});

/** בקשות העברה שממתינות לאישור המשתמש המחובר (הוא המפקד היעד, או מפקד בשרשרת מעליו); לאופרטיבי - של כל החברה. */
usersRouter.get('/moves/pending', (req, res) => {
  const manager = requireUser(req);

  const raw =
    manager.role === 'to'
      ? db.prepare(`SELECT * FROM move_requests WHERE status = 'pending' ORDER BY created_at`).all()
      : (() => {
          const managed = [manager.id, ...subordinateIds(db, manager.id)];
          const placeholders = managed.map(() => '?').join(',');
          return db
            .prepare(
              `SELECT * FROM move_requests WHERE status = 'pending' AND to_manager_id IN (${placeholders})
               ORDER BY created_at`,
            )
            .all(...managed);
        })();

  const rows = raw.map((row) => plain<MoveRequestRow>(row));
  res.json({ pending: rows.map((row) => toPublicMoveRequest(row)) });
});

/** אישור בקשת העברה - מחיל את ההעברה בפועל. */
usersRouter.post('/moves/:id/approve', (req, res) => {
  const approver = requireUser(req);
  const moveId = idParam.parse(req.params.id);
  const row = db.prepare(`SELECT * FROM move_requests WHERE id = ?`).get(moveId);
  if (!row) throw notFound('הבקשה לא נמצאה');
  const move = plain<MoveRequestRow>(row);
  if (move.status !== 'pending') throw badRequest('הבקשה כבר טופלה');

  const toManager = getUser(db, move.to_manager_id);
  if (!toManager) throw notFound('המפקד היעד לא נמצא');
  if (!canActFor(approver, toManager)) throw forbidden('רק המפקד היעד, או מפקד בשרשרת מעליו, יכול להחליט על הבקשה');

  // בדיקה חוזרת - נתונים יכלו להשתנות מאז שהבקשה הוגשה (למשל ממלא המקום כבר לא מתאים).
  const { target, successor } = assertValidMoveInput(move.user_id, move.to_manager_id, move.successor_id);

  tx(() => {
    applyMove(target.id, toManager.id, successor?.id ?? null);
    db.prepare(`UPDATE move_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(
      approver.id,
      moveId,
    );

    notify(db, {
      userId: target.id,
      kind: 'moved',
      title: 'בקשת ההעברה שלך אושרה',
      body: `${fullName(approver)} אישר את המעבר לפיקוד ${fullName(toManager)}.`,
      link: '/profile',
    });
    if (successor) {
      notify(db, {
        userId: successor.id,
        kind: 'promoted',
        title: 'מוניתם למפקד יחידה',
        body: `אושרה ההעברה שלאחריה מוניתם למלא את מקומו של ${fullName(target)}.`,
        link: '/my-team',
      });
    }
    if (move.requested_by !== approver.id) {
      notify(db, {
        userId: move.requested_by,
        kind: 'move_approved',
        title: 'בקשת ההעברה שלך אושרה',
        body: `${fullName(approver)} אישר את ${describeMove(target, toManager)}.`,
        link: '/my-team',
      });
    }
  });

  res.json({ user: toPublicUser(db, getUser(db, target.id)!) });
});

/** דחיית בקשת העברה. */
usersRouter.post('/moves/:id/reject', (req, res) => {
  const approver = requireUser(req);
  const moveId = idParam.parse(req.params.id);
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('הערה אינה תקינה');

  const row = db.prepare(`SELECT * FROM move_requests WHERE id = ?`).get(moveId);
  if (!row) throw notFound('הבקשה לא נמצאה');
  const move = plain<MoveRequestRow>(row);
  if (move.status !== 'pending') throw badRequest('הבקשה כבר טופלה');

  const toManager = getUser(db, move.to_manager_id);
  if (!toManager) throw notFound('המפקד היעד לא נמצא');
  if (!canActFor(approver, toManager)) throw forbidden('רק המפקד היעד, או מפקד בשרשרת מעליו, יכול להחליט על הבקשה');

  tx(() => {
    db.prepare(
      `UPDATE move_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ?
        WHERE id = ?`,
    ).run(approver.id, parsed.data.note ?? null, moveId);

    notify(db, {
      userId: move.requested_by,
      kind: 'move_rejected',
      title: 'בקשת ההעברה נדחתה',
      body: parsed.data.note ? `סיבה: ${parsed.data.note}` : 'יש לפנות למפקד היעד לפרטים.',
      link: '/my-team',
    });
  });

  res.json({ ok: true });
});

/** פרטי משתמש בודד - למפקדים על כפיפיהם, ולאופרטיבי על כולם. */
usersRouter.get('/:id', (req, res) => {
  const viewer = requireUser(req);
  const targetId = idParam.parse(req.params.id);
  const target = getUser(db, targetId);
  if (!target) throw notFound('המשתמש לא נמצא');

  if (viewer.id !== target.id && viewer.role !== 'to') {
    assertCanManage(viewer, target);
  }

  res.json({
    user: { ...toPublicUser(db, target), unitPath: unitPath(db, target.id), rankGroup: rankGroup(target.role) },
  });
});
