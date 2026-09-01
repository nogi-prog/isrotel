import { Router } from 'express';
import { z } from 'zod';
import { db, plain, tx } from '../db/index.ts';
import { attachUser, createToken, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { fullName, getUser, getUserByCompanyId, resolveUnits, toPublicUser } from '../lib/org.ts';
import { notify, notifyMany } from '../lib/notify.ts';
import {
  assertLoginNotLocked,
  clearLoginAttempts,
  generateTempPassword,
  hashPassword,
  passwordStrengthError,
  recordFailedLogin,
  verifyPassword,
} from '../lib/password.ts';
import { MAX_ROOMMATE_PREFERENCES, listRoommateCandidates, saveStandingPreferences } from '../lib/roommates.ts';
import {
  PARENT_ROLES,
  REGISTRABLE_ROLES,
  ROLE_LABEL,
  roleLabels,
  roleOrderSql,
  type PasswordResetRequestRow,
  type Role,
  type UserRow,
} from '../types.ts';

export const authRouter = Router();

const companyIdSchema = z
  .string()
  .trim()
  .regex(/^\d{7}$/, 'מספר אישי חייב להיות בן 7 ספרות');

const passwordSchema = z.string().min(1).max(200);

const registerSchema = z
  .object({
    companyId: companyIdSchema,
    password: passwordSchema,
    confirmPassword: passwordSchema,
    firstName: z.string().trim().min(2, 'שם פרטי חייב להכיל לפחות 2 תווים').max(40),
    lastName: z.string().trim().min(2, 'שם משפחה חייב להכיל לפחות 2 תווים').max(40),
    gender: z.enum(['male', 'female']),
    diet: z.enum(['all', 'vegetarian', 'vegan']),
    managerId: z.number().int().positive().nullish(),
    role: z.enum(REGISTRABLE_ROLES).default('employee'),
    unitName: z.string().trim().min(2).max(60).optional(),
    /** העדפות שותפים לחדר - אינן חובה, וניתנות לעריכה בהמשך במסך הפרופיל. */
    roommatePreferences: z.array(z.number().int().positive()).max(MAX_ROOMMATE_PREFERENCES).optional(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: 'הסיסמאות אינן תואמות',
    path: ['confirmPassword'],
  });

/**
 * האם קיים במערכת משתמש מאושר מאחד הדרגים שיכולים להיות מפקד של הנרשם.
 * כשאין - הנרשם אינו נתקע: הוא נרשם בלי מפקד, כרישום ראש שרשרת שהאופרטיבי
 * מאשר. זה המצב הטבעי בתחילת הדרך (למשל רת״ח שנרשם לפני שיש מפמ״ר).
 */
function hasApprovedParent(parentRoles: readonly Role[]): boolean {
  if (parentRoles.length === 0) return false;
  const placeholders = parentRoles.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT 1 AS ok FROM users WHERE status = 'approved' AND role IN (${placeholders}) LIMIT 1`)
    .get(...parentRoles);
  return row != null;
}

/** ההסבר בעברית לרישום ללא מפקד - ראש שרשרת, או דרג שעדיין אין בו אף אחד. */
function rootRegistrationNote(role: Role, parentRoles: readonly Role[]): string {
  return parentRoles.length === 0
    ? `${ROLE_LABEL[role]} הוא ראש השרשרת הארגונית. הרישום יאושר על ידי האופרטיבי.`
    : `עדיין אין ${roleLabels(parentRoles)} מאושר במערכת, ולכן ${ROLE_LABEL[role]} נרשם ללא מפקד. ` +
      'הרישום יאושר על ידי האופרטיבי.';
}

const loginSchema = z.object({
  companyId: companyIdSchema,
  /** שלב ראשון (בדיקת מספר אישי) שולח בלי סיסמה; שלב שני שולח את שניהם יחד. */
  password: z.string().min(1).max(200).optional(),
});

/**
 * התחברות - מספר אישי וסיסמה נשלחים יחד מאותו טופס (הלקוח לא מחלק את זה
 * לשני מסכים נפרדים). אם המספר האישי אינו רשום - הלקוח מפנה להרשמה. אם
 * רשום אבל בלי סיסמה מוגדרת (חשבון שנוצר לפני הוספת האימות) - מוחזר מצב
 * ייעודי בלי לנסות לאמת כלום, כדי שלא יהיה אפשר להשתלט על חשבון קיים רק
 * בידיעת המספר האישי; הלקוח מציע לבקש איפוס מהאופרטיבי. סיסמה שנשלחת
 * מאומתת מול הגיבוב.
 *
 * הגבלת קצב (lib/password.ts) חוסמת ניחוש בכוח גס אחרי כמה נסיונות כושלים.
 */
authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים');
  const { companyId, password } = parsed.data;

  const user = getUserByCompanyId(db, companyId);
  if (!user) {
    res.json({ registered: false, companyId });
    return;
  }

  const hasPassword = user.password_hash != null;

  if (!hasPassword) {
    // אין סיסמה לאמת מולה - בין אם נשלחה סיסמה ובין אם לא, זה תמיד המצב
    // הזה, לא "סיסמה שגויה". אין נעילת קצב כאן: אין מה לנחש.
    res.json({ registered: true, hasPassword: false });
    return;
  }

  if (password == null) {
    // הסיסמה לא הוקלדה עדיין (למשל בדיקה ראשונית) - לא מנסים לאמת.
    res.json({ registered: true, hasPassword: true });
    return;
  }

  assertLoginNotLocked(companyId);

  if (!verifyPassword(password, user.password_hash)) {
    recordFailedLogin(companyId);
    throw unauthorized('מספר אישי או סיסמה שגויים');
  }

  clearLoginAttempts(companyId);
  res.json({
    registered: true,
    hasPassword: true,
    token: createToken(user),
    user: toPublicUser(db, user),
  });
});

/** הרשמה ראשונית - נשמרת במצב "ממתין לאישור המפקד". */
authRouter.post('/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים', parsed.error.issues);
  }
  const input = parsed.data;

  if (getUserByCompanyId(db, input.companyId)) {
    throw conflict('המספר האישי הזה כבר רשום במערכת');
  }

  const passwordError = passwordStrengthError(input.password, input.companyId);
  if (passwordError) throw badRequest(passwordError);

  // המפקד חייב להיות מאחד הדרגים שמעל התפקיד. מפמ״ר הוא ראש השרשרת ולכן
  // נרשם בלי מפקד, וכך גם מי שהדרג שמעליו עדיין ריק (רישום ראש שרשרת).
  const parentRoles = PARENT_ROLES[input.role];
  let manager: UserRow | null = null;

  if (parentRoles.length === 0) {
    if (input.managerId != null) throw badRequest(`ל${ROLE_LABEL[input.role]} אין מפקד במערכת`);
  } else if (input.managerId == null) {
    if (hasApprovedParent(parentRoles)) {
      throw badRequest(`חובה לבחור מפקד מדרג ${roleLabels(parentRoles)}`);
    }
    // אין עדיין אף מפקד בדרג שמעל - נרשם ללא מפקד, והאופרטיבי מאשר.
  } else {
    manager = getUser(db, input.managerId);
    if (!manager) throw notFound('המפקד שנבחר לא נמצא במערכת');
    if (!parentRoles.includes(manager.role)) {
      throw badRequest(`המפקד של ${ROLE_LABEL[input.role]} חייב להיות ${roleLabels(parentRoles)}`);
    }
    if (manager.status !== 'approved') {
      throw badRequest('המפקד שנבחר עדיין לא אושר במערכת');
    }
  }

  if (input.role !== 'employee' && !input.unitName) {
    throw badRequest('למפקד חובה להזין שם יחידה');
  }

  const user = tx(() => {
    const row = db
      .prepare(
        `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, manager_id, unit_name, password_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         RETURNING *`,
      )
      .get(
        input.companyId,
        input.firstName,
        input.lastName,
        input.gender,
        input.role,
        input.diet,
        manager?.id ?? null,
        input.unitName ?? null,
        hashPassword(input.password),
      );

    const created = plain<UserRow>(row);

    // ההעדפות נשמרות אחרי יצירת המשתמש: בדיקת האילוצים נשענת על המדור שלו,
    // שנגזר מהמפקד שנבחר ולכן קיים רק ברגע שהשורה קיימת.
    if (input.roommatePreferences?.length) {
      saveStandingPreferences(created, input.roommatePreferences);
    }

    const title = 'בקשת רישום חדשה';
    const body = `${fullName(created)} (מספר אישי ${created.company_id}) ממתין לאישור הרישום שלך.`;

    if (manager) {
      notify(db, { userId: manager.id, kind: 'registration_pending', title, body, link: '/approvals' });
    } else {
      // אין מפקד בשרשרת - האופרטיבי מאשר רישום של ראש שרשרת.
      const organizers = (
        db.prepare("SELECT id FROM users WHERE role = 'to' AND status = 'approved'").all() as Array<{ id: number }>
      ).map((entry) => entry.id);
      notifyMany(db, organizers, { kind: 'registration_pending', title, body, link: '/approvals' });
    }
    return created;
  });

  res.status(201).json({ token: createToken(user), user: toPublicUser(db, user) });
});

/** פרטי המשתמש המחובר. */
authRouter.get('/me', attachUser, (req, res) => {
  const user = requireUser(req);
  res.json({ user: toPublicUser(db, user) });
});

/**
 * כניסה מיידית בלי סיסמה, לפאנל "מעבר מהיר" בפיתוח בלבד (DebugBar) - חסום
 * בייצור בדיוק כמו /debug-users. קיים כדי ש-DebugBar יוכל להחליף משתמש
 * בלחיצה אחת גם אחרי שההתחברות הרגילה מחייבת סיסמה.
 */
authRouter.post('/debug-login', (req, res) => {
  if (process.env.NODE_ENV === 'production') throw notFound();

  const parsed = companyIdSchema.safeParse((req.body as { companyId?: unknown } | undefined)?.companyId);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'מספר אישי לא תקין');

  const user = getUserByCompanyId(db, parsed.data);
  if (!user) throw notFound('המשתמש לא נמצא');

  res.json({ token: createToken(user), user: toPublicUser(db, user) });
});

/**
 * שישה משתמשים המקושרים זה לזה בשרשרת פיקוד אחת, למעבר מהיר בפיתוח:
 * חייל -> ר״צ -> רמ״ד -> רת״ח -> מפמ״ר, בתוספת האופרטיבי.
 * לא זמין בייצור.
 */
authRouter.get('/debug-users', (_req, res) => {
  if (process.env.NODE_ENV === 'production') throw notFound();

  const chain = db
    .prepare(
      `SELECT e.company_id   AS employee_cid,
              tl.company_id  AS team_cid,
              sl.company_id  AS sector_cid,
              dl.company_id  AS division_cid,
              ceo.company_id AS ceo_cid
         FROM users e
         JOIN users tl ON tl.id = e.manager_id   AND tl.role = 'team_leader'     AND tl.status = 'approved'
         JOIN users sl ON sl.id = tl.manager_id  AND sl.role = 'sector_leader'   AND sl.status = 'approved'
         JOIN users dl ON dl.id = sl.manager_id  AND dl.role = 'division_leader' AND dl.status = 'approved'
         LEFT JOIN users ceo ON ceo.id = dl.manager_id AND ceo.role = 'ceo'      AND ceo.status = 'approved'
        WHERE e.role = 'employee' AND e.status = 'approved'
        ORDER BY e.id
        LIMIT 1`,
    )
    .get() as
    | { employee_cid: string; team_cid: string; sector_cid: string; division_cid: string; ceo_cid: string | null }
    | undefined;

  const organizer = db
    .prepare("SELECT company_id FROM users WHERE role = 'to' AND status = 'approved' ORDER BY id LIMIT 1")
    .get() as { company_id: string } | undefined;

  // אם הרת״ח בשרשרת אינו כפוף למפמ״ר מאושר (למשל רישום ראש שרשרת) - כל
  // מפמ״ר מאושר עדיין עוזר לבדוק את הממשק שלו, גם בלי קישוריות מלאה.
  const fallbackCeo = chain?.ceo_cid
    ? undefined
    : (db.prepare("SELECT company_id FROM users WHERE role = 'ceo' AND status = 'approved' ORDER BY id LIMIT 1").get() as
        | { company_id: string }
        | undefined);

  const companyIds = [
    chain?.ceo_cid ?? fallbackCeo?.company_id,
    organizer?.company_id,
    chain?.division_cid,
    chain?.sector_cid,
    chain?.team_cid,
    chain?.employee_cid,
  ].filter((value): value is string => value != null);

  if (companyIds.length === 0) {
    res.json({ users: [] });
    return;
  }

  const placeholders = companyIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM users WHERE company_id IN (${placeholders})`)
    .all(...companyIds)
    .map((row) => plain<UserRow>(row));

  // שמירה על סדר ההיררכיה: אופרטיבי, רת״ח, רמ״ד, ר״צ, חייל.
  const byCompanyId = new Map(rows.map((row) => [row.company_id, row]));

  res.json({
    users: companyIds.flatMap((companyId) => {
      const user = byCompanyId.get(companyId);
      if (!user) return [];
      const units = resolveUnits(db, user.id);
      return [
        {
          companyId: user.company_id,
          fullName: fullName(user),
          role: user.role,
          roleLabel: ROLE_LABEL[user.role],
          unitName: user.unit_name ?? units.team?.name ?? units.sector?.name ?? null,
        },
      ];
    }),
  });
});

const managersQuerySchema = z.object({
  role: z.enum(REGISTRABLE_ROLES).default('employee'),
  q: z.string().trim().max(60).optional(),
});

/**
 * רשימת המפקדים האפשריים למי שנרשם בתפקיד `role` - הדרגים שמעליו בלבד
 * (ר״צ, למשל, יכול להיות כפוף לרמ״ד או לאופרטיבי).
 * `q` מסנן בחיפוש חופשי לפי שם או שם יחידה.
 * `rootRegistration` מסמן שהנרשם נרשם בלי מפקד - או שהוא ראש השרשרת
 * (מפמ״ר), או שאין עדיין אף מאושר בדרג שמעליו.
 * זמין ללא התחברות כי נדרש לפני שהמשתמש קיים במערכת.
 */
authRouter.get('/managers', (req, res) => {
  const parsed = managersQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest('תפקיד לא תקין');

  const { role } = parsed.data;
  const parentRoles = PARENT_ROLES[role];

  if (!hasApprovedParent(parentRoles)) {
    res.json({
      managers: [],
      parentRoles: [...parentRoles],
      rootRegistration: true,
      note: rootRegistrationNote(role, parentRoles),
    });
    return;
  }

  const term = parsed.data.q ? `%${parsed.data.q}%` : null;
  const placeholders = parentRoles.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, role, unit_name
         FROM users
        WHERE status = 'approved'
          AND role IN (${placeholders})
          AND (? IS NULL OR first_name || ' ' || last_name LIKE ? OR COALESCE(unit_name, '') LIKE ?)
        ORDER BY ${roleOrderSql('role')}, unit_name, last_name, first_name`,
    )
    .all(...parentRoles, term, term, term) as Array<
    Pick<UserRow, 'id' | 'first_name' | 'last_name' | 'role' | 'unit_name'>
  >;

  res.json({
    parentRoles: [...parentRoles],
    rootRegistration: false,
    managers: rows.map((row) => ({
      id: row.id,
      fullName: `${row.first_name} ${row.last_name}`,
      role: row.role,
      unitName: row.unit_name,
    })),
  });
});

const roommateCandidatesQuerySchema = z.object({
  gender: z.enum(['male', 'female']),
  role: z.enum(REGISTRABLE_ROLES).default('employee'),
});

/**
 * המועמדים לשותפות בחדר עבור מי שנמצא בתהליך הרשמה - אותו מין ואותו דרג
 * ניהולי בדיוק (ראו lib/roommates.ts).
 *
 * זמין ללא התחברות מאותה סיבה כמו /managers - נדרש לפני שהמשתמש קיים.
 * בחירת שותפים אינה חובה, ולכן רשימה ריקה אינה חוסמת את ההרשמה.
 */
authRouter.get('/roommate-candidates', (req, res) => {
  const parsed = roommateCandidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest('הנתונים לבחירת שותפים אינם תקינים');
  const { gender, role } = parsed.data;

  // id=0 מבטיח שאף אחד לא יסונן כ"עצמי" - הנרשם עדיין אינו קיים במערכת.
  res.json({
    max: MAX_ROOMMATE_PREFERENCES,
    candidates: listRoommateCandidates({ id: 0, gender, role }),
  });
});

const forgotPasswordSchema = z.object({ companyId: companyIdSchema });

/**
 * "שכחתי סיסמה" - הבקשה ממתינה לאופרטיבי, לא למפקד הישיר: זו סמכות ניהול
 * מערכת. התשובה זהה בין מספר אישי קיים ללא קיים, כדי לא לחשוף אילו מספרים
 * אישיים רשומים במערכת (user enumeration). זמין ללא התחברות - זו כל הנקודה.
 */
authRouter.post('/forgot-password', (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest('מספר אישי לא תקין');
  const { companyId } = parsed.data;

  const user = getUserByCompanyId(db, companyId);
  if (user) {
    tx(() => {
      // בקשה ממתינה אחת בלבד לכל משתמש - אילוץ ייחודי חלקי במסד. אם כבר
      // יש בקשה ממתינה, לא יוצרים כפולה ולא שולחים התראה נוספת.
      const existing = db
        .prepare("SELECT 1 AS ok FROM password_reset_requests WHERE user_id = ? AND status = 'pending'")
        .get(user.id);
      if (existing) return;

      db.prepare('INSERT INTO password_reset_requests (user_id) VALUES (?)').run(user.id);

      const organizers = (
        db.prepare("SELECT id FROM users WHERE role = 'to' AND status = 'approved'").all() as Array<{ id: number }>
      ).map((entry) => entry.id);
      notifyMany(db, organizers, {
        kind: 'password_reset_requested',
        title: 'בקשת איפוס סיסמה',
        body: `${fullName(user)} (מספר אישי ${user.company_id}) שכח/ה את הסיסמה ומבקש/ת איפוס.`,
        link: '/password-resets',
      });
    });
  }

  res.json({ ok: true, message: 'אם המספר האישי קיים במערכת, בקשת האיפוס נשלחה לאופרטיבי.' });
});

interface PasswordResetView {
  id: number;
  user: { id: number; fullName: string; companyId: string; role: Role; unitName: string | null };
  requestedAt: string;
}

/** רשימת בקשות איפוס סיסמה שממתינות - לאופרטיבי בלבד. */
authRouter.get('/password-resets', attachUser, requireAuth, requireTO, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT pr.id, pr.requested_at, u.id AS user_id, u.first_name, u.last_name, u.company_id, u.role, u.unit_name
         FROM password_reset_requests pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.status = 'pending'
        ORDER BY pr.requested_at`,
    )
    .all() as Array<{
    id: number;
    requested_at: string;
    user_id: number;
    first_name: string;
    last_name: string;
    company_id: string;
    role: Role;
    unit_name: string | null;
  }>;

  const requests: PasswordResetView[] = rows.map((row) => ({
    id: row.id,
    requestedAt: row.requested_at,
    user: {
      id: row.user_id,
      fullName: `${row.first_name} ${row.last_name}`,
      companyId: row.company_id,
      role: row.role,
      unitName: row.unit_name,
    },
  }));

  res.json({ requests });
});

function getPendingPasswordReset(id: number): PasswordResetRequestRow {
  const row = db.prepare("SELECT * FROM password_reset_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!row) throw notFound('בקשת האיפוס לא נמצאה, או שכבר טופלה');
  return plain<PasswordResetRequestRow>(row);
}

/**
 * מאשר את בקשת האיפוס ומייצר סיסמה זמנית. הסיסמה מוחזרת פעם אחת בתשובה
 * הזאת בלבד - לא נשמרת בשום מקום בטקסט גלוי, גם לא בהתראה למשתמש. על
 * האופרטיבי להעביר אותה למשתמש מחוץ למערכת (בעל פה / פנים אל פנים).
 * המשתמש חייב להחליף אותה לסיסמה קבועה מיד עם הכניסה (must_change_password).
 */
authRouter.post('/password-resets/:id/resolve', attachUser, requireAuth, requireTO, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('מזהה בקשה לא תקין');
  const admin = requireUser(req);

  const request = getPendingPasswordReset(id);
  const user = getUser(db, request.user_id);
  if (!user) throw notFound('המשתמש לא נמצא');

  const tempPassword = generateTempPassword();

  tx(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
      hashPassword(tempPassword),
      user.id,
    );
    db.prepare(
      "UPDATE password_reset_requests SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
    ).run(admin.id, request.id);
    notify(db, {
      userId: user.id,
      kind: 'password_reset_resolved',
      title: 'הסיסמה שלך אופסה',
      body: 'האופרטיבי אישר את בקשת האיפוס והגדיר סיסמה זמנית. פנה/י אליו כדי לקבל אותה.',
      link: '/',
    });
  });

  clearLoginAttempts(user.company_id);

  res.json({ ok: true, tempPassword, user: { id: user.id, fullName: fullName(user), companyId: user.company_id } });
});

/** דוחה בקשת איפוס בלי לאפס - למשל בקשה חשודה או כפולה. */
authRouter.post('/password-resets/:id/dismiss', attachUser, requireAuth, requireTO, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('מזהה בקשה לא תקין');
  const admin = requireUser(req);

  const request = getPendingPasswordReset(id);
  db.prepare(
    "UPDATE password_reset_requests SET status = 'dismissed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
  ).run(admin.id, request.id);

  res.json({ ok: true });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: passwordSchema,
});

/**
 * החלפת סיסמה עצמית, ממסך הפרופיל - כל עובד יכול. אם כבר מוגדרת סיסמה
 * (המקרה הרגיל), חובה לאמת אותה עם currentPassword. currentPassword יכול
 * להישמט רק כשעדיין אין סיסמה בכלל (חשבון מלפני הוספת האימות, שעדיין
 * מחזיק טוקן ישן תקף) - זה גם המסך שמשלים את הצעד החובה אחרי איפוס
 * (must_change_password), ושם currentPassword היא הסיסמה הזמנית שהתקבלה.
 */
authRouter.patch('/password', attachUser, requireAuth, (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'הנתונים שהוזנו אינם תקינים');
  const { currentPassword, newPassword } = parsed.data;
  const user = requireUser(req);

  if (user.password_hash != null) {
    if (!currentPassword || !verifyPassword(currentPassword, user.password_hash)) {
      throw forbidden('הסיסמה הנוכחית שגויה');
    }
  }

  const passwordError = passwordStrengthError(newPassword, user.company_id);
  if (passwordError) throw badRequest(passwordError);

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
    hashPassword(newPassword),
    user.id,
  );

  res.json({ ok: true, user: toPublicUser(db, getUser(db, user.id)!) });
});
