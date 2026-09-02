import { Router } from 'express';
import { z } from 'zod';
import { db, plain, tx } from '../db/index.ts';
import { requireApproved, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { fullName, getUser, isAncestorOf, subordinateIds, unitPath } from '../lib/org.ts';
import { notify, notifyMany } from '../lib/notify.ts';
import { checkRoommateEligibility, getCycleOr404, getSignup, getTripOr404 } from '../lib/trips.ts';
import {
  alwaysBringsOwnCar,
  assertCarRequestPending,
  canApproveCarRequest,
  carApproverOf,
  getSignupOr404,
  validateCarPassenger,
} from '../lib/cars.ts';
import {
  assertCanSign,
  assertSigningAuthority,
  directReportManagers,
  getApprovedUser,
  hasDelegated,
  hasSubmitted,
  isSigningLeader,
  lateAdditionIds,
  responsibleLeaderId,
  rosterClosedNote,
  signableUserIds,
  signedCount,
  signingAuthority,
  submittedAt,
  TRIP_SUBMITTED_NOTE,
} from '../lib/signing.ts';
import {
  MAX_DORM_PREFERENCES,
  NOW_MS,
  pluralRoleLabels,
  SIGNING_LEADER_ROLES,
  roleLabels,
  roleOrderSql,
  type CarStatus,
  type SignupRow,
  type TripRow,
  type UserRow,
} from '../types.ts';

export const signupsRouter = Router();

signupsRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();

/**
 * הפרטים האישיים פתוחים: בחירת שותפים לחדר ואישור התזונה.
 * בכוונה אינו מסתכל על הגשת הגלישה - שיבוץ הלינה מתבצע אחרי ההגשה, ולכן
 * החייל חייב להמשיך להשלים את הפרטים שלו גם אחריה.
 */
function assertDetailsOpen(tripId: number): TripRow {
  const trip = getTripOr404(tripId);
  if (trip.state !== 'LAUNCHED') throw badRequest('הגלישה סגורה לשינויים');
  if (trip.buses_locked_at || trip.dorms_locked_at) {
    throw badRequest('השיבוצים של הגלישה נעולים ולכן השיבוץ נסגר');
  }
  return trip;
}

/**
 * רשימת המשתתפים פתוחה: אפשר להוסיף או להסיר אנשים.
 * מנעול מחמיר יותר מזה של הפרטים האישיים: הוא נסגר גם כשהאופרטיבי מגיש
 * את הגלישה - זה הרגע שמקפיא את הרשימה לכולם.
 */
function assertRosterOpen(tripId: number): void {
  const trip = assertDetailsOpen(tripId);
  if (trip.submitted_at != null) throw badRequest(TRIP_SUBMITTED_NOTE);
}

/** שומר את העדפות השותפים לאחר בדיקת כל האילוצים. */
function savePreferences(requester: UserRow, signupId: number, preferences: number[]): void {
  const unique = [...new Set(preferences)];
  if (unique.length !== preferences.length) throw badRequest('לא ניתן לבחור את אותו אדם פעמיים');

  db.prepare('DELETE FROM dorm_preferences WHERE signup_id = ?').run(signupId);

  const insert = db.prepare(
    'INSERT INTO dorm_preferences (signup_id, preferred_user_id, priority) VALUES (?, ?, ?)',
  );
  unique.forEach((candidateId, index) => {
    const candidate = getUser(db, candidateId);
    if (!candidate) throw notFound('אחד השותפים שנבחרו לא נמצא במערכת');
    const problem = checkRoommateEligibility(requester, candidate);
    if (problem) throw badRequest(`${fullName(candidate)}: ${problem}`);
    insert.run(signupId, candidateId, index + 1);
  });
}

function serializeSignup(signup: SignupRow) {
  const preferences = db
    .prepare(
      `SELECT p.preferred_user_id AS id, p.priority, u.first_name, u.last_name
         FROM dorm_preferences p JOIN users u ON u.id = p.preferred_user_id
        WHERE p.signup_id = ? ORDER BY p.priority`,
    )
    .all(signup.id) as Array<{ id: number; priority: number; first_name: string; last_name: string }>;

  const passenger = signup.car_passenger_id != null ? getUser(db, signup.car_passenger_id) : null;

  return {
    id: signup.id,
    tripId: signup.trip_id,
    cycleId: signup.cycle_id,
    userId: signup.user_id,
    status: signup.status,
    diet: signup.diet,
    dietConfirmed: signup.diet_confirmed === 1,
    notes: signup.notes,
    decisionNote: signup.decision_note,
    createdAt: signup.created_at,
    carStatus: signup.car_status,
    carPassenger: passenger ? { id: passenger.id, fullName: fullName(passenger) } : null,
    carDecisionNote: signup.car_decision_note,
    preferences: preferences.map((row) => ({
      id: row.id,
      priority: row.priority,
      fullName: `${row.first_name} ${row.last_name}`,
    })),
  };
}

/**
 * מועמדים לשותפות בחדר עבור המשתמש המחובר: אותו מין ואותה קבוצת דרגה בדיוק
 * (ראו checkRoommateEligibility) - כולל האופרטיבי מול רמ״ד, ששקולים לאותה
 * קבוצה (ראו rankGroup ב-org.ts). הסינון לפי דרג נעשה למטה, לא ב-SQL, כי
 * הוא מבוסס rankGroup ולא על role בלבד.
 */
signupsRouter.get('/:id/roommate-candidates', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycleId = req.query.cycleId ? idParam.parse(req.query.cycleId) : null;
  if (cycleId) getCycleOr404(trip.id, cycleId);

  const rows = db
    .prepare(
      `SELECT * FROM users
        WHERE status = 'approved' AND id != ? AND gender = ?
        ORDER BY last_name, first_name`,
    )
    .all(user.id, user.gender)
    .map((row) => plain<UserRow>(row));

  const eligible = rows.filter((row) => checkRoommateEligibility(user, row) === null);

  const signedUp = new Set(
    cycleId
      ? (
          db.prepare("SELECT user_id FROM signups WHERE cycle_id = ? AND status IN ('pending','approved')").all(
            cycleId,
          ) as Array<{ user_id: number }>
        ).map((row) => row.user_id)
      : [],
  );

  res.json({
    candidates: eligible.map((row) => ({
      id: row.id,
      fullName: fullName(row),
      unitPath: unitPath(db, row.id),
      signedUpForCycle: signedUp.has(row.id),
    })),
  });
});

/**
 * מועמדים לנוסע ברכב הפרטי: מי שרשום ומאושר לאותה פעימה, לא המבקש עצמו,
 * ולא כבר נוהג או נוסע ברכב של מישהו אחר.
 */
signupsRouter.get('/:id/car-passenger-candidates', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycleId = idParam.parse(req.query.cycleId);
  getCycleOr404(trip.id, cycleId);

  const rows = db
    .prepare(
      `SELECT s.*, u.first_name, u.last_name
         FROM signups s JOIN users u ON u.id = s.user_id
        WHERE s.trip_id = ? AND s.cycle_id = ? AND s.status = 'approved' AND s.user_id != ?
        ORDER BY u.last_name, u.first_name`,
    )
    .all(trip.id, cycleId, user.id)
    .map((row) => plain<SignupRow & { first_name: string; last_name: string }>(row));

  const takenPassengerIds = new Set(
    rows.filter((row) => row.car_passenger_id != null).map((row) => row.car_passenger_id as number),
  );

  const eligible = rows.filter(
    (row) => row.car_status === 'none' && !takenPassengerIds.has(row.user_id),
  );

  res.json({
    candidates: eligible.map((row) => ({
      id: row.user_id,
      fullName: `${row.first_name} ${row.last_name}`,
      unitPath: unitPath(db, row.user_id),
    })),
  });
});

/** ההרשמה שלי לגלישה. */
signupsRouter.get('/:id/my-signup', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const signup = getSignup(trip.id, user.id);
  res.json({ signup: signup ? serializeSignup(signup) : null });
});

/**
 * השלמת הפרטים של המשתמש עצמו: העדפות שותפים, אישור התזונה, ואופן ההגעה.
 * המשתמש אינו יכול לשבץ או להסיר את עצמו - רק להשלים את הפרטים שהמפקד לא מילא.
 */
const completeSchema = z.object({
  diet: z.enum(['all', 'vegetarian', 'vegan']).optional(),
  dietConfirmed: z.literal(true, { message: 'חובה לאשר את העדפת התזונה' }).optional(),
  preferences: z
    .array(z.number().int().positive())
    .max(MAX_DORM_PREFERENCES, `אפשר לבחור עד ${MAX_DORM_PREFERENCES} שותפים`)
    .optional(),
  notes: z.string().trim().max(300).optional(),
  /** true - רכב פרטי (חדש או עדכון נוסע); false - ביטול בקשת רכב וחזרה לאוטובוס. */
  wantsCar: z.boolean().optional(),
  carPassengerId: z.number().int().positive().nullish(),
});

signupsRouter.patch('/:id/my-signup', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  assertDetailsOpen(trip.id);

  const signup = getSignup(trip.id, user.id);
  if (!signup) {
    throw badRequest('לא שובצת לגלישה הזאת. השיבוץ נעשה על ידי המפקד שלך.');
  }

  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני ההרשמה אינם תקינים');
  const input = parsed.data;

  if (input.wantsCar != null && alwaysBringsOwnCar(user.role)) {
    throw badRequest('רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - אין צורך לבקש, ניתן לעדכן את מספר הרכב בפרופיל');
  }

  let passengerId: number | null = null;
  if (input.wantsCar && input.carPassengerId != null) {
    const problem = validateCarPassenger(signup, input.carPassengerId);
    if (problem) throw badRequest(problem);
    passengerId = input.carPassengerId;
  }

  const updated = tx(() => {
    db.prepare(
      `UPDATE signups
          SET diet = COALESCE(?, diet),
              diet_confirmed = CASE WHEN ? THEN 1 ELSE diet_confirmed END,
              notes = COALESCE(?, notes)
        WHERE id = ?`,
    ).run(input.diet ?? null, input.dietConfirmed ? 1 : 0, input.notes ?? null, signup.id);

    if (input.preferences) savePreferences(user, signup.id, input.preferences);

    if (input.wantsCar === true) {
      // ההעדפה היא שכמה שיותר אנשים יגיעו באוטובוס, ולכן בקשת רכב תמיד ממתינה
      // לאישור - ראו lib/cars.ts. רת״ח ומפמ״ר לא מגיעים לכאן כלל (נחסם למעלה).
      db.prepare(
        `UPDATE signups
            SET car_status = 'pending', car_passenger_id = ?, car_decided_by = NULL, car_decided_at = NULL,
                car_decision_note = NULL
          WHERE id = ?`,
      ).run(passengerId, signup.id);

      const approver = carApproverOf(user.id);
      if (approver) {
        notify(db, {
          userId: approver.id,
          kind: 'car_request_pending',
          title: 'בקשת רכב פרטי ממתינה לאישורך',
          body: `${fullName(user)} ביקש להגיע ברכב פרטי לגלישה ${trip.name}.`,
          link: `/trips/${trip.id}/approvals`,
        });
      }
    } else if (input.wantsCar === false) {
      db.prepare(
        `UPDATE signups
            SET car_status = 'none', car_passenger_id = NULL, car_decided_by = NULL, car_decided_at = NULL,
                car_decision_note = NULL
          WHERE id = ?`,
      ).run(signup.id);
    }

    return plain<SignupRow>(db.prepare('SELECT * FROM signups WHERE id = ?').get(signup.id));
  });

  res.json({ signup: serializeSignup(updated) });
});

// --- שיבוץ על ידי מפקד ----------------------------------------------------

/**
 * כל מי שהמפקד המחובר רשאי לשבץ, עם מצב השיבוץ הנוכחי של כל אחד.
 * זה המסך שבו רמ״ד/רת״ח בוחר את האנשים שלו.
 */
signupsRouter.get('/:id/signable', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const authority = signingAuthority(trip, manager);

  const closedNote = rosterClosedNote(trip);

  if (authority == null) {
    res.json({
      authority: null,
      hasDelegated: false,
      people: [],
      submittedAt: null,
      rosterClosed: closedNote != null,
      rosterClosedNote: closedNote,
      lateAdditions: [],
      note:
        manager.role === 'employee'
          ? 'חייל אינו משבץ את עצמו לגלישה. המפקד שלך משבץ אותך.'
          : 'לא קיבלת את משימת השיבוץ בגלישה הזאת, ואף מפקד מעליך לא האציל לך אותה.',
    });
    return;
  }

  const ids = signableUserIds(trip, manager);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT u.*, s.id AS signup_id, s.status AS signup_status, s.cycle_id, s.diet_confirmed,
              s.created_by, s.car_status AS signup_car_status, c.name AS cycle_name,
              cb.first_name AS by_first, cb.last_name AS by_last
         FROM users u
         LEFT JOIN signups s ON s.user_id = u.id AND s.trip_id = ?
         LEFT JOIN cycles c ON c.id = s.cycle_id
         LEFT JOIN users cb ON cb.id = s.created_by
        WHERE u.id IN (${placeholders})
        ORDER BY ${roleOrderSql('u.role')}, u.last_name, u.first_name`,
    )
    .all(trip.id, ...ids)
    .map((row) =>
      plain<
        UserRow & {
          signup_id: number | null;
          signup_status: string | null;
          cycle_id: number | null;
          diet_confirmed: number | null;
          created_by: number | null;
          signup_car_status: CarStatus | null;
          cycle_name: string | null;
          by_first: string | null;
          by_last: string | null;
        }
      >(row),
    );

  // הדרג שהמפקד יכול להאציל אליו, לתצוגה ("האצלת השיבוץ לרמ״דים" / "לר״צים") -
  // נגזר מהכפיפים הישירים שלו בפועל, ולא קבוע מראש, כי הוא תלוי במקומו בשרשרת.
  // לרת״ח יכולים להיות כפיפים משני תפקידים גם יחד (רמ״דים והאופרטיבי).
  const subordinateRoleLabel =
    authority === 'leader'
      ? (() => {
          const reports = directReportManagers(manager.id);
          return reports.length > 0 ? pluralRoleLabels(reports.map((row) => row.role)) : null;
        })()
      : null;

  res.json({
    authority,
    hasDelegated: isSigningLeader(manager.role) ? hasDelegated(trip.id, manager.id) : false,
    subordinateRoleLabel,
    // ההגשה של המפקד עצמו, ומי שנוסף ליחידה שלו אחריה וטרם שובץ.
    submittedAt: submittedAt(trip.id, manager.id),
    rosterClosed: closedNote != null,
    rosterClosedNote: closedNote,
    lateAdditions: lateAdditionIds(trip, manager),
    people: rows.map((row) => ({
      userId: row.id,
      companyId: row.company_id,
      fullName: fullName(row),
      role: row.role,
      gender: row.gender,
      diet: row.diet,
      unitPath: unitPath(db, row.id),
      isSelf: row.id === manager.id,
      signup: row.signup_id
        ? {
            id: row.signup_id,
            status: row.signup_status,
            cycleId: row.cycle_id,
            cycleName: row.cycle_name,
            dietConfirmed: row.diet_confirmed === 1,
            carStatus: row.signup_car_status,
            signedUpBy: row.by_first ? `${row.by_first} ${row.by_last}` : null,
            signedUpByMe: row.created_by === manager.id,
          }
        : null,
    })),
  });
});

const signPeopleSchema = z.object({
  cycleId: z.number().int().positive('חובה לבחור פעימת יציאה'),
  userIds: z.array(z.number().int().positive()).min(1, 'יש לבחור לפחות אדם אחד'),
});

/**
 * שיבוץ אנשים לגלישה על ידי המפקד.
 * רמ״ד/רת״ח - השיבוץ נכנס מיד ('approved').
 * ר״צ שקיבל האצלה - השיבוץ ממתין לאישור הרמ״ד ('pending').
 */
signupsRouter.post('/:id/signups', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  assertRosterOpen(trip.id);

  const parsed = signPeopleSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני השיבוץ אינם תקינים');
  const { cycleId, userIds } = parsed.data;
  getCycleOr404(trip.id, cycleId);

  const authority = signingAuthority(trip, manager);
  if (authority == null) {
    throw forbidden(
      manager.role === 'employee'
        ? 'חייל אינו משבץ את עצמו לגלישה. המפקד שלך משבץ אותך.'
        : 'אין לך הרשאת שיבוץ בגלישה הזאת',
    );
  }

  const status = authority === 'leader' ? 'approved' : 'pending';
  const added: number[] = [];
  const skipped: Array<{ userId: number; reason: string }> = [];

  tx(() => {
    const insert = db.prepare(
      `INSERT INTO signups (trip_id, cycle_id, user_id, created_by, diet, diet_confirmed, status, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );

    for (const targetId of new Set(userIds)) {
      assertCanSign(trip, manager, targetId);

      const target = getApprovedUser(targetId);
      if (!target) {
        skipped.push({ userId: targetId, reason: 'המשתמש לא נמצא או אינו מאושר' });
        continue;
      }
      if (getSignup(trip.id, targetId)) {
        skipped.push({ userId: targetId, reason: `${fullName(target)} כבר משובץ לגלישה` });
        continue;
      }

      insert.run(
        trip.id,
        cycleId,
        targetId,
        manager.id,
        target.diet,
        status,
        status === 'approved' ? manager.id : null,
        status === 'approved' ? new Date().toISOString() : null,
      );
      added.push(targetId);

      // האדם עצמו מתבקש להשלים העדפות שותפים ואישור תזונה.
      notify(db, {
        userId: targetId,
        kind: 'signed_up_by_manager',
        title: `שובצת לגלישה ${trip.name}`,
        body: `${fullName(manager)} שיבץ אותך לגלישה. יש להשלים בחירת שותפים לחדר ואישור תזונה.`,
        link: `/trips/${trip.id}`,
      });
    }

    // ר״צ שקיבל האצלה - הרמ״ד שמעליו מתבקש לאשר.
    if (status === 'pending' && added.length > 0) {
      const leaderId = responsibleLeaderId(trip.id, manager.id);
      if (leaderId != null && leaderId !== manager.id) {
        notify(db, {
          userId: leaderId,
          kind: 'signups_pending_confirmation',
          title: `${added.length} שיבוצים ממתינים לאישורך`,
          body: `${fullName(manager)} שיבץ אנשים לגלישה ${trip.name} וממתין לאישור שלך.`,
          link: `/trips/${trip.id}/approvals`,
        });
      }
    }
  });

  res.status(201).json({ added: added.length, skipped, status });
});

/**
 * הסרת אדם מהגלישה על ידי המפקד ששיבץ אותו (או מפקד מעליו) - או האופרטיבי,
 * שסוקר את מי שהמפקדים שיבצו ורשאי להסיר כל אחד, גם מחוץ לשרשרת הפיקוד שלו
 * (ראו ParticipantsTab ב-OrganizerTripPage - "אישור" הרשימה).
 */
signupsRouter.delete('/:id/signups/:signupId', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const signupId = idParam.parse(req.params.signupId);
  assertRosterOpen(trip.id);

  const row = db.prepare('SELECT * FROM signups WHERE id = ? AND trip_id = ?').get(signupId, trip.id);
  if (!row) throw notFound('השיבוץ לא נמצא');
  const signup = plain<SignupRow>(row);

  if (manager.role !== 'to') assertCanSign(trip, manager, signup.user_id);
  const target = getUser(db, signup.user_id);

  tx(() => {
    db.prepare('DELETE FROM signups WHERE id = ?').run(signup.id);
    if (target) {
      notify(db, {
        userId: target.id,
        kind: 'signup_removed',
        title: `הוסרת מהגלישה ${trip.name}`,
        body: `${fullName(manager)} הסיר אותך מרשימת המשתתפים.`,
        link: `/trips/${trip.id}`,
      });
    }
  });

  res.json({ ok: true });
});

// --- אישור האופרטיבי --------------------------------------------------------
// שכבה נוספת מעל אישור המפקד (status='approved'): עד שהאופרטיבי מאשר, האדם
// לא נכנס לשיבוץ אוטובוסים/לינה ולא נספר בדוח המזון - ראו loadCycleParticipants.

/** אישור בודד - האופרטיבי מאשר שיבוץ אחד שהמפקד כבר אישר. */
signupsRouter.post('/:id/signups/:signupId/to-approve', requireTO, (req, res) => {
  const to = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const signupId = idParam.parse(req.params.signupId);

  const row = db.prepare('SELECT * FROM signups WHERE id = ? AND trip_id = ?').get(signupId, trip.id);
  if (!row) throw notFound('השיבוץ לא נמצא');
  const signup = plain<SignupRow>(row);
  if (signup.status !== 'approved') throw badRequest('אפשר לאשר רק שיבוץ שהמפקד כבר אישר');
  if (signup.to_approved_at != null) throw badRequest('השיבוץ כבר אושר');

  const target = getUser(db, signup.user_id);

  tx(() => {
    db.prepare(`UPDATE signups SET to_approved_by = ?, to_approved_at = ${NOW_MS} WHERE id = ?`).run(to.id, signup.id);
    if (target) {
      notify(db, {
        userId: target.id,
        kind: 'to_approved',
        title: `השיבוץ שלך לגלישה ${trip.name} אושר סופית`,
        body: `${fullName(to)} אישר את השיבוץ שלך.`,
        link: `/trips/${trip.id}`,
      });
    }
  });

  res.json({ ok: true });
});

/** אישור מרוכז - כל מי שהמפקדים אישרו בפעימה מסוימת ועדיין ממתין לאישור האופרטיבי. */
signupsRouter.post('/:id/cycles/:cycleId/to-approve-all', requireTO, (req, res) => {
  const to = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycle = getCycleOr404(trip.id, idParam.parse(req.params.cycleId));

  const pending = db
    .prepare(`SELECT id, user_id FROM signups WHERE cycle_id = ? AND status = 'approved' AND to_approved_at IS NULL`)
    .all(cycle.id) as Array<{ id: number; user_id: number }>;

  tx(() => {
    const approve = db.prepare(`UPDATE signups SET to_approved_by = ?, to_approved_at = ${NOW_MS} WHERE id = ?`);
    for (const row of pending) approve.run(to.id, row.id);

    notifyMany(
      db,
      pending.map((row) => row.user_id),
      {
        kind: 'to_approved',
        title: `השיבוץ שלך לגלישה ${trip.name} אושר סופית`,
        body: `${fullName(to)} אישר את השיבוץ שלך.`,
        link: `/trips/${trip.id}`,
      },
    );
  });

  res.json({ ok: true, approved: pending.length });
});

// --- הגשת הרשימה על ידי המפקד ---------------------------------------------
// המפקד מצהיר שסיים לשבץ את האנשים שלו. ההגשה אינה נועלת: אם אדם חדש מאושר
// ליחידה שלו אחר כך, הוא מקבל התראה ורשאי להוסיף אותו - עד שהאופרטיבי מגיש
// את הגלישה. עד אז אפשר גם לבטל את ההגשה ולהמשיך לערוך.

signupsRouter.post('/:id/submit-signing', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const authority = assertSigningAuthority(trip, manager);
  assertRosterOpen(trip.id);

  if (hasSubmitted(trip.id, manager.id)) throw badRequest('כבר הגשת את הרשימה שלך');

  const count = signedCount(trip, manager);

  const submitted = tx(() => {
    const row = db
      // הזמן נכתב במפורש ולא דרך ברירת המחדל של הטבלה, כדי שגם מסד קיים יקבל
      // רזולוציית מילישנייה (ראה NOW_MS) - אי אפשר לשנות DEFAULT בדיעבד ב-SQLite.
      .prepare(`INSERT INTO trip_submissions (trip_id, manager_id, submitted_at) VALUES (?, ?, ${NOW_MS}) RETURNING submitted_at`)
      .get(trip.id, manager.id) as { submitted_at: string };

    // מפקד שקיבל את המשימה מדווח לאופרטיבי; מפקד באצילה מדווח למי שהאציל לו.
    const recipientId = authority === 'leader' ? trip.created_by : responsibleLeaderId(trip.id, manager.id);
    if (recipientId != null && recipientId !== manager.id) {
      notify(db, {
        userId: recipientId,
        kind: 'signing_submitted',
        title: `${fullName(manager)} הגיש את רשימת האנשים לגלישה ${trip.name}`,
        body: `${count} אנשים ברשימה.`,
        link: authority === 'leader' ? `/manage/${trip.id}` : `/trips/${trip.id}/approvals`,
      });
    }

    return row.submitted_at;
  });

  res.json({ ok: true, submittedAt: submitted, signedCount: count });
});

/** ביטול ההגשה - המפקד חוזר לערוך את הרשימה שלו. */
signupsRouter.delete('/:id/submit-signing', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  assertSigningAuthority(trip, manager);
  assertRosterOpen(trip.id);

  const result = db
    .prepare('DELETE FROM trip_submissions WHERE trip_id = ? AND manager_id = ?')
    .run(trip.id, manager.id);
  if (result.changes === 0) throw badRequest('לא הגשת את הרשימה בגלישה הזאת');

  res.json({ ok: true });
});

// --- האצלת השיבוץ למפקדים שמתחת -------------------------------------------

/**
 * מפקד עם משימת שיבוץ בוחר אם לשבץ בעצמו או להאציל את השיבוץ למפקדים שמתחתיו.
 * ההאצלה יורדת דרגה אחת בשרשרת - לכפיפים הישירים של המאציל שהם עצמם מפקדים
 * (רת״ח מאציל לרמ״דים שלו, רמ״ד/אופרטיבי לר״צים שלו) - ולא ישר לר״צים בכל
 * המדור, כדי שהדרג שביניהם לא ידולג עליו.
 */
signupsRouter.post('/:id/delegation', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (!isSigningLeader(manager.role)) {
    throw forbidden(`רק ${roleLabels(SIGNING_LEADER_ROLES)} יכולים להאציל שיבוץ`);
  }
  assertRosterOpen(trip.id);

  const subordinates = directReportManagers(manager.id);
  if (subordinates.length === 0) throw badRequest('אין מפקדים תחתיך להאציל להם את השיבוץ');
  const roleLabel = pluralRoleLabels(subordinates.map((row) => row.role));
  const subordinateManagerIds = subordinates.map((row) => row.id);

  tx(() => {
    db.prepare('INSERT OR IGNORE INTO trip_delegations (trip_id, manager_id) VALUES (?, ?)').run(
      trip.id,
      manager.id,
    );
    notifyMany(db, subordinateManagerIds, {
      kind: 'signing_delegated',
      title: `עליך לשבץ את הצוות שלך לגלישה ${trip.name}`,
      body: `${fullName(manager)} האציל לך את השיבוץ. לאחר השיבוץ הוא יאשר את הרשימה.`,
      link: `/trips/${trip.id}/signing`,
    });
  });

  res.json({ ok: true, delegatedTo: subordinateManagerIds.length, roleLabel });
});

/** ביטול ההאצלה - הרמ״ד חוזר לשבץ בעצמו. */
signupsRouter.delete('/:id/delegation', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (!isSigningLeader(manager.role)) {
    throw forbidden(`רק ${roleLabels(SIGNING_LEADER_ROLES)} יכולים לבטל האצלה`);
  }
  assertRosterOpen(trip.id);

  const result = db
    .prepare('DELETE FROM trip_delegations WHERE trip_id = ? AND manager_id = ?')
    .run(trip.id, manager.id);
  if (result.changes === 0) throw badRequest('לא האצלת את השיבוץ בגלישה הזאת');

  res.json({ ok: true });
});

/** בקשות ההרשמה של הכפיפים שממתינות לאישור המשתמש המחובר. */
signupsRouter.get('/:id/approvals', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const ids = subordinateIds(db, manager.id);
  if (ids.length === 0) {
    res.json({ signups: [] });
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.*, u.first_name, u.last_name, u.company_id, u.gender, u.role, c.name AS cycle_name, c.exit_date
         FROM signups s
         JOIN users u ON u.id = s.user_id
         JOIN cycles c ON c.id = s.cycle_id
        WHERE s.trip_id = ? AND s.user_id IN (${placeholders})
        ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, u.last_name, u.first_name`,
    )
    .all(trip.id, ...ids)
    .map((row) =>
      plain<
        SignupRow & {
          first_name: string;
          last_name: string;
          company_id: string;
          gender: string;
          role: string;
          cycle_name: string;
          exit_date: string;
        }
      >(row),
    );

  res.json({
    signups: rows.map((row) => ({
      ...serializeSignup(plain<SignupRow>(row)),
      user: {
        id: row.user_id,
        fullName: `${row.first_name} ${row.last_name}`,
        companyId: row.company_id,
        gender: row.gender,
        role: row.role,
        unitPath: unitPath(db, row.user_id),
      },
      cycle: { id: row.cycle_id, name: row.cycle_name, exitDate: row.exit_date },
    })),
  });
});

const decisionSchema = z.object({ note: z.string().trim().max(300).optional() });

/** אישור או דחייה של בקשת הרשמה של כפיף. */
for (const decision of ['approve', 'reject'] as const) {
  signupsRouter.post(`/:id/signups/:signupId/${decision}`, (req, res) => {
    const manager = requireUser(req);
    const trip = getTripOr404(idParam.parse(req.params.id));
    const signupId = idParam.parse(req.params.signupId);

    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('הערה אינה תקינה');
    assertRosterOpen(trip.id);

    const row = db.prepare('SELECT * FROM signups WHERE id = ? AND trip_id = ?').get(signupId, trip.id);
    if (!row) throw notFound('בקשת ההרשמה לא נמצאה');
    const signup = plain<SignupRow>(row);

    const target = getUser(db, signup.user_id);
    if (!target) throw notFound('המשתמש לא נמצא');
    if (target.manager_id !== manager.id && !isAncestorOf(db, manager.id, target.id)) {
      throw forbidden('המשתמש הזה אינו כפוף לך');
    }

    const status = decision === 'approve' ? 'approved' : 'rejected';

    tx(() => {
      db.prepare(
        `UPDATE signups SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`,
      ).run(status, manager.id, parsed.data.note ?? null, signup.id);

      notify(db, {
        userId: target.id,
        kind: `signup_${status}`,
        title: status === 'approved' ? 'ההרשמה שלך לגלישה אושרה' : 'ההרשמה שלך לגלישה נדחתה',
        body:
          status === 'approved'
            ? `${fullName(manager)} אישר את ההרשמה שלך לגלישה ${trip.name}.`
            : `${fullName(manager)} דחה את ההרשמה שלך לגלישה ${trip.name}.${
                parsed.data.note ? ` סיבה: ${parsed.data.note}` : ''
              }`,
        link: `/trips/${trip.id}`,
      });
    });

    res.json({ signup: serializeSignup(plain<SignupRow>(db.prepare('SELECT * FROM signups WHERE id = ?').get(signup.id))) });
  });
}

// --- בקשות רכב פרטי ---------------------------------------------------------

const bulkCarRequestSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1, 'יש לבחור לפחות אדם אחד'),
});

/**
 * בקשת רכב פרטי עבור כמה מהאנשים שלי בבת אחת - למשל רמ״ד שמבקש עבור כמה
 * מהחיילים בצוות שלו, לא אחד-אחד. כל בקשה ממתינה לאישור בדיוק כמו בקשה
 * אישית (ראו PATCH /my-signup ו-lib/cars.ts) - זו רק דרך מהירה להגיש הרבה
 * בקשות יחד, לא אישור אוטומטי.
 */
signupsRouter.post('/:id/car-requests/bulk', (req, res) => {
  const manager = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  assertDetailsOpen(trip.id);

  const parsed = bulkCarRequestSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'רשימת האנשים אינה תקינה');

  const requested: number[] = [];
  const skipped: Array<{ userId: number; reason: string }> = [];
  const approverIds = new Set<number>();

  tx(() => {
    for (const targetId of new Set(parsed.data.userIds)) {
      const target = getUser(db, targetId);
      if (!target) {
        skipped.push({ userId: targetId, reason: 'המשתמש לא נמצא' });
        continue;
      }
      if (targetId !== manager.id && !isAncestorOf(db, manager.id, targetId)) {
        skipped.push({ userId: targetId, reason: `${fullName(target)} אינו כפוף לך` });
        continue;
      }
      if (alwaysBringsOwnCar(target.role)) {
        skipped.push({ userId: targetId, reason: `${fullName(target)} תמיד מגיע ברכב הפרטי שלו - אין צורך לבקש` });
        continue;
      }
      const signup = getSignup(trip.id, targetId);
      if (!signup || signup.status !== 'approved') {
        skipped.push({ userId: targetId, reason: `${fullName(target)} אינו משובץ ומאושר לגלישה` });
        continue;
      }
      if (signup.car_status !== 'none') {
        skipped.push({ userId: targetId, reason: `${fullName(target)} כבר ביקש רכב` });
        continue;
      }

      db.prepare(
        `UPDATE signups
            SET car_status = 'pending', car_passenger_id = NULL, car_decided_by = NULL, car_decided_at = NULL,
                car_decision_note = NULL
          WHERE id = ?`,
      ).run(signup.id);
      requested.push(targetId);

      const approver = carApproverOf(targetId);
      if (approver) approverIds.add(approver.id);
    }

    if (requested.length > 0) {
      notifyMany(db, [...approverIds], {
        kind: 'car_request_pending',
        title: 'בקשות רכב פרטי ממתינות לאישורך',
        body: `${fullName(manager)} ביקש רכב פרטי עבור ${requested.length} מהאנשים שלו בגלישה ${trip.name}.`,
        link: `/trips/${trip.id}/approvals`,
      });
    }
  });

  res.status(201).json({ requested: requested.length, skipped });
});

/** בקשות רכב שממתינות לאישור המשתמש המחובר - רת״ח בשרשרת הפיקוד, או האופרטיבי לכולן. */
signupsRouter.get('/:id/car-requests', (req, res) => {
  const approver = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  const rows = db
    .prepare(
      `SELECT s.*, u.first_name, u.last_name, u.company_id, u.role, u.car_plate, c.name AS cycle_name, c.exit_date
         FROM signups s
         JOIN users u ON u.id = s.user_id
         JOIN cycles c ON c.id = s.cycle_id
        WHERE s.trip_id = ? AND s.car_status = 'pending'
        ORDER BY s.created_at`,
    )
    .all(trip.id)
    .map((row) =>
      plain<
        SignupRow & {
          first_name: string;
          last_name: string;
          company_id: string;
          role: string;
          car_plate: string | null;
          cycle_name: string;
          exit_date: string;
        }
      >(row),
    )
    .filter((row) => canApproveCarRequest(approver, row.user_id));

  res.json({
    requests: rows.map((row) => ({
      ...serializeSignup(plain<SignupRow>(row)),
      user: {
        id: row.user_id,
        fullName: `${row.first_name} ${row.last_name}`,
        companyId: row.company_id,
        role: row.role,
        carPlate: row.car_plate,
        unitPath: unitPath(db, row.user_id),
      },
      cycle: { id: row.cycle_id, name: row.cycle_name, exitDate: row.exit_date },
    })),
  });
});

/** אישור או דחייה של בקשת רכב פרטי. */
for (const decision of ['approve', 'reject'] as const) {
  signupsRouter.post(`/:id/car-requests/:signupId/${decision}`, (req, res) => {
    const approver = requireUser(req);
    const trip = getTripOr404(idParam.parse(req.params.id));
    const signupId = idParam.parse(req.params.signupId);

    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('הערה אינה תקינה');

    const signup = getSignupOr404(signupId);
    if (signup.trip_id !== trip.id) throw notFound('בקשת הרכב לא נמצאה');
    assertCarRequestPending(signup);

    if (!canApproveCarRequest(approver, signup.user_id)) {
      throw forbidden('רק רת״ח בשרשרת הפיקוד, או האופרטיבי, יכולים להחליט על בקשת הרכב');
    }

    const target = getUser(db, signup.user_id);
    if (!target) throw notFound('המשתמש לא נמצא');
    const status = decision === 'approve' ? 'approved' : 'rejected';

    tx(() => {
      db.prepare(
        `UPDATE signups
            SET car_status = ?, car_decided_by = ?, car_decided_at = datetime('now'), car_decision_note = ?
          WHERE id = ?`,
      ).run(status, approver.id, parsed.data.note ?? null, signup.id);

      if (status === 'rejected') {
        db.prepare('UPDATE signups SET car_passenger_id = NULL WHERE id = ?').run(signup.id);
      }

      notify(db, {
        userId: target.id,
        kind: `car_request_${status}`,
        title: status === 'approved' ? 'בקשת הרכב הפרטי שלך אושרה' : 'בקשת הרכב הפרטי שלך נדחתה',
        body:
          status === 'approved'
            ? `${fullName(approver)} אישר את בקשת הרכב הפרטי שלך לגלישה ${trip.name}.`
            : `${fullName(approver)} דחה את בקשת הרכב הפרטי שלך לגלישה ${trip.name}.${
                parsed.data.note ? ` סיבה: ${parsed.data.note}` : ''
              }`,
        link: `/trips/${trip.id}`,
      });
    });

    res.json({
      signup: serializeSignup(plain<SignupRow>(db.prepare('SELECT * FROM signups WHERE id = ?').get(signup.id))),
    });
  });
}
