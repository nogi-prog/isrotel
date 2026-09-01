import { Router } from 'express';
import { z } from 'zod';
import { db, plain, tx } from '../db/index.ts';
import { requireApproved, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest } from '../lib/errors.ts';
import { getCycleOr404, getSignup, getTripOr404, listCycles, renumberCycles } from '../lib/trips.ts';
import {
  assignedLeaderIds,
  hasDelegated,
  isSigningLeader,
  leaderSignedCount,
  rosterClosedNote,
  signingAuthority,
  signingManagerIds,
  submittedAt,
  submittedManagerIds,
} from '../lib/signing.ts';
import { fullName, getUser } from '../lib/org.ts';
import { notifyMany } from '../lib/notify.ts';
import {
  DEFAULT_BUS_CAPACITY,
  SIGNING_LEADER_ROLES,
  TRIP_STATES,
  TRIP_STATE_LABEL,
  TRIP_STATE_TRANSITIONS,
  roleLabels,
  roleOrderSql,
  type TripRow,
} from '../types.ts';

export const tripsRouter = Router();

tripsRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'תאריך חייב להיות בתבנית YYYY-MM-DD');

/**
 * פעימת יציאה: תאריך יציאה בלבד. הפעימה היא גל של יום אחד, ואין תאריך חזרה.
 * השם נגזר מסדר היציאה (חלוץ, פעימה 1, ...) ולכן אינו נשלח מהטופס.
 */
const cycleSchema = z.object({
  exitDate: dateSchema,
});

/**
 * יצירת גלישה: האופרטיבי בוחר שם (לא חובה - "גלישה #N" אוטומטי אם נשאר ריק),
 * את המפקדים שקיבלו את משימת שיבוץ האנשים, ואת פעימות היציאה. אין יעד או
 * תיאור. תאריך הפרסום הוא רגע הלחיצה על הכפתור - לא שדה שממלאים.
 */
const tripSchema = z.object({
  name: z.string().trim().max(80).optional(),
  leaderIds: z.array(z.number().int().positive()).min(1, 'יש לבחור לפחות מפקד אחד שישבץ אנשים'),
  cycles: z.array(cycleSchema).min(1, 'יש להגדיר לפחות פעימה אחת - החלוץ'),
});

/** מספר המשתתפים לפי מצב ההרשמה, לכל פעימה. */
function cycleCounts(tripId: number): Map<number, { approved: number; pending: number }> {
  const rows = db
    .prepare(
      `SELECT cycle_id, status, COUNT(*) AS count
         FROM signups
        WHERE trip_id = ? AND status IN ('approved', 'pending')
        GROUP BY cycle_id, status`,
    )
    .all(tripId) as Array<{ cycle_id: number; status: string; count: number }>;

  const result = new Map<number, { approved: number; pending: number }>();
  for (const row of rows) {
    const entry = result.get(row.cycle_id) ?? { approved: 0, pending: 0 };
    if (row.status === 'approved') entry.approved = row.count;
    else entry.pending = row.count;
    result.set(row.cycle_id, entry);
  }
  return result;
}

function serializeTrip(trip: TripRow, userId: number) {
  const counts = cycleCounts(trip.id);
  const signup = getSignup(trip.id, userId);
  const carPassenger =
    signup?.car_passenger_id != null ? getUser(db, signup.car_passenger_id) : null;
  const cycles = listCycles(trip.id).map((cycle) => ({
    id: cycle.id,
    name: cycle.name,
    exitDate: cycle.exit_date,
    approvedCount: counts.get(cycle.id)?.approved ?? 0,
    pendingCount: counts.get(cycle.id)?.pending ?? 0,
  }));

  const user = getUser(db, userId);
  const authority = user ? signingAuthority(trip, user) : null;

  // המפקדים שקיבלו את משימת השיבוץ, עם מספר האנשים שכל אחד שיבץ עד כה
  // והאם כבר הגיש את הרשימה שלו.
  const leaders = (
    db
      .prepare(
        `SELECT u.id, u.first_name, u.last_name, u.role, u.unit_name,
                (SELECT COUNT(*) FROM trip_delegations d WHERE d.trip_id = tl.trip_id AND d.manager_id = u.id) AS delegated,
                (SELECT ts.submitted_at FROM trip_submissions ts
                  WHERE ts.trip_id = tl.trip_id AND ts.manager_id = u.id) AS submitted_at
           FROM trip_leaders tl JOIN users u ON u.id = tl.manager_id
          WHERE tl.trip_id = ?
          ORDER BY ${roleOrderSql('u.role')}, u.unit_name, u.last_name`,
      )
      .all(trip.id) as Array<{
      id: number;
      first_name: string;
      last_name: string;
      role: string;
      unit_name: string | null;
      delegated: number;
      submitted_at: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    fullName: `${row.first_name} ${row.last_name}`,
    role: row.role,
    unitName: row.unit_name,
    hasDelegated: row.delegated > 0,
    submittedAt: row.submitted_at,
    signedCount: leaderSignedCount(trip.id, row.id),
  }));

  const closedNote = rosterClosedNote(trip);

  return {
    id: trip.id,
    name: trip.name,
    state: trip.state,
    stateLabel: TRIP_STATE_LABEL[trip.state],
    launchDate: trip.launch_date,
    busCapacity: trip.bus_capacity,
    leaders,
    leadersNotified: trip.leaders_notified_at != null,
    leadersNotifiedAt: trip.leaders_notified_at,
    busesLocked: trip.buses_locked_at != null,
    busesLockedAt: trip.buses_locked_at,
    dormsLocked: trip.dorms_locked_at != null,
    dormsLockedAt: trip.dorms_locked_at,
    // הגשת הגלישה על ידי האופרטיבי - מכאן רשימת המשתתפים קפואה לכולם.
    submitted: trip.submitted_at != null,
    submittedAt: trip.submitted_at,
    // ההגשה של המשתמש הצופה עצמו (רשימת האנשים שלו), אם הוא מפקד שהגיש.
    mySubmittedAt: submittedAt(trip.id, userId),
    rosterClosed: closedNote != null,
    createdAt: trip.created_at,
    cycles,
    // הרשאת השיבוץ של המשתמש הנוכחי בגלישה הזאת, לצורך הצגת המסכים.
    signingAuthority: authority,
    hasDelegated: user != null && isSigningLeader(user.role) ? hasDelegated(trip.id, user.id) : false,
    mySignup: signup
      ? {
          id: signup.id,
          cycleId: signup.cycle_id,
          status: signup.status,
          diet: signup.diet,
          dietConfirmed: signup.diet_confirmed === 1,
          notes: signup.notes,
          decisionNote: signup.decision_note,
          signedUpByMe: signup.created_by === userId,
          carStatus: signup.car_status,
          carPassenger: carPassenger ? { id: carPassenger.id, fullName: fullName(carPassenger) } : null,
          carDecisionNote: signup.car_decision_note,
        }
      : null,
  };
}

/** רשימת הגלישות. */
tripsRouter.get('/', (req, res) => {
  const user = requireUser(req);
  const rows = db.prepare('SELECT * FROM trips ORDER BY launch_date DESC, id DESC').all();
  res.json({ trips: rows.map((row) => serializeTrip(plain<TripRow>(row), user.id)) });
});

/**
 * המפקדים שהאופרטיבי יכול להטיל עליהם את משימת השיבוץ: מפמ״ר, רת״ח, רמ״ד
 * והאופרטיבי עצמו (שמפקד על מדור משלו).
 * חייב להיות רשום לפני `/:id`, אחרת הנתיב ייחשב למזהה גלישה.
 */
tripsRouter.get('/signing-leaders', requireTO, (_req, res) => {
  const placeholders = SIGNING_LEADER_ROLES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT u.id, u.first_name, u.last_name, u.role, u.unit_name,
              (SELECT COUNT(*) FROM users s WHERE s.manager_id = u.id AND s.status = 'approved') AS direct_reports
         FROM users u
        WHERE u.status = 'approved' AND u.role IN (${placeholders})
        ORDER BY ${roleOrderSql('u.role')}, u.unit_name, u.last_name`,
    )
    .all(...SIGNING_LEADER_ROLES) as Array<{
    id: number;
    first_name: string;
    last_name: string;
    role: string;
    unit_name: string | null;
    direct_reports: number;
  }>;

  res.json({
    leaders: rows.map((row) => ({
      id: row.id,
      fullName: `${row.first_name} ${row.last_name}`,
      role: row.role,
      unitName: row.unit_name,
      directReports: row.direct_reports,
    })),
  });
});

tripsRouter.get('/:id', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  res.json({ trip: serializeTrip(trip, user.id) });
});

/**
 * יצירת גלישה חדשה - אופרטיבי בלבד.
 * הגלישה נכנסת מיד למצב LAUNCHED, המצב הראשון במכונת המצבים.
 * השם נוצר אוטומטית לפי המזהה: "גלישה #1", "גלישה #2" וכן הלאה, ושמות
 * הפעימות נגזרים מסדר היציאה: "חלוץ", "פעימה 1" וכן הלאה.
 */
tripsRouter.post('/', requireTO, (req, res) => {
  const user = requireUser(req);
  const parsed = tripSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני הגלישה אינם תקינים');
  const input = parsed.data;

  // כל מפקד שנבחר חייב להיות מאושר ומאחד הדרגים שרשאים לקבל את משימת השיבוץ.
  const leaders = [...new Set(input.leaderIds)].map((leaderId) => {
    const leader = getUser(db, leaderId);
    if (!leader || leader.status !== 'approved') throw badRequest('אחד המפקדים שנבחרו לא נמצא במערכת');
    if (!isSigningLeader(leader.role)) {
      throw badRequest(`${leader.first_name} ${leader.last_name} אינו ${roleLabels(SIGNING_LEADER_ROLES)}`);
    }
    return leader;
  });

  const trip = tx(() => {
    const created = plain<TripRow>(
      db
        .prepare(
          `INSERT INTO trips (name, launch_date, bus_capacity, created_by, state)
           VALUES ('', date('now'), ?, ?, 'LAUNCHED') RETURNING *`,
        )
        .get(DEFAULT_BUS_CAPACITY, user.id),
    );

    const name = input.name || `גלישה #${created.id}`;
    db.prepare('UPDATE trips SET name = ? WHERE id = ?').run(name, created.id);

    const assign = db.prepare('INSERT INTO trip_leaders (trip_id, manager_id) VALUES (?, ?)');
    for (const leader of leaders) assign.run(created.id, leader.id);

    // השמות נכתבים ריקים ומחושבים ב-renumberCycles לפי סדר היציאה.
    const insertCycle = db.prepare('INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, ?, ?)');
    for (const cycle of input.cycles) insertCycle.run(created.id, '', cycle.exitDate);
    renumberCycles(created.id);

    return { ...created, name };
  });

  res.status(201).json({ trip: serializeTrip(trip, user.id) });
});

const updateTripSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  launchDate: dateSchema.optional(),
  leaderIds: z.array(z.number().int().positive()).min(1).optional(),
  state: z.enum(TRIP_STATES).optional(),
});

tripsRouter.patch('/:id', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const parsed = updateTripSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני הגלישה אינם תקינים');
  const input = parsed.data;

  // מעברי מצב מותרים בלבד.
  let reopening = false;
  if (input.state != null && input.state !== trip.state) {
    if (!TRIP_STATE_TRANSITIONS[trip.state].includes(input.state)) {
      throw badRequest(
        `אי אפשר לעבור מ״${TRIP_STATE_LABEL[trip.state]}״ ל״${TRIP_STATE_LABEL[input.state]}״`,
      );
    }
    // פתיחה מחדש של גלישה סגורה: אם היא הוגשה לפני הסגירה, submitted_at עדיין
    // מוגדר ויחסום כל הוספה/הסרה של אנשים (assertRosterOpen) - למרות שהמצב
    // כבר LAUNCHED. פתיחה מחדש נועדה בדיוק לאפשר עריכה מחדש, אז מבטלים גם
    // את ההגשה, בדיוק כמו DELETE /:id/submit.
    reopening = trip.state === 'CLOSED' && input.state === 'LAUNCHED';
  }

  // עדכון רשימת המפקדים שקיבלו את משימת השיבוץ.
  if (input.leaderIds) {
    if (trip.buses_locked_at || trip.dorms_locked_at) {
      throw badRequest('אי אפשר לשנות את המפקדים לאחר נעילת השיבוצים');
    }
    tx(() => {
      db.prepare('DELETE FROM trip_leaders WHERE trip_id = ?').run(trip.id);
      const assign = db.prepare('INSERT INTO trip_leaders (trip_id, manager_id) VALUES (?, ?)');
      for (const leaderId of new Set(input.leaderIds)) {
        const leader = getUser(db, leaderId);
        if (!leader || leader.status !== 'approved' || !isSigningLeader(leader.role)) {
          throw badRequest(`אחד המפקדים שנבחרו אינו ${roleLabels(SIGNING_LEADER_ROLES)} מאושר`);
        }
        assign.run(trip.id, leaderId);
      }
    });
  }

  db.prepare(
    `UPDATE trips
        SET name = COALESCE(?, name),
            launch_date = COALESCE(?, launch_date),
            state = COALESCE(?, state),
            submitted_at = CASE WHEN ? THEN NULL ELSE submitted_at END
      WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.launchDate ?? null,
    input.state ?? null,
    reopening ? 1 : 0,
    trip.id,
  );

  res.json({ trip: serializeTrip(getTripOr404(trip.id), user.id) });
});

/**
 * הפעולה של מצב LAUNCHED: האופרטיבי מודיע למפקדים שקיבלו את משימת השיבוץ
 * שיש גלישה חדשה ושעליהם לשבץ את האנשים שלהם.
 * ניתן לשלוח שוב כתזכורת.
 */
tripsRouter.post('/:id/notify-leaders', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.state !== 'LAUNCHED') throw badRequest('אפשר להודיע למפקדים רק בגלישה במצב פורסם');
  if (listCycles(trip.id).length === 0) {
    throw badRequest('יש להגדיר לפחות פעימת יציאה אחת לפני ההודעה למפקדים');
  }

  const leaderIds = assignedLeaderIds(trip.id);
  if (leaderIds.length === 0) throw badRequest('לא הוגדרו מפקדים שקיבלו את משימת השיבוץ');

  const reminder = trip.leaders_notified_at != null;

  tx(() => {
    notifyMany(db, leaderIds, {
      kind: reminder ? 'trip_launched_reminder' : 'trip_launched',
      title: reminder ? `תזכורת: שיבוץ אנשים לגלישה ${trip.name}` : `גלישה חדשה: ${trip.name}`,
      body: 'עליך לשבץ את האנשים שלך לגלישה, או להאציל את השיבוץ למפקדים שמתחתיך.',
      link: `/trips/${trip.id}/signing`,
    });
    db.prepare("UPDATE trips SET leaders_notified_at = datetime('now') WHERE id = ?").run(trip.id);
  });

  res.json({ ok: true, notified: leaderIds.length, reminder, trip: serializeTrip(getTripOr404(trip.id), user.id) });
});

/**
 * הגשת הגלישה על ידי האופרטיבי - אופרטיבי בלבד.
 * זה הרגע שמקפיא את רשימת המשתתפים לכולם: מכאן אף מפקד אינו יכול להוסיף או
 * להסיר אנשים. הפרטים האישיים (שותפים ותזונה) נשארים פתוחים, כי שיבוץ הלינה
 * מתבצע אחרי ההגשה.
 * מפקדים שלא הגישו את הרשימה שלהם מדווחים בתשובה, אך אינם חוסמים את ההגשה.
 */
tripsRouter.post('/:id/submit', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.state !== 'LAUNCHED') throw badRequest('אפשר להגיש רק גלישה במצב פורסם');
  if (trip.submitted_at != null) throw badRequest('הגלישה כבר הוגש');
  if (listCycles(trip.id).length === 0) throw badRequest('יש להגדיר לפחות פעימת יציאה אחת לפני ההגשה');

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS count
         FROM signups
        WHERE trip_id = ? AND status IN ('approved', 'pending')
        GROUP BY status`,
    )
    .all(trip.id) as Array<{ status: string; count: number }>;
  const countOf = (status: string) => counts.find((row) => row.status === status)?.count ?? 0;

  // מי שקיבל את משימת השיבוץ ולא הגיש את הרשימה שלו - למידע האופרטיבי בלבד.
  const submitted = new Set(submittedManagerIds(trip.id));
  const leadersNotSubmitted = assignedLeaderIds(trip.id)
    .filter((leaderId) => !submitted.has(leaderId))
    .map((leaderId) => {
      const leader = getUser(db, leaderId);
      return { id: leaderId, fullName: leader ? fullName(leader) : '' };
    });

  tx(() => {
    db.prepare("UPDATE trips SET submitted_at = datetime('now') WHERE id = ?").run(trip.id);
    notifyMany(db, signingManagerIds(trip.id), {
      kind: 'trip_submitted',
      title: `הגלישה ${trip.name} הוגש`,
      body: 'רשימת המשתתפים נסגרה. אי אפשר להוסיף או להסיר אנשים. מי ששובץ עדיין יכול להשלים שותפים ותזונה.',
      link: `/trips/${trip.id}`,
    });
  });

  res.json({
    ok: true,
    trip: serializeTrip(getTripOr404(trip.id), user.id),
    approved: countOf('approved'),
    pending: countOf('pending'),
    leadersNotSubmitted,
  });
});

/** ביטול ההגשה - האופרטיבי פותח מחדש את רשימת המשתתפים. */
tripsRouter.delete('/:id/submit', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.submitted_at == null) throw badRequest('הגלישה אינו מוגש');

  tx(() => {
    db.prepare('UPDATE trips SET submitted_at = NULL WHERE id = ?').run(trip.id);
    notifyMany(db, signingManagerIds(trip.id), {
      kind: 'signing_reopened',
      title: `רשימת המשתתפים בגלישה ${trip.name} נפתחה מחדש`,
      body: 'האופרטיבי ביטל את ההגשה. אפשר להוסיף ולהסיר אנשים שוב.',
      link: `/trips/${trip.id}`,
    });
  });

  res.json({ ok: true, trip: serializeTrip(getTripOr404(trip.id), user.id) });
});

/**
 * מחיקת גלישה - אופרטיבי בלבד.
 * המחיקה מוחקת גם גלישה שיש בו הרשמות: `ON DELETE CASCADE` בסכמה מנקה את
 * הפעימות, ההרשמות, העדפות הלינה, המבנים, החדרים, השיבוצים, בעיות הלינה,
 * שיוכי המפקדים, ההאצלות וההגשות. ההתראות אינן מקושרות לגלישה במפתח זר,
 * ולכן ההתראות שמצביעות אליו נמחקות כאן במפורש - אחרת היו נשארות כקישורים
 * מתים. הספירה מוחזרת ללקוח כדי שיוכל לדווח למשתמש מה נמחק.
 */
tripsRouter.delete('/:id', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));

  const countOf = (sql: string): number => (db.prepare(sql).get(trip.id) as { count: number }).count;

  const deleted = tx(() => {
    const counts = {
      signups: countOf('SELECT COUNT(*) AS count FROM signups WHERE trip_id = ?'),
      cycles: countOf('SELECT COUNT(*) AS count FROM cycles WHERE trip_id = ?'),
      structures: countOf('SELECT COUNT(*) AS count FROM structures WHERE trip_id = ?'),
      notifications: 0,
    };

    const links = [`/trips/${trip.id}`, `/trips/${trip.id}/%`, `/manage/${trip.id}`];
    counts.notifications = Number(
      db.prepare('DELETE FROM notifications WHERE link = ? OR link LIKE ? OR link = ?').run(...links).changes,
    );

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    return counts;
  });

  res.json({ ok: true, deleted });
});

// --- פעימות יציאה ---------------------------------------------------------
// השמות נגזרים מסדר היציאה ולא מוזנים: הפעימה הראשונה היא "חלוץ" ואחריה
// "פעימה 1" וכן הלאה. לכן כל שינוי בסדר או בהרכב מחייב מספור מחדש.

tripsRouter.post('/:id/cycles', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const parsed = cycleSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני הפעימה אינם תקינים');
  const input = parsed.data;

  tx(() => {
    db.prepare('INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, ?, ?)').run(trip.id, '', input.exitDate);
    renumberCycles(trip.id);
  });

  res.status(201).json({ trip: serializeTrip(getTripOr404(trip.id), user.id) });
});

tripsRouter.patch('/:id/cycles/:cycleId', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycle = getCycleOr404(trip.id, idParam.parse(req.params.cycleId));
  const parsed = cycleSchema.partial().safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'נתוני הפעימה אינם תקינים');
  const input = parsed.data;

  const exitDate = input.exitDate ?? cycle.exit_date;

  tx(() => {
    db.prepare('UPDATE cycles SET exit_date = ? WHERE id = ?').run(exitDate, cycle.id);
    // שינוי תאריך יכול להזיז את הפעימה בסדר היציאה, ולכן גם את השמות.
    renumberCycles(trip.id);
  });

  res.json({ trip: serializeTrip(getTripOr404(trip.id), user.id) });
});

tripsRouter.delete('/:id/cycles/:cycleId', requireTO, (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));
  const cycle = getCycleOr404(trip.id, idParam.parse(req.params.cycleId));

  const signups = db.prepare('SELECT COUNT(*) AS count FROM signups WHERE cycle_id = ?').get(cycle.id) as {
    count: number;
  };
  if (signups.count > 0) throw badRequest('אי אפשר למחוק פעימה שיש בה נרשמים');

  tx(() => {
    db.prepare('DELETE FROM cycles WHERE id = ?').run(cycle.id);
    renumberCycles(trip.id);
  });

  res.json({ trip: serializeTrip(getTripOr404(trip.id), user.id) });
});
