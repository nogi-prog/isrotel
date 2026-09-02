/**
 * טסט אינטגרציה מקצה לקצה על ה־API, מול מסד נתונים בזיכרון.
 * מכסה את כל תרחישי השימוש: הרשמה ואישור, יצירת גלישה ופעימות,
 * הרשמה לגלישה עם העדפות לינה, אישור מפקד, ונעילת שיבוצי אוטובוסים ולינה.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

// ה־import חייב להיות דינמי, כדי שמשתני הסביבה יוגדרו לפני פתיחת המסד.
const { app } = await import('./main.ts');
const { db } = await import('./db/index.ts');
const { loadCycleParticipants } = await import('./lib/trips.ts');

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

/** יוצר משתמש מאושר ישירות במסד - קיצור דרך להכנת נתוני הטסט. */
function seedUser(fields: {
  companyId: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female';
  role: 'employee' | 'team_leader' | 'sector_leader' | 'division_leader' | 'to' | 'ceo';
  diet?: 'all' | 'vegetarian' | 'vegan';
  managerId?: number | null;
  unitName?: string | null;
  /** ברירת המחדל תואמת את הטלפון שנשלח ב-body של טסטי /me/profile-edit, כדי שהשוואת "לא השתנה" תעבוד. */
  phone?: string | null;
}): number {
  const row = db
    .prepare(
      `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, manager_id, unit_name, phone, status, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now')) RETURNING id`,
    )
    .get(
      fields.companyId,
      fields.firstName,
      fields.lastName,
      fields.gender,
      fields.role,
      fields.diet ?? 'all',
      fields.managerId ?? null,
      fields.unitName ?? null,
      fields.phone === undefined ? '0501234567' : fields.phone,
    ) as { id: number };
  return row.id;
}

/**
 * מתחבר בלי סיסמה, דרך אותה נקודת קצה שמשמשת את פאנל "מעבר מהיר" בפיתוח
 * (`/auth/debug-login`, חסומה רק בייצור). רוב הטסטים כאן לא עוסקים באימות
 * עצמו - לכן קיצור הדרך הזה, במקום להזין סיסמה בכל אחד מהם.
 */
async function login(companyId: string): Promise<string> {
  const response = await api('POST', '/api/auth/debug-login', { body: { companyId } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token as string;
}

/**
 * אישור האופרטיבי לכל מי שהמפקדים כבר אישרו בגלישה, בכל הפעימות - שכבה
 * נוספת מעל אישור המפקד (ראו POST .../to-approve-all). רוב הטסטים כאן לא
 * עוסקים באישור הזה עצמו, ולכן קיצור הדרך הזה לפני נעילת שיבוצים/דוח מזון.
 */
async function toApproveTrip(tripId: number, toToken: string): Promise<void> {
  const trip = await api('GET', `/api/trips/${tripId}`, { token: toToken });
  assert.equal(trip.status, 200, JSON.stringify(trip.body));
  for (const cycle of trip.body.trip.cycles) {
    const response = await api('POST', `/api/trips/${tripId}/cycles/${cycle.id}/to-approve-all`, { token: toToken });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
}

describe('API מקצה לקצה', () => {
  // מבנה ארגוני: רת״ח -> רמ״ד -> ר״צ -> חיילים
  // ובמקביל: אופרטיבי -> ר״צ -> חיילים, כי לאופרטיבי מדור משלו.
  let toId = 0;
  let divisionId = 0;
  let sectorId = 0;
  let teamLeaderId = 0;
  const soldierIds: number[] = [];
  // המדור של האופרטיבי - ר״צ וחיילים שכפופים לו.
  let toTeamLeaderId = 0;
  const toSoldierIds: number[] = [];
  let tripId = 0;
  let cycleId = 0;
  // המפמ״ר נוצר בתוך הטסטים ולא ב-before, כי הטסטים שלפניו בודקים דווקא את
  // המצב שבו אין מפמ״ר מאושר (הרישום כראש שרשרת).
  let ceoId = 0;
  // אנשים שאושרו אחרי שהרמ״ד הגיש את הרשימה - התוספות המאוחרות.
  let lateUserId = 0;
  let blockedUserId = 0;

  before(() => {
    toId = seedUser({
      companyId: '1000001',
      firstName: 'שירה',
      lastName: 'אופיר',
      gender: 'female',
      role: 'to',
      unitName: 'מדור אופרטיבי',
    });
    divisionId = seedUser({
      companyId: '1000002',
      firstName: 'אבי',
      lastName: 'שגב',
      gender: 'male',
      role: 'division_leader',
      unitName: 'תחום פיתוח',
    });
    sectorId = seedUser({
      companyId: '1000003',
      firstName: 'דנה',
      lastName: 'לוי',
      gender: 'female',
      role: 'sector_leader',
      unitName: 'מדור תוכנה',
      managerId: divisionId,
    });
    teamLeaderId = seedUser({
      companyId: '1000004',
      firstName: 'עומר',
      lastName: 'כהן',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות אלון',
      managerId: sectorId,
    });

    // ארבעה חיילים בנים ושתי חיילות, כולם באותו צוות.
    const soldiers: Array<[string, string, 'male' | 'female']> = [
      ['יונתן', 'ברק', 'male'],
      ['איתי', 'דהן', 'male'],
      ['נועם', 'פרץ', 'male'],
      ['אורי', 'גולן', 'male'],
      ['מאיה', 'חדד', 'female'],
      ['שירה', 'אזולאי', 'female'],
    ];
    soldiers.forEach(([firstName, lastName, gender], index) => {
      soldierIds.push(
        seedUser({
          companyId: `200000${index + 1}`,
          firstName,
          lastName,
          gender,
          role: 'employee',
          diet: index === 0 ? 'vegan' : index === 1 ? 'vegetarian' : 'all',
          managerId: teamLeaderId,
        }),
      );
    });

    // המדור של האופרטיבי: ר״צ ושני חיילים תחתיו. האופרטיבי מחזיק עמדת רמ״ד
    // בשרשרת הפיקוד, ולכן המדור של החיילים האלה הוא האופרטיבי עצמו.
    toTeamLeaderId = seedUser({
      companyId: '1000006',
      firstName: 'עומר',
      lastName: 'רגב',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות מבצעים',
      managerId: toId,
    });
    const toSoldiers: Array<[string, string, 'male' | 'female']> = [
      ['אלון', 'ויצמן', 'male'],
      ['הדר', 'זילבר', 'female'],
    ];
    toSoldiers.forEach(([firstName, lastName, gender], index) => {
      toSoldierIds.push(
        seedUser({
          companyId: `210000${index + 1}`,
          firstName,
          lastName,
          gender,
          role: 'employee',
          managerId: toTeamLeaderId,
        }),
      );
    });
  });

  test('מספר אישי לא מוכר מסומן כלא רשום', async () => {
    const response = await api('POST', '/api/auth/login', { body: { companyId: '9999999' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.registered, false);
  });

  test('מספר אישי לא תקין נדחה', async () => {
    const response = await api('POST', '/api/auth/login', { body: { companyId: '123' } });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /7 ספרות/);
  });

  test('הרשמה ראשונה נשמרת כממתינה לאישור המפקד, והמפקד מאשר אותה', async () => {
    const registration = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3000001',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'רועי',
        lastName: 'מזרחי',
        gender: 'male',
        diet: 'vegetarian',
        managerId: teamLeaderId,
        role: 'employee',
      },
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(registration.body.user.status, 'pending');
    const newUserToken = registration.body.token as string;
    const newUserId = registration.body.user.id as number;

    // כל עוד הרישום לא אושר - אין גישה לגלישות.
    const blocked = await api('GET', '/api/trips', { token: newUserToken });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /ממתין לאישור/);

    // המפקד רואה את הבקשה ומאשר אותה.
    const leaderToken = await login('1000004');
    const pending = await api('GET', '/api/users/pending', { token: leaderToken });
    assert.equal(pending.status, 200);
    assert.ok(pending.body.pending.some((entry: any) => entry.id === newUserId));

    const approval = await api('POST', `/api/users/${newUserId}/approve`, { token: leaderToken });
    assert.equal(approval.status, 200);
    assert.equal(approval.body.user.status, 'approved');

    const allowed = await api('GET', '/api/trips', { token: newUserToken });
    assert.equal(allowed.status, 200);
  });

  test('האופרטיבי רואה ומאשר רישום גם מחוץ למדור שלו, ורואה את כל עץ החברה', async () => {
    // רועי כפוף לר״צ צוות אלון - מחוץ למדור האופרטיבי לגמרי.
    const registration = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3000005',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'גיא',
        lastName: 'אבידן',
        gender: 'male',
        diet: 'all',
        managerId: teamLeaderId,
        role: 'employee',
      },
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    const newUserId = registration.body.user.id as number;

    const toToken = await login('1000001');
    const pending = await api('GET', '/api/users/pending', { token: toToken });
    assert.equal(pending.status, 200);
    assert.ok(
      pending.body.pending.some((entry: any) => entry.id === newUserId),
      'האופרטיבי לא רואה רישום ממתין מחוץ למדור שלו',
    );

    const approval = await api('POST', `/api/users/${newUserId}/approve`, { token: toToken });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(approval.body.user.status, 'approved');

    // עץ החברה המלא: כל מי שנרשם, לא רק המדור של האופרטיבי.
    const team = await api('GET', '/api/users/my-team', { token: toToken });
    assert.equal(team.status, 200);
    const teamIds = new Set(team.body.team.map((entry: any) => entry.id));
    assert.ok(teamIds.has(divisionId), 'הרת״ח לא מופיע בעץ של האופרטיבי');
    assert.ok(teamIds.has(teamLeaderId), 'הר״צ (מחוץ למדור האופרטיבי) לא מופיע בעץ של האופרטיבי');
    assert.ok(teamIds.has(newUserId), 'המשתמש שאושר עכשיו לא מופיע בעץ של האופרטיבי');
    assert.ok(!teamIds.has(toId), 'האופרטיבי לא אמור להופיע ברשימת עצמו');
  });

  test('בקשת עדכון פרופיל ממתינה לאישור המפקד, ורק אז משנה את המשתמש', async () => {
    const soldierToken = await login('2000001');
    const teamLeaderToken = await login('1000004');
    const outsiderToken = await login('1000006'); // ר״צ מדור האופרטיבי - לא בשרשרת של החייל הזה

    const submitted = await api('POST', '/api/users/me/profile-edit', {
      token: soldierToken,
      body: { phone: '0501234567', firstName: 'יונתן-חדש', lastName: 'ברק', gender: 'male', diet: 'vegetarian' },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.pending.proposed.firstName, 'יונתן-חדש');
    assert.equal(submitted.body.pending.current.firstName, 'יונתן');
    const editId = submitted.body.pending.id as number;

    // עדיין לא הוחל - המשתמש עצמו רואה את הערכים הישנים.
    const meBefore = await api('GET', '/api/auth/me', { token: soldierToken });
    assert.equal(meBefore.body.user.firstName, 'יונתן');

    // מי שאינו בשרשרת הפיקוד שלו לא יכול לאשר.
    const deniedApproval = await api('POST', `/api/users/profile-edits/${editId}/approve`, {
      token: outsiderToken,
    });
    assert.equal(deniedApproval.status, 403);

    // המפקד הישיר רואה את הבקשה ומאשר אותה.
    const pendingForManager = await api('GET', '/api/users/profile-edits/pending', { token: teamLeaderToken });
    assert.equal(pendingForManager.status, 200);
    assert.ok(pendingForManager.body.pending.some((entry: any) => entry.id === editId));

    const approved = await api('POST', `/api/users/profile-edits/${editId}/approve`, { token: teamLeaderToken });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.user.firstName, 'יונתן-חדש');
    assert.equal(approved.body.user.diet, 'vegetarian');

    const meAfter = await api('GET', '/api/auth/me', { token: soldierToken });
    assert.equal(meAfter.body.user.firstName, 'יונתן-חדש');

    // הבקשה כבר טופלה - אישור נוסף נדחה.
    const doubleApprove = await api('POST', `/api/users/profile-edits/${editId}/approve`, {
      token: teamLeaderToken,
    });
    assert.equal(doubleApprove.status, 400);
  });

  test('למפקד חובה שם יחידה בעדכון פרופיל, וחזרה לערכים המקוריים מבטלת בקשה ממתינה', async () => {
    const teamLeaderToken = await login('1000004');

    const missingUnit = await api('POST', '/api/users/me/profile-edit', {
      token: teamLeaderToken,
      body: { phone: '0501234567', firstName: 'עומר', lastName: 'כהן', gender: 'male', diet: 'all' },
    });
    assert.equal(missingUnit.status, 400);
    assert.match(missingUnit.body.error, /שם יחידה/);

    const submitted = await api('POST', '/api/users/me/profile-edit', {
      token: teamLeaderToken,
      body: { phone: '0501234567', firstName: 'עומר', lastName: 'כהן-שינוי', gender: 'male', diet: 'all', unitName: 'צוות אלון' },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.ok(submitted.body.pending);

    // חזרה לערכים המקוריים - הבקשה נעלמת בלי לחכות לאישור.
    const reverted = await api('POST', '/api/users/me/profile-edit', {
      token: teamLeaderToken,
      body: { phone: '0501234567', firstName: 'עומר', lastName: 'כהן', gender: 'male', diet: 'all', unitName: 'צוות אלון' },
    });
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.pending, null);

    const check = await api('GET', '/api/users/me/profile-edit', { token: teamLeaderToken });
    assert.equal(check.body.pending, null);
  });

  test('משתמש יכול לבטל בקשת עדכון פרופיל ממתינה', async () => {
    const soldierToken = await login('2000002');

    const submitted = await api('POST', '/api/users/me/profile-edit', {
      token: soldierToken,
      body: { phone: '0501234567', firstName: 'איתי-זמני', lastName: 'דהן', gender: 'male', diet: 'vegetarian' },
    });
    assert.equal(submitted.status, 200);
    assert.ok(submitted.body.pending);

    const withdrawn = await api('DELETE', '/api/users/me/profile-edit', { token: soldierToken });
    assert.equal(withdrawn.status, 200);

    const check = await api('GET', '/api/users/me/profile-edit', { token: soldierToken });
    assert.equal(check.body.pending, null);

    const secondWithdraw = await api('DELETE', '/api/users/me/profile-edit', { token: soldierToken });
    assert.equal(secondWithdraw.status, 404);
  });

  test('שרשרת הפיקוד של המשתמש מלמטה למעלה, ועד ראש השרשרת', async () => {
    const soldierToken = await login('2000001');
    const response = await api('GET', '/api/users/me/hierarchy', { token: soldierToken });
    assert.equal(response.status, 200);

    const roles = response.body.chain.map((entry: any) => entry.role);
    assert.deepEqual(roles, ['employee', 'team_leader', 'sector_leader', 'division_leader']);

    const ids = response.body.chain.map((entry: any) => entry.id);
    assert.deepEqual(ids, [soldierIds[0], teamLeaderId, sectorId, divisionId]);
  });

  test('מפקד עורך ישירות את הפרטים של כפיף, בלי צורך באישור - וזה מבטל בקשה ממתינה שלו', async () => {
    const soldierToken = await login('2000003');
    const teamLeaderToken = await login('1000004');
    const outsiderToken = await login('1000006');
    const soldierId = soldierIds[2];

    // החייל מגיש בקשת עדכון עצמאית לפני שהמפקד עורך ישירות.
    const ownRequest = await api('POST', '/api/users/me/profile-edit', {
      token: soldierToken,
      body: { phone: '0501234567', firstName: 'נועם', lastName: 'פרץ', gender: 'male', diet: 'vegan' },
    });
    assert.equal(ownRequest.status, 200);
    assert.ok(ownRequest.body.pending);

    // מי שאינו בשרשרת הפיקוד לא יכול לערוך ישירות.
    const denied = await api('PATCH', `/api/users/${soldierId}/profile`, {
      token: outsiderToken,
      body: { phone: '0501234567', firstName: 'נועם', lastName: 'פרץ-חדש', gender: 'male', diet: 'all' },
    });
    assert.equal(denied.status, 403);

    // המפקד עורך ישירות - חל מיד, בלי אישור נוסף.
    const edited = await api('PATCH', `/api/users/${soldierId}/profile`, {
      token: teamLeaderToken,
      body: { phone: '0501234567', firstName: 'נועם', lastName: 'פרץ-חדש', gender: 'male', diet: 'all' },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.user.lastName, 'פרץ-חדש');
    assert.equal(edited.body.user.diet, 'all');

    // הבקשה העצמאית הישנה של החייל בוטלה - הוחלפה על ידי העריכה הישירה.
    const check = await api('GET', '/api/users/me/profile-edit', { token: soldierToken });
    assert.equal(check.body.pending, null);

    // מפקד אינו יכול לערוך את עצמו דרך הנתיב הזה - זה עובר דרך /me/profile-edit.
    const selfEdit = await api('PATCH', `/api/users/${teamLeaderId}/profile`, {
      token: teamLeaderToken,
      body: { phone: '0501234567', firstName: 'עומר', lastName: 'כהן', gender: 'male', diet: 'all', unitName: 'צוות אלון' },
    });
    assert.equal(selfEdit.status, 400);

    // מנהל שעורך אדם שהוא מפקד חייב שם יחידה.
    const divisionToken = await login('1000002');
    const missingUnit = await api('PATCH', `/api/users/${sectorId}/profile`, {
      token: divisionToken,
      body: { phone: '0501234567', firstName: 'דנה', lastName: 'לוי', gender: 'female', diet: 'all' },
    });
    assert.equal(missingUnit.status, 400);
    assert.match(missingUnit.body.error, /שם יחידה/);
  });

  test('העדפות שותפים קבועות: נשמרות, נקראות, ואילוצי המין והדרגה נאכפים', async () => {
    const soldierToken = await login('2000001'); // יונתן ברק, חייל בן בצוות אלון

    const initial = await api('GET', '/api/users/me/roommate-preferences', { token: soldierToken });
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.deepEqual(initial.body.preferences, [], 'ההעדפות מתחילות ריקות - הבחירה אינה חובה');

    // המועמדים לחייל: חיילים בנים בלבד (בלי הגבלת מדור).
    const candidateIds = initial.body.candidates.map((entry: any) => entry.id);
    assert.ok(candidateIds.includes(soldierIds[1]), 'חייל בן חסר מרשימת המועמדים');
    assert.ok(!candidateIds.includes(soldierIds[4]), 'חיילת מופיעה כמועמדת לחייל בן');
    assert.ok(!candidateIds.includes(teamLeaderId), 'מפקד מופיע כמועמד לחייל');
    assert.ok(!candidateIds.includes(soldierIds[0]), 'המשתמש עצמו מופיע ברשימת המועמדים שלו');

    const saved = await api('PUT', '/api/users/me/roommate-preferences', {
      token: soldierToken,
      body: { preferences: [soldierIds[1], soldierIds[2]] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(
      saved.body.preferences.map((entry: any) => entry.id),
      [soldierIds[1], soldierIds[2]],
      'ההעדפות נשמרות לפי סדר העדיפות שנבחר',
    );

    const reread = await api('GET', '/api/users/me/roommate-preferences', { token: soldierToken });
    assert.deepEqual(
      reread.body.preferences.map((entry: any) => entry.id),
      [soldierIds[1], soldierIds[2]],
    );

    // בן ובת אינם ישנים באותו חדר.
    const crossGender = await api('PUT', '/api/users/me/roommate-preferences', {
      token: soldierToken,
      body: { preferences: [soldierIds[4]] },
    });
    assert.equal(crossGender.status, 400);
    assert.match(crossGender.body.error, /בנים|בנות/);

    // חייל ומפקד אינם ישנים באותו חדר.
    const crossRank = await api('PUT', '/api/users/me/roommate-preferences', {
      token: soldierToken,
      body: { preferences: [teamLeaderId] },
    });
    assert.equal(crossRank.status, 400);
    assert.match(crossRank.body.error, /חיילים|מפקדים/);

    // ר״צ ורת״ח (שניהם בנים) אינם ישנים באותו חדר - כל דרג ניהולי רק עם עצמו,
    // לא כל המפקדים ביחד.
    const teamLeaderToken = await login('1000004');
    const crossManagerLevel = await api('PUT', '/api/users/me/roommate-preferences', {
      token: teamLeaderToken,
      body: { preferences: [divisionId] },
    });
    assert.equal(crossManagerLevel.status, 400);
    assert.match(crossManagerLevel.body.error, /דרג ניהולי/);
    // מנקה - הטסט הבא (העדפות הפרופיל...) מסתמך על ר״צ בלי העדפות שמורות.
    await api('PUT', '/api/users/me/roommate-preferences', { token: teamLeaderToken, body: { preferences: [] } });

    // בקשה שנדחתה לא שינתה את מה שכבר נשמר.
    const afterRejected = await api('GET', '/api/users/me/roommate-preferences', { token: soldierToken });
    assert.deepEqual(
      afterRejected.body.preferences.map((entry: any) => entry.id),
      [soldierIds[1], soldierIds[2]],
      'בקשה שנדחתה מחקה את ההעדפות הקיימות',
    );

    // אותו אדם פעמיים נדחה.
    const duplicate = await api('PUT', '/api/users/me/roommate-preferences', {
      token: soldierToken,
      body: { preferences: [soldierIds[1], soldierIds[1]] },
    });
    assert.equal(duplicate.status, 400);

    // רשימה ריקה מנקה - ההעדפות אינן חובה.
    const cleared = await api('PUT', '/api/users/me/roommate-preferences', {
      token: soldierToken,
      body: { preferences: [] },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.preferences, []);
  });

  test('נרשם חדש יכול לבחור שותפים בהרשמה, והבחירה נשמרת לפרופיל שלו', async () => {
    // רשימת המועמדים זמינה בלי התחברות - הנרשם עדיין אינו קיים במערכת. אינה
    // תלויה במפקד שנבחר - רק במין ובתפקיד (דרג ניהולי מדויק).
    const candidates = await api('GET', '/api/auth/roommate-candidates?gender=male&role=employee');
    assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
    const ids = candidates.body.candidates.map((entry: any) => entry.id);
    assert.ok(ids.includes(soldierIds[1]), 'חייל בן חסר מרשימת המועמדים בהרשמה');
    assert.ok(!ids.includes(soldierIds[4]), 'חיילת מוצעת לנרשם בן');

    const registered = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '2000090',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'אביב',
        lastName: 'שרון',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: teamLeaderId,
        roommatePreferences: [soldierIds[1]],
      },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const newUserId = registered.body.user.id;

    // עד לאישור המפקד אין גישה לשאר המערכת, ולכן קודם מאשרים.
    const leaderToken = await login('1000004');
    const approved = await api('POST', `/api/users/${newUserId}/approve`, { token: leaderToken });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const newUserToken = await login('2000090');
    const preferences = await api('GET', '/api/users/me/roommate-preferences', { token: newUserToken });
    assert.deepEqual(
      preferences.body.preferences.map((entry: any) => entry.id),
      [soldierIds[1]],
      'הבחירה שנעשתה בהרשמה לא נשמרה',
    );

    // הרשמה עם שותף שאינו חוקי נדחית, ולא נוצר משתמש חלקי.
    const invalid = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '2000091',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'רון',
        lastName: 'שגב',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: teamLeaderId,
        roommatePreferences: [soldierIds[4]], // חיילת
      },
    });
    assert.equal(invalid.status, 400);
    const orphan = await api('POST', '/api/auth/login', { body: { companyId: '2000091' } });
    assert.equal(orphan.body.registered, false, 'נוצר משתמש למרות שההרשמה נדחתה');
  });

  test('פאנל הפיתוח מחזיר שישה משתמשים המקושרים בשרשרת פיקוד אחת, כולל מפמ״ר', async () => {
    // בשלב הזה של הטסטים עוד אין מפמ״ר מאושר (ceoId נוצר בהמשך הקובץ בכוונה -
    // ראו ההערה עליו למעלה). יוצרים אחד זמני ומחברים אותו לרת״ח כדי לבדוק
    // שהפאנל מוצא ומציג אותו, ומשחזרים את המצב בסוף כדי לא להשפיע על טסטים
    // מאוחרים יותר שבודקים דווקא את המצב שאין מפמ״ר.
    const tempCeoId = seedUser({
      companyId: '4900001',
      firstName: 'זמני',
      lastName: 'מפמ״רבדיקה',
      gender: 'male',
      role: 'ceo',
    });
    db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(tempCeoId, divisionId);

    try {
      const response = await api('GET', '/api/auth/debug-users');
      assert.equal(response.status, 200);

      const roles = response.body.users.map((entry: any) => entry.role);
      assert.deepEqual(roles, ['to', 'ceo', 'division_leader', 'sector_leader', 'team_leader', 'employee']);

      // הקישוריות היא הדרישה המרכזית: כל אחד כפוף בפועל לזה שמעליו ברשימה
      // (מלבד האופרטיבי, שאינו חלק משרשרת הפיקוד הרגילה).
      const byCompanyId = new Map(
        response.body.users.map((entry: any) => [
          entry.companyId,
          db.prepare('SELECT id, manager_id FROM users WHERE company_id = ?').get(entry.companyId) as {
            id: number;
            manager_id: number | null;
          },
        ]),
      );
      const [, ceo, division, sector, team, employee] = response.body.users.map((entry: any) =>
        byCompanyId.get(entry.companyId),
      );

      assert.equal(employee.manager_id, team.id, 'החייל אינו כפוף לר״צ ברשימה');
      assert.equal(team.manager_id, sector.id, 'הר״צ אינו כפוף לרמ״ד ברשימה');
      assert.equal(sector.manager_id, division.id, 'הרמ״ד אינו כפוף לרת״ח ברשימה');
      assert.equal(division.manager_id, ceo.id, 'הרת״ח אינו כפוף למפמ״ר ברשימה');

      // כל מספר אישי ברשימה חייב להיות בר-התחברות, אחרת הפאנל לא ישמש לכלום.
      for (const entry of response.body.users) {
        const login = await api('POST', '/api/auth/login', { body: { companyId: entry.companyId } });
        assert.equal(login.body.registered, true, `${entry.companyId} אינו בר-התחברות`);
      }
    } finally {
      db.prepare('UPDATE users SET manager_id = NULL WHERE id = ?').run(divisionId);
      db.prepare('DELETE FROM users WHERE id = ?').run(tempCeoId);
    }
  });

  test('רשימת המפקדים כוללת רק את הדרגים שמעל התפקיד', async () => {
    const forEmployee = await api('GET', '/api/auth/managers?role=employee');
    assert.equal(forEmployee.status, 200);
    assert.deepEqual(forEmployee.body.parentRoles, ['team_leader', 'sector_leader', 'to', 'division_leader', 'ceo']);
    assert.equal(forEmployee.body.rootRegistration, false);
    assert.ok(forEmployee.body.managers.length > 0);
    assert.ok(
      forEmployee.body.managers.every((manager: any) =>
        ['team_leader', 'sector_leader', 'to', 'division_leader', 'ceo'].includes(manager.role),
      ),
      'הרשימה לחייל מכילה תפקיד שאינו מפקד',
    );

    // ר״צ יכול להיות כפוף לרמ״ד או לאופרטיבי - לאופרטיבי מדור משלו.
    const forTeamLeader = await api('GET', '/api/auth/managers?role=team_leader');
    assert.deepEqual(forTeamLeader.body.parentRoles, ['sector_leader', 'to']);
    assert.ok(
      forTeamLeader.body.managers.every((manager: any) => ['sector_leader', 'to'].includes(manager.role)),
    );
    assert.ok(
      forTeamLeader.body.managers.some((manager: any) => manager.role === 'to'),
      'האופרטיבי לא הוצע כמפקד של ר״צ',
    );

    const forSectorLeader = await api('GET', '/api/auth/managers?role=sector_leader');
    assert.deepEqual(forSectorLeader.body.parentRoles, ['division_leader']);
    assert.ok(forSectorLeader.body.managers.every((manager: any) => manager.role === 'division_leader'));

    // מפמ״ר הוא ראש השרשרת - אין דרג מעליו.
    const forCeo = await api('GET', '/api/auth/managers?role=ceo');
    assert.deepEqual(forCeo.body.parentRoles, []);
    assert.equal(forCeo.body.rootRegistration, true);
    assert.deepEqual(forCeo.body.managers, []);
    assert.match(forCeo.body.note, /ראש השרשרת/);
    assert.match(forCeo.body.note, /אופרטיבי/);

    // האופרטיבי אינו מוצע כמפקד לרמ״ד - הוא עצמו שקול לרמ״ד, לא מעליו.
    const forSectorAgain = await api('GET', '/api/auth/managers?role=sector_leader');
    assert.ok(
      !forSectorAgain.body.managers.some((manager: any) => manager.role === 'to'),
      'האופרטיבי הוצע כמפקד עבור sector_leader',
    );
  });

  test('כשאין מפמ״ר מאושר, רת״ח נרשם ללא מפקד כרישום ראש שרשרת', async () => {
    // מצב הפתיחה של המערכת: אין מפמ״ר, ולכן הרת״ח לא נתקע בלי מפקד לבחור.
    const ceoCount = (
      db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ceo' AND status = 'approved'").get() as {
        count: number;
      }
    ).count;
    assert.equal(ceoCount, 0, 'הטסט הזה מניח שאין עדיין מפמ״ר מאושר');

    const forDivisionLeader = await api('GET', '/api/auth/managers?role=division_leader');
    assert.deepEqual(forDivisionLeader.body.parentRoles, ['ceo']);
    assert.equal(forDivisionLeader.body.rootRegistration, true);
    assert.deepEqual(forDivisionLeader.body.managers, []);
    assert.match(forDivisionLeader.body.note, /מפמ״ר/);
    assert.match(forDivisionLeader.body.note, /אופרטיבי/);
  });

  test('חיפוש חופשי מסנן את רשימת המפקדים לפי שם ולפי יחידה', async () => {
    const byName = await api('GET', '/api/auth/managers?role=employee&q=עומר');
    assert.equal(byName.status, 200);
    assert.ok(byName.body.managers.length > 0, 'חיפוש לפי שם לא החזיר תוצאות');
    assert.ok(byName.body.managers.every((manager: any) => manager.fullName.includes('עומר')));

    const byUnit = await api('GET', '/api/auth/managers?role=employee&q=אלון');
    assert.ok(
      byUnit.body.managers.some((manager: any) => (manager.unitName ?? '').includes('אלון')),
      'חיפוש לפי שם יחידה לא החזיר תוצאות',
    );

    const noMatch = await api('GET', '/api/auth/managers?role=employee&q=לאקייםבכלל');
    assert.deepEqual(noMatch.body.managers, []);
  });

  test('אי אפשר להירשם עם מפקד שאינו מהדרג שמעל', async () => {
    // ר״צ שמנסה להירשם תחת רת״ח במקום רמ״ד.
    const underDivision = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3100002',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'נועה',
        lastName: 'ניסיון',
        gender: 'female',
        diet: 'all',
        role: 'team_leader',
        unitName: 'צוות ניסיון',
        managerId: divisionId,
      },
    });
    assert.equal(underDivision.status, 400);
    assert.match(underDivision.body.error, /חייב להיות רמ״ד/);
  });

  test('חייל יכול להירשם ישירות תחת כל דרג מפקד, לא רק ר״צ', async () => {
    for (const [companyId, managerId, label] of [
      ['3100001', sectorId, 'רמ״ד'],
      ['3100003', toId, 'אופרטיבי'],
      ['3100004', divisionId, 'רת״ח'],
    ] as const) {
      const response = await api('POST', '/api/auth/register', {
        body: {
          phone: '0501234567',
          companyId,
          password: 'Test1234',
          confirmPassword: 'Test1234',
          firstName: 'עומר',
          lastName: 'ניסיון',
          gender: 'male',
          diet: 'all',
          role: 'employee',
          managerId,
        },
      });
      assert.equal(response.status, 201, `חייל לא הצליח להירשם תחת ${label}: ${JSON.stringify(response.body)}`);
    }
  });

  test('ר״צ יכול להיות כפוף לרמ״ד או לאופרטיבי', async () => {
    for (const [companyId, managerId, label] of [
      ['3300001', sectorId, 'רמ״ד'],
      ['3300002', toId, 'אופרטיבי'],
    ] as const) {
      const created = await api('POST', '/api/auth/register', {
        body: {
          phone: '0501234567',
          companyId,
          password: 'Test1234',
          confirmPassword: 'Test1234',
          firstName: 'נועם',
          lastName: 'ניסיון',
          gender: 'male',
          diet: 'all',
          role: 'team_leader',
          unitName: `צוות ${label}`,
          managerId,
        },
      });
      assert.equal(created.status, 201, `${label}: ${JSON.stringify(created.body)}`);
      assert.equal(created.body.user.managerId, managerId);
      assert.equal(created.body.user.status, 'pending');
    }
  });

  test('רת״ח נרשם בלי מפקד, והאופרטיבי מאשר את הרישום', async () => {
    // רת״ח שבוחר מפקד שאינו מפמ״ר נדחה.
    const withManager = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3200001',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'איתי',
        lastName: 'ניסיון',
        gender: 'male',
        diet: 'all',
        role: 'division_leader',
        unitName: 'תחום ניסיון',
        managerId: toId,
      },
    });
    assert.equal(withManager.status, 400);
    assert.match(withManager.body.error, /חייב להיות מפמ״ר/);

    // בלי מפקד - נרשם בהצלחה, כי אין עדיין מפמ״ר מאושר במערכת.
    const created = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3200002',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'רועי',
        lastName: 'ניסיון',
        gender: 'male',
        diet: 'all',
        role: 'division_leader',
        unitName: 'תחום ניסיון',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.user.status, 'pending');
    assert.equal(created.body.user.managerId, null);
    const newId = created.body.user.id as number;

    // האופרטיבי רואה את הבקשה ומאשר אותה.
    const toToken = await login('1000001');
    const pending = await api('GET', '/api/users/pending', { token: toToken });
    assert.ok(
      pending.body.pending.some((entry: any) => entry.id === newId),
      'רישום ראש שרשרת לא הופיע אצל האופרטיבי',
    );

    const approval = await api('POST', `/api/users/${newId}/approve`, { token: toToken });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(approval.body.user.status, 'approved');

    // מפקד רגיל אינו יכול לאשר רישום של ראש שרשרת שאינו כפוף לו.
    const other = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3200003',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'תמר',
        lastName: 'ניסיון',
        gender: 'female',
        diet: 'all',
        role: 'division_leader',
        unitName: 'תחום נוסף',
      },
    });
    assert.equal(other.status, 201);
    const leaderToken = await login('1000004');
    const denied = await api('POST', `/api/users/${other.body.user.id}/approve`, { token: leaderToken });
    assert.equal(denied.status, 403);
  });

  /**
   * מרגע שיש מפמ״ר מאושר, הוא ראש השרשרת: רת״ח נרשם תחתיו, והוא עצמו נרשם
   * בלי מפקד ומאושר על ידי האופרטיבי. הטסטים שלפני זה מניחים שאין מפמ״ר,
   * ולכן הוא נוצר כאן ולא ב-before.
   */
  test('מפמ״ר נרשם כראש שרשרת, האופרטיבי מאשר אותו, ורת״ח נרשם תחתיו', async () => {
    // המפמ״ר הוא ראש השרשרת ולכן אינו בוחר מפקד.
    const withManager = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3400001',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'תמר',
        lastName: 'ניסיון',
        gender: 'female',
        diet: 'all',
        role: 'ceo',
        unitName: 'כל החברה',
        managerId: divisionId,
      },
    });
    assert.equal(withManager.status, 400);
    assert.match(withManager.body.error, /אין מפקד במערכת/);

    const created = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3400002',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'נעמה',
        lastName: 'ניסיון',
        gender: 'female',
        diet: 'all',
        role: 'ceo',
        unitName: 'כל החברה',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.user.managerId, null);
    assert.equal(created.body.user.status, 'pending');
    ceoId = created.body.user.id as number;

    // רישום ללא מפקד מאושר על ידי האופרטיבי - למפמ״ר אין מפקד שיאשר אותו.
    const leaderToken = await login('1000004');
    const denied = await api('POST', `/api/users/${ceoId}/approve`, { token: leaderToken });
    assert.equal(denied.status, 403);

    const toToken = await login('1000001');
    const approved = await api('POST', `/api/users/${ceoId}/approve`, { token: toToken });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.user.role, 'ceo');
    assert.equal(approved.body.user.rankGroup, 'ceo');
    // מפקד לכל דבר, אבל בלי הרשאות ניהול מערכת.
    assert.equal(approved.body.user.isManager, true);
    assert.equal(approved.body.user.isTripOrganizer, false);

    // עכשיו שיש מפמ״ר מאושר, רת״ח כבר אינו נרשם כראש שרשרת אלא תחתיו.
    const options = await api('GET', '/api/auth/managers?role=division_leader');
    assert.equal(options.body.rootRegistration, false);
    assert.deepEqual(options.body.parentRoles, ['ceo']);
    assert.ok(
      options.body.managers.some((manager: any) => manager.id === ceoId),
      'המפמ״ר אינו מוצע כמפקד לרת״ח',
    );

    const underCeo = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '3400003',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'אורי',
        lastName: 'ניסיון',
        gender: 'male',
        diet: 'all',
        role: 'division_leader',
        unitName: 'תחום שני',
        managerId: ceoId,
      },
    });
    assert.equal(underCeo.status, 201, JSON.stringify(underCeo.body));
    assert.equal(underCeo.body.user.managerId, ceoId);
    assert.equal(underCeo.body.user.managerName.length > 0, true);

    // והמפמ״ר יכול לקבל את משימת השיבוץ - היחידה שלו היא כל החברה.
    const signingLeaders = await api('GET', '/api/trips/signing-leaders', { token: toToken });
    const asLeader = signingLeaders.body.leaders.find((leader: any) => leader.id === ceoId);
    assert.ok(asLeader, 'המפמ״ר אינו מופיע ברשימת המפקדים למשימת השיבוץ');
    assert.equal(asLeader.role, 'ceo');
    // המפמ״ר מופיע ראשון - הסדר בכל הרשימות הוא מלמעלה למטה בשרשרת.
    assert.equal(signingLeaders.body.leaders[0].id, ceoId);
  });

  test('היררכיה מחושבת נכון משרשרת הפיקוד', async () => {
    const token = await login('2000001');
    const me = await api('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.teamName, 'צוות אלון');
    assert.equal(me.body.user.sectorName, 'מדור תוכנה');
    assert.equal(me.body.user.divisionName, 'תחום פיתוח');
    assert.equal(me.body.user.rankGroup, 'soldier');
  });

  test('רק אופרטיבי יכול ליצור גלישה', async () => {
    const firstCycle = [{ exitDate: '2026-09-08' }];
    const soldierToken = await login('2000001');
    const denied = await api('POST', '/api/trips', {
      token: soldierToken,
      body: { name: 'גלישה', leaderIds: [sectorId], cycles: firstCycle },
    });
    assert.equal(denied.status, 403);

    const toToken = await login('1000001');

    // שם הגלישה חובה - הלקוח תמיד שולח את המפתח (גם ריק אחרי trim), ראו CreateTripPage.
    const noName = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: '', leaderIds: [sectorId], cycles: firstCycle },
    });
    assert.equal(noName.status, 400);
    assert.match(noName.body.error, /שם/);

    // חובה לבחור לפחות מפקד אחד שישבץ אנשים.
    const noLeaders = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: 'גלישה', leaderIds: [], cycles: firstCycle },
    });
    assert.equal(noLeaders.status, 400);

    // חובה להגדיר לפחות פעימה אחת - החלוץ.
    const noCycles = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: 'גלישה', leaderIds: [sectorId], cycles: [] },
    });
    assert.equal(noCycles.status, 400);
    assert.match(noCycles.body.error, /פעימה אחת/);

    // שתי פעימות באותו תאריך יציאה מותרות - לא כל הפעימות חייבות ימים שונים.
    const sameDate = await api('POST', '/api/trips', {
      token: toToken,
      body: {
        name: 'גלישה',
        leaderIds: [sectorId],
        cycles: [{ exitDate: '2026-09-08' }, { exitDate: '2026-09-08' }],
      },
    });
    assert.equal(sameDate.status, 201, JSON.stringify(sameDate.body));
    assert.equal(sameDate.body.trip.cycles.length, 2);
    assert.deepEqual(
      sameDate.body.trip.cycles.map((cycle: any) => cycle.exitDate),
      ['2026-09-08', '2026-09-08'],
    );
    assert.deepEqual(
      sameDate.body.trip.cycles.map((cycle: any) => cycle.name),
      ['חלוץ', 'פעימה 1'],
    );

    // ר״צ אינו מהדרגים שיכולים לקבל את משימת השיבוץ.
    const wrongRole = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: 'גלישה', leaderIds: [teamLeaderId], cycles: firstCycle },
    });
    assert.equal(wrongRole.status, 400);
    assert.match(wrongRole.body.error, /אינו מפמ״ר, רת״ח, רמ״ד או אופרטיבי/);

    const today = new Date().toISOString().slice(0, 10);
    const created = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: 'גלישת גיבוש קיץ', leaderIds: [sectorId, divisionId], cycles: firstCycle },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // המצב הראשון במכונת המצבים נקבע מיד ביצירה.
    assert.equal(created.body.trip.state, 'LAUNCHED');
    assert.equal(created.body.trip.leadersNotified, false);
    assert.equal(created.body.trip.name, 'גלישת גיבוש קיץ');
    // תאריך הפרסום הוא רגע הלחיצה על הכפתור - לא שדה שהאופרטיבי ממלא.
    assert.equal(created.body.trip.launchDate, today);
    assert.equal(created.body.trip.leaders.length, 2);
    // הפעימות נוצרות יחד עם הגלישה, והראשונה היא תמיד החלוץ.
    assert.equal(created.body.trip.cycles.length, 1);
    assert.equal(created.body.trip.cycles[0].name, 'חלוץ');
    assert.equal(created.body.trip.cycles[0].customName, false);
    assert.equal(created.body.trip.cycles[0].exitDate, '2026-09-08');
    tripId = created.body.trip.id;
    cycleId = created.body.trip.cycles[0].id;

    // ואפשר לשנות את השם גם אחרי היצירה.
    const renamed = await api('PATCH', `/api/trips/${created.body.trip.id}`, {
      token: toToken,
      body: { name: 'גלישת גיבוש קיץ - מעודכן' },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.trip.name, 'גלישת גיבוש קיץ - מעודכן');

    // ואפשר לתת שם מותאם אישית לפעימה כבר ביצירה - היא לא תיספר מחדש אוטומטית.
    const namedCycle = await api('POST', '/api/trips', {
      token: toToken,
      body: {
        name: 'גלישה עם פעימה בשם מותאם',
        leaderIds: [sectorId],
        cycles: [{ exitDate: '2026-09-09', name: 'מחזור קיץ' }],
      },
    });
    assert.equal(namedCycle.status, 201, JSON.stringify(namedCycle.body));
    assert.equal(namedCycle.body.trip.cycles[0].name, 'מחזור קיץ');
    assert.equal(namedCycle.body.trip.cycles[0].customName, true);
  });

  test('שמות הפעימות נגזרים מסדר היציאה: חלוץ ואחריו פעימה 1', async () => {
    const toToken = await login('1000001');
    const names = (body: any) => body.trip.cycles.map((cycle: any) => cycle.name);

    // פעימה שיוצאת אחרי החלוץ מקבלת את המספר הבא.
    const second = await api('POST', `/api/trips/${tripId}/cycles`, {
      token: toToken,
      body: { exitDate: '2026-09-15' },
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.deepEqual(names(second.body), ['חלוץ', 'פעימה 1']);
    const secondId = second.body.trip.cycles[1].id;

    // פעימה שיוצאת לפני כולן הופכת לחלוץ, והשאר ממוספרות מחדש.
    const earliest = await api('POST', `/api/trips/${tripId}/cycles`, {
      token: toToken,
      body: { exitDate: '2026-09-01' },
    });
    assert.equal(earliest.status, 201, JSON.stringify(earliest.body));
    assert.deepEqual(names(earliest.body), ['חלוץ', 'פעימה 1', 'פעימה 2']);
    assert.equal(earliest.body.trip.cycles[0].exitDate, '2026-09-01');
    const earliestId = earliest.body.trip.cycles[0].id;

    // תאריך יציאה כפול מותר - שתי פעימות יכולות לצאת באותו יום.
    const duplicate = await api('POST', `/api/trips/${tripId}/cycles`, {
      token: toToken,
      body: { exitDate: '2026-09-08' },
    });
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
    const duplicateCycle = duplicate.body.trip.cycles.find(
      (cycle: any) => cycle.exitDate === '2026-09-08' && cycle.id !== cycleId,
    );
    assert.ok(duplicateCycle, 'הפעימה הכפולה לא נוצרה');
    const removedDuplicate = await api('DELETE', `/api/trips/${tripId}/cycles/${duplicateCycle.id}`, {
      token: toToken,
    });
    assert.equal(removedDuplicate.status, 200, JSON.stringify(removedDuplicate.body));

    // שינוי תאריך מזיז את הפעימה בסדר, ולכן משנה את השמות.
    const moved = await api('PATCH', `/api/trips/${tripId}/cycles/${secondId}`, {
      token: toToken,
      body: { exitDate: '2026-08-25' },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.trip.cycles[0].id, secondId);
    assert.equal(moved.body.trip.cycles[0].name, 'חלוץ');

    // מחיקה מחזירה את המספור לרצף, ומשאירה את הפעימה המקורית כחלוץ.
    for (const id of [secondId, earliestId]) {
      const removed = await api('DELETE', `/api/trips/${tripId}/cycles/${id}`, { token: toToken });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    }
    const remaining = await api('GET', `/api/trips/${tripId}`, { token: toToken });
    assert.deepEqual(names(remaining.body), ['חלוץ']);
    assert.equal(remaining.body.trip.cycles[0].id, cycleId);
  });

  test('פעימה אינה מקבלת ואינה מחזירה תאריך חזרה', async () => {
    const toToken = await login('1000001');

    // הפעימה היא גל יציאה של יום אחד: תאריך חזרה שנשלח אינו נשמר ואינו מוחזר.
    const created = await api('POST', `/api/trips/${tripId}/cycles`, {
      token: toToken,
      body: { exitDate: '2026-10-01', returnDate: '2026-10-03' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // צורת הפעימה בתשובה, במלואה - אין בה תאריך חזרה.
    for (const cycle of created.body.trip.cycles) {
      assert.deepEqual(Object.keys(cycle).sort(), [
        'approvedCount',
        'customName',
        'exitDate',
        'id',
        'name',
        'pendingCount',
        'toApprovedCount',
      ]);
    }

    const added = created.body.trip.cycles.find((cycle: any) => cycle.exitDate === '2026-10-01');
    assert.ok(added, 'הפעימה החדשה לא נוצרה');

    // גם במסד אין עמודה כזו.
    const columns = (db.prepare('PRAGMA table_info(cycles)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    assert.deepEqual(columns.sort(), ['created_at', 'custom_name', 'exit_date', 'id', 'name', 'trip_id']);

    const removed = await api('DELETE', `/api/trips/${tripId}/cycles/${added.id}`, { token: toToken });
    assert.equal(removed.status, 200);
  });

  test('במצב LAUNCHED האופרטיבי מודיע לרמ״דים ולרת״חים שעליהם לשבץ אנשים', async () => {
    const toToken = await login('1000001');

    const notified = await api('POST', `/api/trips/${tripId}/notify-leaders`, { token: toToken, body: {} });
    assert.equal(notified.status, 200, JSON.stringify(notified.body));
    // רק המפקדים שקיבלו את המשימה בגלישה הזאת - לא ר״צ ולא חיילים.
    const expectedLeaders = (
      db.prepare('SELECT COUNT(*) AS count FROM trip_leaders WHERE trip_id = ?').get(tripId) as { count: number }
    ).count;
    assert.equal(notified.body.notified, expectedLeaders);
    assert.equal(expectedLeaders, 2);
    assert.equal(notified.body.reminder, false);
    assert.equal(notified.body.trip.leadersNotified, true);

    // הרמ״ד והרת״ח קיבלו התראה; הר״צ והחייל לא.
    for (const companyId of ['1000003', '1000002']) {
      const token = await login(companyId);
      const inbox = await api('GET', '/api/notifications', { token });
      assert.ok(
        inbox.body.notifications.some((entry: any) => entry.kind === 'trip_launched'),
        `${companyId} לא קיבל הודעה על גלישה חדשה`,
      );
    }
    for (const companyId of ['1000004', '2000001']) {
      const token = await login(companyId);
      const inbox = await api('GET', '/api/notifications', { token });
      assert.ok(
        !inbox.body.notifications.some((entry: any) => entry.kind === 'trip_launched'),
        `${companyId} קיבל הודעה שלא מיועדת לו`,
      );
    }

    // שליחה חוזרת היא תזכורת.
    const reminder = await api('POST', `/api/trips/${tripId}/notify-leaders`, { token: toToken, body: {} });
    assert.equal(reminder.body.reminder, true);
  });

  test('רק אופרטיבי יכול להודיע למפקדים', async () => {
    const sectorToken = await login('1000003');
    const denied = await api('POST', `/api/trips/${tripId}/notify-leaders`, { token: sectorToken, body: {} });
    assert.equal(denied.status, 403);
  });

  test('אופרטיבי מגדיר מבני לינה חד-מיניים עם חדרים', async () => {
    const toToken = await login('1000001');

    const male = await api('POST', `/api/trips/${tripId}/structures`, {
      token: toToken,
      body: {
        name: 'מבנה א׳',
        gender: 'male',
        rooms: [
          { name: '101', beds: 3 },
          { name: '102', beds: 3 },
        ],
      },
    });
    assert.equal(male.status, 201, JSON.stringify(male.body));

    const female = await api('POST', `/api/trips/${tripId}/structures`, {
      token: toToken,
      body: { name: 'מבנה ב׳', gender: 'female', rooms: [{ name: '201', beds: 4 }] },
    });
    assert.equal(female.status, 201);

    const invalidGender = await api('POST', `/api/trips/${tripId}/structures`, {
      token: toToken,
      body: { name: 'מבנה מעורב', gender: 'mixed', rooms: [] },
    });
    assert.equal(invalidGender.status, 400);

    const structures = await api('GET', `/api/trips/${tripId}/structures`, { token: toToken });
    assert.equal(structures.body.structures.length, 2);
    assert.equal(structures.body.structures.reduce((sum: number, s: any) => sum + s.totalBeds, 0), 10);
  });

  test('חייל אינו יכול לשבץ את עצמו לגלישה', async () => {
    const token = await login('2000001');

    const attempt = await api('POST', `/api/trips/${tripId}/signups`, {
      token,
      body: { cycleId, userIds: [soldierIds[0]] },
    });
    assert.equal(attempt.status, 403);
    assert.match(attempt.body.error, /חייל אינו משבץ את עצמו/);

    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token });
    assert.equal(signable.body.authority, null);
    assert.deepEqual(signable.body.people, []);
    assert.match(signable.body.note, /חייל אינו משבץ את עצמו/);
  });

  test('ר״צ אינו יכול לשבץ עד שהרמ״ד מאציל לו', async () => {
    const token = await login('1000004');

    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token });
    assert.equal(signable.body.authority, null, 'ר״צ קיבל הרשאת שיבוץ בלי האצלה');
    assert.match(signable.body.note, /לא האציל/);

    const attempt = await api('POST', `/api/trips/${tripId}/signups`, {
      token,
      body: { cycleId, userIds: [soldierIds[0]] },
    });
    assert.equal(attempt.status, 403);
  });

  test('אופרטיבי שלא קיבל את משימת השיבוץ חסום כמו כל מפקד אחר', async () => {
    // בגלישה הזאת המשימה הוטלה על הרמ״ד ועל הרת״ח, ולא על האופרטיבי.
    const toToken = await login('1000001');
    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: toToken });
    assert.equal(signable.body.authority, null);
    assert.deepEqual(signable.body.people, []);
    assert.match(signable.body.note, /לא קיבלת את משימת השיבוץ/);

    const attempt = await api('POST', `/api/trips/${tripId}/signups`, {
      token: toToken,
      body: { cycleId, userIds: [toSoldierIds[0]] },
    });
    assert.equal(attempt.status, 403);
    assert.match(attempt.body.error, /אין לך הרשאת שיבוץ/);
  });

  test('אופרטיבי שקיבל את משימת השיבוץ משבץ את המדור שלו כמו רמ״ד', async () => {
    const toToken = await login('1000001');

    // האופרטיבי מוצע לאופרטיבי כמפקד שיכול לקבל את משימת השיבוץ.
    const leaders = await api('GET', '/api/trips/signing-leaders', { token: toToken });
    assert.equal(leaders.status, 200);
    const asLeader = leaders.body.leaders.find((leader: any) => leader.id === toId);
    assert.ok(asLeader, 'האופרטיבי אינו מופיע ברשימת המפקדים למשימת השיבוץ');
    assert.equal(asLeader.role, 'to');
    assert.equal(asLeader.unitName, 'מדור אופרטיבי');

    // גלישה נפרדת, שבה משימת השיבוץ מוטלת על האופרטיבי בלבד.
    const created = await api('POST', '/api/trips', {
      token: toToken,
      body: { name: 'גלישה', launchDate: '2026-08-05', leaderIds: [toId], cycles: [{ exitDate: '2026-11-10' }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const toTripId = created.body.trip.id as number;
    const toCycleId = created.body.trip.cycles[0].id as number;
    assert.equal(created.body.trip.signingAuthority, 'leader');

    const signable = await api('GET', `/api/trips/${toTripId}/signable`, { token: toToken });
    assert.equal(signable.body.authority, 'leader');
    const ids = signable.body.people.map((person: any) => person.userId);
    assert.ok(ids.includes(toId), 'האופרטיבי לא רואה את עצמו');
    assert.ok(ids.includes(toTeamLeaderId), 'האופרטיבי לא רואה את הר״צ שלו');
    assert.ok(ids.includes(toSoldierIds[0]), 'האופרטיבי לא רואה את החיילים שלו');
    assert.ok(!ids.includes(sectorId), 'האופרטיבי רואה אנשים שאינם כפופים לו');
    assert.ok(!ids.includes(soldierIds[0]), 'האופרטיבי רואה חיילים של מדור אחר');

    // השיבוץ שלו נכנס מיד, כמו של כל מפקד שקיבל את המשימה.
    const signed = await api('POST', `/api/trips/${toTripId}/signups`, {
      token: toToken,
      body: { cycleId: toCycleId, userIds: [toId, toTeamLeaderId, ...toSoldierIds] },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.added, 4);
    assert.equal(signed.body.status, 'approved');
    const statuses = db
      .prepare('SELECT status FROM signups WHERE trip_id = ?')
      .all(toTripId) as Array<{ status: string }>;
    assert.ok(statuses.every((row) => row.status === 'approved'), 'שיבוץ של האופרטיבי לא נכנס כמאושר');

    // אבל מי שאינו כפוף לו - לא.
    const notMine = await api('POST', `/api/trips/${toTripId}/signups`, {
      token: toToken,
      body: { cycleId: toCycleId, userIds: [soldierIds[0]] },
    });
    assert.equal(notMine.status, 403);
    assert.match(notMine.body.error, /אינו כפוף לך/);

    // ניקוי: הגלישה הזאת נועדה רק לבדיקה הזאת.
    const removed = await api('DELETE', `/api/trips/${toTripId}`, { token: toToken });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.deleted.signups, 4);
  });

  test('המדור של חייל שכפוף לאופרטיבי הוא האופרטיבי עצמו', async () => {
    const token = await login('2100001');
    const me = await api('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.teamName, 'צוות מבצעים');
    assert.equal(me.body.user.sectorName, 'מדור אופרטיבי');
    assert.equal(me.body.user.sectorId, toId);
    assert.equal(me.body.user.rankGroup, 'soldier');

    // וגם בשיוך שמוצג ברשימות.
    const asTO = await login('1000001');
    const details = await api('GET', `/api/users/${toSoldierIds[0]}`, { token: asTO });
    assert.equal(details.status, 200);
    assert.equal(details.body.user.unitPath, 'מדור אופרטיבי / צוות מבצעים');

    // המועמדים לחדר של החייל הזה אינם מוגבלים למדור - כל חייל בן מתאים.
    const candidates = await api('GET', `/api/trips/${tripId}/roommate-candidates`, { token });
    assert.equal(candidates.status, 200);
    const ids = candidates.body.candidates.map((candidate: any) => candidate.id);
    assert.ok(ids.includes(soldierIds[0]), 'חייל ממדור אחר חסר מהרשימה - המדור לא אמור להגביל יותר');
    assert.ok(!ids.includes(toSoldierIds[1]), 'חיילת נכללה ברשימה של חייל');
    assert.ok(!ids.includes(toTeamLeaderId), 'מפקד נכלל ברשימה של חייל');
  });

  test('רמ״ד רואה את כל האנשים שלו ומשבץ אותם - השיבוץ נכנס מיד', async () => {
    const sectorToken = await login('1000003');

    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    assert.equal(signable.status, 200);
    assert.equal(signable.body.authority, 'leader');
    // הרמ״ד עצמו + הר״צ + 6 חיילים (ורועי שנרשם בטסט הראשון).
    const ids = signable.body.people.map((person: any) => person.userId);
    assert.ok(ids.includes(sectorId), 'הרמ״ד לא רואה את עצמו');
    assert.ok(ids.includes(teamLeaderId), 'הרמ״ד לא רואה את הר״צ');
    assert.ok(ids.includes(soldierIds[0]), 'הרמ״ד לא רואה את החיילים');
    assert.ok(!ids.includes(divisionId), 'הרמ״ד רואה את הרת״ח שמעליו');
    assert.equal(signable.body.hasDelegated, false);

    // משבץ את עצמו, את הר״צ ואת ששת החיילים.
    const signed = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [sectorId, teamLeaderId, ...soldierIds] },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.added, 8);
    // רמ״ד = אחראי שיבוץ, ולכן השיבוץ מאושר מיד ונכנס לשיבוצים.
    assert.equal(signed.body.status, 'approved');

    // כל מי ששובץ קיבל התראה להשלים פרטים.
    const soldierToken = await login('2000001');
    const inbox = await api('GET', '/api/notifications', { token: soldierToken });
    assert.ok(
      inbox.body.notifications.some((entry: any) => entry.kind === 'signed_up_by_manager'),
      'החייל לא קיבל התראה שהוא שובץ',
    );
  });

  test('שיבוץ כפול של אותו אדם מדולג בלי לשבור את הבקשה', async () => {
    const sectorToken = await login('1000003');
    const again = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [soldierIds[0]] },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.added, 0);
    assert.equal(again.body.skipped.length, 1);
    assert.match(again.body.skipped[0].reason, /כבר משובץ/);
  });

  test('רמ״ד אינו יכול לשבץ מי שאינו כפוף לו', async () => {
    const sectorToken = await login('1000003');
    const attempt = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [divisionId] },
    });
    assert.equal(attempt.status, 403);
    assert.match(attempt.body.error, /אינו כפוף לך/);
  });

  test('החייל משלים בעצמו העדפות שותפים ואישור תזונה', async () => {
    // 1<->2 הדדי, 3<->4 הדדי, 5<->6 הדדי (החיילות).
    const completions: Array<[string, number[], 'all' | 'vegetarian' | 'vegan']> = [
      ['2000001', [soldierIds[1]!], 'vegan'],
      ['2000002', [soldierIds[0]!], 'vegetarian'],
      ['2000003', [soldierIds[3]!], 'all'],
      ['2000004', [soldierIds[2]!], 'all'],
      ['2000005', [soldierIds[5]!], 'all'],
      ['2000006', [soldierIds[4]!], 'all'],
    ];

    for (const [companyId, preferences, diet] of completions) {
      const token = await login(companyId);
      const response = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
        token,
        body: { diet, dietConfirmed: true, preferences },
      });
      assert.equal(response.status, 200, `${companyId}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.signup.dietConfirmed, true);
      assert.equal(response.body.signup.preferences.length, preferences.length);
    }
  });

  test('חייל אינו יכול לבחור שותף מהמין השני', async () => {
    const token = await login('2000001'); // יונתן, בן
    const response = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token,
      body: { dietConfirmed: true, preferences: [soldierIds[4]] }, // מאיה, בת
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /בנים משובצים עם בנים/);
  });

  test('חייל אינו יכול לבחור מפקד כשותף לחדר', async () => {
    const token = await login('2000001');
    const response = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token,
      body: { dietConfirmed: true, preferences: [teamLeaderId] },
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /חיילים משובצים עם חיילים/);
  });

  test('אי אפשר לבחור יותר משלושה שותפים', async () => {
    const token = await login('2000001');
    const response = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token,
      body: {
        dietConfirmed: true,
        preferences: [soldierIds[1], soldierIds[2], soldierIds[3], toId],
      },
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /עד 3 שותפים/);
  });

  test('מי שלא שובץ אינו יכול להשלים פרטים', async () => {
    const token = await login('3000001'); // רועי, לא שובץ על ידי מפקד
    const response = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token,
      body: { dietConfirmed: true, preferences: [] },
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /לא שובצת/);
  });

  test('רשימת המועמדים לחדר כוללת רק אנשים מאותו מין ואותו דרג ניהולי בדיוק', async () => {
    const token = await login('2000001');
    const response = await api('GET', `/api/trips/${tripId}/roommate-candidates?cycleId=${cycleId}`, { token });
    assert.equal(response.status, 200);

    const ids = response.body.candidates.map((candidate: any) => candidate.id);
    assert.ok(ids.includes(soldierIds[1]), 'חייל בן חסר מהרשימה');
    assert.ok(!ids.includes(soldierIds[4]), 'חיילת נכללה ברשימה של חייל');
    assert.ok(!ids.includes(teamLeaderId), 'מפקד נכלל ברשימה של חייל');
    assert.ok(!ids.includes(soldierIds[0]), 'המשתמש עצמו נכלל ברשימה');
  });

  test('רמ״ד רואה את האופרטיבי ברשימת מועמדים לשותפות, כי שניהם שקולים לאותו דרג', async () => {
    const sectorToken = await login('1000003'); // דנה, רמ״ד
    const response = await api('GET', `/api/trips/${tripId}/roommate-candidates?cycleId=${cycleId}`, {
      token: sectorToken,
    });
    assert.equal(response.status, 200);

    const ids = response.body.candidates.map((candidate: any) => candidate.id);
    assert.ok(ids.includes(toId), 'האופרטיבי חסר מרשימת המועמדים של הרמ״ד');
  });

  test('האצלה מאפשרת לר״צ לשבץ, והרמ״ד מאשר אחר כך', async () => {
    // צוות נוסף תחת הרמ״ד, כדי לבדוק האצלה על אנשים שטרם שובצו.
    const otherLeaderId = seedUser({
      companyId: '1000005',
      firstName: 'תמר',
      lastName: 'ביטון',
      gender: 'female',
      role: 'team_leader',
      unitName: 'צוות ארז',
      managerId: sectorId,
    });
    const extraSoldierId = seedUser({
      companyId: '2000010',
      firstName: 'גיא',
      lastName: 'נחמיאס',
      gender: 'male',
      role: 'employee',
      managerId: otherLeaderId,
    });

    const sectorToken = await login('1000003');
    const otherToken = await login('1000005');

    // לפני האצלה - הר״צ החדש חסום.
    const before = await api('GET', `/api/trips/${tripId}/signable`, { token: otherToken });
    assert.equal(before.body.authority, null);

    // הרמ״ד מאציל.
    const delegated = await api('POST', `/api/trips/${tripId}/delegation`, { token: sectorToken, body: {} });
    assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
    assert.ok(delegated.body.delegatedTo >= 2);

    // עכשיו הר״צ רשאי לשבץ - אבל רק את הצוות שלו.
    const after = await api('GET', `/api/trips/${tripId}/signable`, { token: otherToken });
    assert.equal(after.body.authority, 'delegated');
    const visible = after.body.people.map((person: any) => person.userId);
    assert.ok(visible.includes(extraSoldierId), 'הר״צ לא רואה את החייל שלו');
    assert.ok(!visible.includes(soldierIds[0]), 'הר״צ רואה חיילים של צוות אחר');

    const signed = await api('POST', `/api/trips/${tripId}/signups`, {
      token: otherToken,
      body: { cycleId, userIds: [otherLeaderId, extraSoldierId] },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.added, 2);
    // ר״צ באצילה - השיבוץ ממתין לאישור הרמ״ד.
    assert.equal(signed.body.status, 'pending');

    // הרמ״ד מאשר את מה שהר״צ שיבץ.
    const approvals = await api('GET', `/api/trips/${tripId}/approvals`, { token: sectorToken });
    const pending = approvals.body.signups.filter((entry: any) => entry.status === 'pending');
    assert.equal(pending.length, 2, 'השיבוצים לא הופיעו אצל הרמ״ד לאישור');

    for (const signup of pending) {
      const decision = await api('POST', `/api/trips/${tripId}/signups/${signup.id}/approve`, {
        token: sectorToken,
        body: {},
      });
      assert.equal(decision.status, 200, JSON.stringify(decision.body));
      assert.equal(decision.body.signup.status, 'approved');
    }

    // ביטול האצלה מחזיר את הר״צ למצב חסום.
    const revoked = await api('DELETE', `/api/trips/${tripId}/delegation`, { token: sectorToken });
    assert.equal(revoked.status, 200);
    const blocked = await api('GET', `/api/trips/${tripId}/signable`, { token: otherToken });
    assert.equal(blocked.body.authority, null);
  });

  test('הרת״ח משבץ את עצמו', async () => {
    const divisionToken = await login('1000002');
    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: divisionToken });
    assert.equal(signable.body.authority, 'leader');

    const signed = await api('POST', `/api/trips/${tripId}/signups`, {
      token: divisionToken,
      body: { cycleId, userIds: [divisionId] },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.added, 1);
    assert.equal(signed.body.status, 'approved');
  });

  test('הרת״ח מאציל לרמ״ד הישיר שלו, לא ישר לר״צים בכל התחום', async () => {
    const divisionToken = await login('1000002');

    // לפני האצלה - התווית היא הכפיפים הישירים (רמ״דים), לא ר״צים.
    const before = await api('GET', `/api/trips/${tripId}/signable`, { token: divisionToken });
    assert.equal(before.body.subordinateRoleLabel, 'רמ״דים');

    const delegated = await api('POST', `/api/trips/${tripId}/delegation`, { token: divisionToken, body: {} });
    assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
    assert.equal(delegated.body.delegatedTo, 1, 'ההאצלה הייתה אמורה לכלול את הרמ״ד הישיר בלבד');
    assert.equal(delegated.body.roleLabel, 'רמ״דים');

    // הרמ״ד הישיר קיבל את ההתראה על ההאצלה.
    const sectorToken = await login('1000003');
    const sectorInbox = await api('GET', '/api/notifications', { token: sectorToken });
    assert.ok(
      sectorInbox.body.notifications.some((entry: any) => entry.kind === 'signing_delegated'),
      'הרמ״ד הישיר לא קיבל התראה על ההאצלה',
    );

    // ניקוי - כדי לא להשפיע על טסטים אחרים שתלויים במצב ההאצלה של הרת״ח.
    const revoked = await api('DELETE', `/api/trips/${tripId}/delegation`, { token: divisionToken });
    assert.equal(revoked.status, 200);
  });

  test('המפקד יכול להסיר אדם שהוא שיבץ', async () => {
    const sectorToken = await login('1000003');
    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    const target = signable.body.people.find(
      (person: any) => person.signup != null && person.userId === soldierIds[5],
    );
    assert.ok(target, 'לא נמצא אדם משובץ להסרה');

    const removed = await api('DELETE', `/api/trips/${tripId}/signups/${target.signup.id}`, {
      token: sectorToken,
    });
    assert.equal(removed.status, 200);

    // ומשבצים אותו חזרה, כדי שהמשך הטסטים יעבוד על אותה קבוצה.
    const readded = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [soldierIds[5]] },
    });
    assert.equal(readded.body.added, 1);
    const restore = await login('2000006');
    await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token: restore,
      body: { dietConfirmed: true, preferences: [soldierIds[4]] },
    });
  });

  test('מפקד מגיש את רשימת האנשים שלו, והאופרטיבי מקבל התראה', async () => {
    const sectorToken = await login('1000003');
    const toToken = await login('1000001');

    const submitted = await api('POST', `/api/trips/${tripId}/submit-signing`, { token: sectorToken, body: {} });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.ok(submitted.body.submittedAt, 'לא הוחזר מועד הגשה');
    assert.ok(submitted.body.signedCount >= 8, `נספרו ${submitted.body.signedCount} אנשים`);

    // הגשה שנייה נחסמת.
    const again = await api('POST', `/api/trips/${tripId}/submit-signing`, { token: sectorToken, body: {} });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /כבר הגשת את הרשימה שלך/);

    // האופרטיבי - שיצר את הגלישה - קיבל התראה על ההגשה.
    const inbox = await api('GET', '/api/notifications', { token: toToken });
    assert.ok(
      inbox.body.notifications.some((entry: any) => entry.kind === 'signing_submitted'),
      'האופרטיבי לא קיבל התראה על הגשת הרשימה',
    );

    // ההגשה מדווחת גם למפקד עצמו וגם לאופרטיבי ברשימת המפקדים.
    const mine = await api('GET', `/api/trips/${tripId}`, { token: sectorToken });
    assert.ok(mine.body.trip.mySubmittedAt, 'ההגשה של המפקד לא מדווחת לו');
    assert.equal(mine.body.trip.submitted, false, 'הגלישה סומנה כמוגשת בלי שהאופרטיבי הגיש אותה');
    assert.equal(mine.body.trip.rosterClosed, false);

    const asTO = await api('GET', `/api/trips/${tripId}`, { token: toToken });
    const sector = asTO.body.trip.leaders.find((leader: any) => leader.id === sectorId);
    const division = asTO.body.trip.leaders.find((leader: any) => leader.id === divisionId);
    assert.ok(sector.submittedAt, 'ההגשה של הרמ״ד לא מופיעה אצל האופרטיבי');
    assert.ok(sector.signedCount >= 8, `נספרו ${sector.signedCount} אנשים לרמ״ד`);
    assert.equal(division.submittedAt, null, 'הרת״ח סומן כמי שהגיש');

    // ביטול ההגשה מחזיר את המפקד לעריכה, וההגשה נעשית מחדש.
    const withdrawn = await api('DELETE', `/api/trips/${tripId}/submit-signing`, { token: sectorToken });
    assert.equal(withdrawn.status, 200);
    const withdrawnAgain = await api('DELETE', `/api/trips/${tripId}/submit-signing`, { token: sectorToken });
    assert.equal(withdrawnAgain.status, 400);
    assert.match(withdrawnAgain.body.error, /לא הגשת את הרשימה/);

    const resubmitted = await api('POST', `/api/trips/${tripId}/submit-signing`, { token: sectorToken, body: {} });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  });

  test('חייל שאושר אחרי ההגשה מדווח למפקד, והמפקד עוד יכול להוסיף אותו', async () => {
    // אין המתנה מכוונת: ההגשה ואישור הרישום נופלים באותה שנייה, וזה בדיוק
    // המקרה שחתימות הזמן ברזולוציית מילישנייה (NOW_MS) אמורות לתפוס.
    const registration = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '2000020',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'עדן',
        lastName: 'שפירא',
        gender: 'female',
        diet: 'all',
        role: 'employee',
        managerId: teamLeaderId,
      },
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    lateUserId = registration.body.user.id;

    const leaderToken = await login('1000004');
    const approved = await api('POST', `/api/users/${lateUserId}/approve`, { token: leaderToken });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    // הרמ״ד הגיש, ולכן הוא מקבל התראה שנוסף לו אדם.
    const sectorToken = await login('1000003');
    const sectorInbox = await api('GET', '/api/notifications', { token: sectorToken });
    const late = sectorInbox.body.notifications.find((entry: any) => entry.kind === 'late_addition');
    assert.ok(late, 'הרמ״ד לא קיבל התראה על תוספת מאוחרת');
    assert.match(late.title, /נוסף ליחידה שלך אחרי שהגשת/);
    assert.equal(late.link, `/trips/${tripId}/signing`);

    // הרת״ח לא הגיש, ולכן אין לו על מה להתעדכן.
    const divisionToken = await login('1000002');
    const divisionInbox = await api('GET', '/api/notifications', { token: divisionToken });
    assert.ok(
      !divisionInbox.body.notifications.some((entry: any) => entry.kind === 'late_addition'),
      'מפקד שלא הגיש קיבל התראה על תוספת מאוחרת',
    );

    // המסך מסמן אותו כתוספת מאוחרת - והוא נמצא גם ברשימת האנשים הרגילה.
    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    assert.equal(signable.status, 200);
    assert.ok(signable.body.submittedAt, 'ההגשה של המפקד לא מדווחת במסך השיבוץ');
    assert.equal(signable.body.rosterClosed, false);
    assert.equal(signable.body.rosterClosedNote, null);
    assert.deepEqual(signable.body.lateAdditions, [lateUserId]);
    assert.ok(signable.body.people.some((person: any) => person.userId === lateUserId));

    // וההוספה עצמה עוברת, כי האופרטיבי עוד לא הגיש את הגלישה.
    const added = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [lateUserId] },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.added, 1);

    // מרגע שהוא משובץ הוא אינו תוספת פתוחה יותר.
    const after = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    assert.deepEqual(after.body.lateAdditions, []);
  });

  test('הגשת הגלישה על ידי האופרטיבי מקפיאה את רשימת המשתתפים, וביטול ההגשה פותח אותה', async () => {
    const toToken = await login('1000001');
    const sectorToken = await login('1000003');
    const leaderToken = await login('1000004');

    // עוד חייל שאושר אחרי ההגשה - עליו נבדוק את החסימה.
    const registration = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '2000021',
        password: 'Test1234',
        confirmPassword: 'Test1234',
        firstName: 'טל',
        lastName: 'הררי',
        gender: 'female',
        diet: 'all',
        role: 'employee',
        managerId: teamLeaderId,
      },
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    blockedUserId = registration.body.user.id;
    const approvedUser = await api('POST', `/api/users/${blockedUserId}/approve`, { token: leaderToken });
    assert.equal(approvedUser.status, 200);

    const submitted = await api('POST', `/api/trips/${tripId}/submit`, { token: toToken, body: {} });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.trip.submitted, true);
    assert.ok(submitted.body.trip.submittedAt, 'לא נשמר מועד הגשת הגלישה');
    assert.equal(submitted.body.trip.rosterClosed, true);
    assert.ok(submitted.body.approved >= 8, `${submitted.body.approved} מאושרים`);
    assert.equal(typeof submitted.body.pending, 'number');

    // מי שקיבל את משימת השיבוץ ולא הגיש - לידיעת האופרטיבי, בלי לחסום.
    assert.deepEqual(
      submitted.body.leadersNotSubmitted.map((leader: any) => leader.id),
      [divisionId],
    );
    assert.ok(submitted.body.leadersNotSubmitted[0].fullName.length > 0);

    const again = await api('POST', `/api/trips/${tripId}/submit`, { token: toToken, body: {} });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /כבר הוגש/);

    // המפקדים קיבלו הודעה שהרשימה נסגרה.
    const inbox = await api('GET', '/api/notifications', { token: sectorToken });
    assert.ok(
      inbox.body.notifications.some((entry: any) => entry.kind === 'trip_submitted'),
      'המפקד לא קיבל הודעה שהגלישה הוגשה',
    );

    // ומכאן אי אפשר להוסיף אנשים - גם לא תוספת מאוחרת.
    const blocked = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [blockedUserId] },
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /האופרטיבי הגיש את הגלישה/);

    const closed = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    assert.equal(closed.body.rosterClosed, true);
    assert.match(closed.body.rosterClosedNote, /האופרטיבי הגיש את הגלישה/);

    // ביטול ההגשה פותח את הרשימה מחדש, וההוספה עוברת.
    const reopened = await api('DELETE', `/api/trips/${tripId}/submit`, { token: toToken });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.trip.submitted, false);
    assert.equal(reopened.body.trip.rosterClosed, false);

    const reopenNotice = await api('GET', '/api/notifications', { token: sectorToken });
    assert.ok(
      reopenNotice.body.notifications.some((entry: any) => entry.kind === 'signing_reopened'),
      'המפקד לא קיבל הודעה שהרשימה נפתחה מחדש',
    );

    const addedNow = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [blockedUserId] },
    });
    assert.equal(addedNow.status, 201, JSON.stringify(addedNow.body));
    assert.equal(addedNow.body.added, 1);

    const notSubmitted = await api('DELETE', `/api/trips/${tripId}/submit`, { token: toToken });
    assert.equal(notSubmitted.status, 400);
    assert.match(notSubmitted.body.error, /אינו מוגש/);
  });

  test('אחרי הגשת הגלישה הפרטים האישיים נשארים פתוחים, אבל מי יוצא קפוא', async () => {
    const toToken = await login('1000001');
    const sectorToken = await login('1000003');
    const submitted = await api('POST', `/api/trips/${tripId}/submit`, { token: toToken, body: {} });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

    // שיבוץ הלינה מתבצע אחרי ההגשה, ולכן החייל חייב להמשיך להשלים פרטים.
    const soldierToken = await login('2000001');
    const details = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token: soldierToken,
      body: { dietConfirmed: true, preferences: [soldierIds[1]] },
    });
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.equal(details.body.signup.dietConfirmed, true);

    // אבל מי יוצא - קפוא: אין הוספה ואין הסרה.
    const roeyId = (db.prepare("SELECT id FROM users WHERE company_id = '3000001'").get() as { id: number }).id;
    const add = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [roeyId] },
    });
    assert.equal(add.status, 400);
    assert.match(add.body.error, /האופרטיבי הגיש את הגלישה/);

    const signable = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
    const lateSignup = signable.body.people.find((person: any) => person.userId === lateUserId)?.signup;
    assert.ok(lateSignup, 'לא נמצא השיבוץ של התוספת המאוחרת');
    const remove = await api('DELETE', `/api/trips/${tripId}/signups/${lateSignup.id}`, { token: sectorToken });
    assert.equal(remove.status, 400);
    assert.match(remove.body.error, /האופרטיבי הגיש את הגלישה/);

    // פתיחה מחדש והסרת התוספות, כדי שהמשך הטסטים יעבוד על אותה קבוצה.
    const reopened = await api('DELETE', `/api/trips/${tripId}/submit`, { token: toToken });
    assert.equal(reopened.status, 200);
    for (const userId of [lateUserId, blockedUserId]) {
      const current = await api('GET', `/api/trips/${tripId}/signable`, { token: sectorToken });
      const signup = current.body.people.find((person: any) => person.userId === userId)?.signup;
      assert.ok(signup, `לא נמצא השיבוץ של ${userId}`);
      const removed = await api('DELETE', `/api/trips/${tripId}/signups/${signup.id}`, { token: sectorToken });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    }
  });

  test('אופרטיבי נועל את שיבוץ האוטובוסים וכולם מקבלים מספר אוטובוס', async () => {
    const toToken = await login('1000001');
    await toApproveTrip(tripId, toToken);

    const preview = await api('GET', `/api/trips/${tripId}/buses/preview`, { token: toToken });
    assert.equal(preview.status, 200);
    // כל מי שהמפקדים שיבצו ואושר; נגזר מהמסד ולא מספר קבוע.
    const approvedCount = (
      db
        .prepare("SELECT COUNT(*) AS count FROM signups WHERE trip_id = ? AND status = 'approved'")
        .get(tripId) as { count: number }
    ).count;
    // הרת״ח בין המשובצים מוחרג אוטומטית מהאוטובוס - הוא תמיד מגיע ברכב הפרטי שלו.
    const carCount = preview.body.cycles[0].carCount;
    assert.equal(preview.body.cycles[0].result.totalParticipants, approvedCount - carCount);
    assert.ok(approvedCount >= 8);

    const locked = await api('POST', `/api/trips/${tripId}/buses/lock`, { token: toToken, body: {} });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));

    const again = await api('POST', `/api/trips/${tripId}/buses/lock`, { token: toToken, body: {} });
    assert.equal(again.status, 400, 'נעילה כפולה לא נחסמה');

    const list = await api('GET', `/api/trips/${tripId}/buses`, { token: toToken });
    assert.equal(list.body.locked, true);
    assert.equal(list.body.scope, 'all');
    const totalAssigned = list.body.cycles[0].buses.reduce((sum: number, bus: any) => sum + bus.count, 0);
    assert.equal(totalAssigned, approvedCount - carCount);

    // חייל רואה את מספר האוטובוס שלו.
    const soldierToken = await login('2000001');
    const mine = await api('GET', `/api/trips/${tripId}/buses/mine`, { token: soldierToken });
    assert.equal(mine.body.assignment.busNumber, 1);
  });

  test('מפקד רואה באוטובוסים רק את האנשים שלו', async () => {
    const leaderToken = await login('1000004');
    const list = await api('GET', `/api/trips/${tripId}/buses`, { token: leaderToken });
    assert.equal(list.body.scope, 'my-people');

    const visible = list.body.cycles[0].buses.flatMap((bus: any) => bus.members.map((m: any) => m.userId));
    // הר״צ עצמו והחיילים שלו, אך לא הרמ״ד שמעליו.
    assert.ok(visible.includes(teamLeaderId), 'המפקד לא רואה את עצמו');
    assert.ok(visible.includes(soldierIds[0]), 'המפקד לא רואה את החיילים שלו');
    assert.ok(!visible.includes(sectorId), 'מפקד ראה את המפקד שמעליו');
    assert.ok(!visible.includes(divisionId), 'מפקד ראה את הרת״ח');
  });

  test('שיבוץ נחסם אחרי נעילת השיבוצים', async () => {
    // הרמ״ד מנסה לשבץ את רועי, שטרם שובץ - נחסם כי האוטובוסים נעולים.
    const sectorToken = await login('1000003');
    const roeyId = (
      db.prepare("SELECT id FROM users WHERE company_id = '3000001'").get() as { id: number }
    ).id;

    const response = await api('POST', `/api/trips/${tripId}/signups`, {
      token: sectorToken,
      body: { cycleId, userIds: [roeyId] },
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /נעולים/);

    // וגם החייל לא יכול לעדכן את הפרטים שלו יותר.
    const soldierToken = await login('2000001');
    const update = await api('PATCH', `/api/trips/${tripId}/my-signup`, {
      token: soldierToken,
      body: { dietConfirmed: true, preferences: [] },
    });
    assert.equal(update.status, 400);
  });

  test('אופרטיבי נועל את שיבוץ הלינה תוך שמירת כל האילוצים', async () => {
    const toToken = await login('1000001');
    await toApproveTrip(tripId, toToken);
    const locked = await api('POST', `/api/trips/${tripId}/dorms/lock`, { token: toToken, body: {} });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));

    const dorms = await api('GET', `/api/trips/${tripId}/dorms`, { token: toToken });
    assert.equal(dorms.body.locked, true);

    for (const room of dorms.body.cycles[0].rooms) {
      assert.ok(room.totalOccupancy <= room.beds, `חדר ${room.roomName} מאוכלס מעל הקיבולת`);
    }

    // בדיקה ישירה במסד: אין חדר שמערבב מינים או דרגות.
    const mixedGender = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT ra.room_id FROM room_assignments ra
             JOIN users u ON u.id = ra.user_id
            WHERE ra.trip_id = ?
            GROUP BY ra.room_id, ra.cycle_id
           HAVING COUNT(DISTINCT u.gender) > 1)`,
      )
      .get(tripId) as { count: number };
    assert.equal(mixedGender.count, 0, 'נמצא חדר עם בנים ובנות יחד');

    const mixedRank = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT ra.room_id FROM room_assignments ra
             JOIN users u ON u.id = ra.user_id
            WHERE ra.trip_id = ?
            GROUP BY ra.room_id, ra.cycle_id
           HAVING COUNT(DISTINCT CASE WHEN u.role = 'employee' THEN 'soldier' ELSE 'commander' END) > 1)`,
      )
      .get(tripId) as { count: number };
    assert.equal(mixedRank.count, 0, 'נמצא חדר עם חיילים ומפקדים יחד');

    // גם המבנה עצמו חייב להתאים למין השוכנים.
    const wrongStructure = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM room_assignments ra
           JOIN users u ON u.id = ra.user_id
           JOIN rooms r ON r.id = ra.room_id
           JOIN structures st ON st.id = r.structure_id
          WHERE ra.trip_id = ? AND st.gender != u.gender`,
      )
      .get(tripId) as { count: number };
    assert.equal(wrongStructure.count, 0, 'אדם שובץ למבנה של המין השני');
  });

  test('העדפות הדדיות התקיימו והחייל רואה את השותפים שלו', async () => {
    const token = await login('2000001');
    const summary = await api('GET', `/api/trips/${tripId}/summary`, { token });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.signedUp, true);
    assert.equal(summary.body.signup.status, 'approved');
    assert.equal(summary.body.bus.published, true);
    assert.equal(summary.body.bus.number, 1);
    assert.equal(summary.body.dorm.published, true);
    assert.ok(summary.body.dorm.roomName, 'לא הוחזר חדר');
    // צורת הפעימה בסיכום האישי במלואה - אין בה תאריך חזרה.
    assert.deepEqual(Object.keys(summary.body.cycle).sort(), ['exitDate', 'id', 'name']);

    const preference = summary.body.preferences[0];
    assert.equal(preference.gotIt, true, 'ההעדפה ההדדית לא התקיימה');
  });

  test('דוח הזמנת המזון מסכם מנות לפי סוג תזונה', async () => {
    const toToken = await login('1000001');
    await toApproveTrip(tripId, toToken);
    const food = await api('GET', `/api/trips/${tripId}/food`, { token: toToken });
    assert.equal(food.status, 200);

    // מספר המשתתפים נגזר ממה שהמפקדים שיבצו, ולא מספר קבוע בטסט.
    const approved = (
      db
        .prepare("SELECT COUNT(*) AS count FROM signups WHERE trip_id = ? AND status = 'approved'")
        .get(tripId) as { count: number }
    ).count;

    const cycle = food.body.cycles[0];
    // הפעימה היא גל של יום אחד: מנות = משתתפים כפול 3 ארוחות.
    // צורת הפעימה בדוח במלואה - אין בה מספר ימים ואין תאריך חזרה.
    assert.deepEqual(Object.keys(cycle).sort(), [
      'cycleId',
      'cycleName',
      'diets',
      'exitDate',
      'mealsPerDay',
      'participants',
      'totalPortions',
    ]);
    assert.equal(cycle.mealsPerDay, 3);
    assert.equal(cycle.participants, approved);
    assert.equal(cycle.totalPortions, approved * 3);

    // סוגי התזונה שהחיילים אישרו בהשלמת הפרטים.
    const vegan = cycle.diets.find((entry: any) => entry.diet === 'vegan');
    const vegetarian = cycle.diets.find((entry: any) => entry.diet === 'vegetarian');
    assert.equal(vegan.participants, 1);
    assert.equal(vegan.portions, vegan.participants * 3);
    assert.equal(vegetarian.participants, 1);
    assert.equal(food.body.grandTotalParticipants, approved);
    // סך המנות שווה לסכום המנות של כל סוגי התזונה.
    assert.equal(
      food.body.grandTotalPortions,
      food.body.totals.reduce((sum: number, entry: any) => sum + entry.portions, 0),
    );
  });

  test('דוח המזון חסום למי שאינו אופרטיבי', async () => {
    const leaderToken = await login('1000004');
    const response = await api('GET', `/api/trips/${tripId}/food`, { token: leaderToken });
    assert.equal(response.status, 403);
  });

  test('התראות נשלחו למשתתפים ולמפקדים', async () => {
    const soldierToken = await login('2000001');
    const notifications = await api('GET', '/api/notifications', { token: soldierToken });
    assert.equal(notifications.status, 200);

    const kinds = notifications.body.notifications.map((entry: any) => entry.kind);
    assert.ok(kinds.includes('signed_up_by_manager'), 'לא נשלחה התראה על השיבוץ לגלישה');
    assert.ok(kinds.includes('buses_published'), 'לא נשלחה התראה על פרסום האוטובוסים');
    assert.ok(kinds.includes('dorms_published'), 'לא נשלחה התראה על פרסום הלינה');
    assert.ok(notifications.body.unread > 0);

    const readAll = await api('POST', '/api/notifications/read-all', { token: soldierToken });
    assert.equal(readAll.status, 200);
    const after = await api('GET', '/api/notifications', { token: soldierToken });
    assert.equal(after.body.unread, 0);
  });

  test('בקשה ללא טוקן נדחית ב-401', async () => {
    const response = await api('GET', '/api/trips');
    assert.equal(response.status, 401);
  });

  test('טוקן מזויף נדחה', async () => {
    const response = await api('GET', '/api/trips', { token: 'bm9wZQ.aW52YWxpZA' });
    assert.equal(response.status, 401);
  });

  test('ביטול נעילה מאפשר הרצה מחדש', async () => {
    const toToken = await login('1000001');
    const unlockBuses = await api('POST', `/api/trips/${tripId}/buses/unlock`, { token: toToken, body: {} });
    assert.equal(unlockBuses.status, 200);

    const buses = await api('GET', `/api/trips/${tripId}/buses`, { token: toToken });
    assert.equal(buses.body.locked, false);

    const relock = await api('POST', `/api/trips/${tripId}/buses/lock`, { token: toToken, body: {} });
    assert.equal(relock.status, 200);
  });

  /**
   * מחיקת הגלישה - אחרון בסדר, כי היא מוחקת את הגלישה שכל הטסטים שלפניה בנו.
   * הגלישה הזאת כבר מכילה שיבוצים, פעימות, מבני לינה, הגשות והתראות, ולכן היא
   * בדיוק המקרה שהמחיקה צריכה להתמודד איתו.
   */
  test('אופרטיבי מוחק גלישה על כל מה שתלוי בו', async () => {
    const toToken = await login('1000001');
    const sectorToken = await login('1000003');

    // רק האופרטיבי מוחק.
    const denied = await api('DELETE', `/api/trips/${tripId}`, { token: sectorToken });
    assert.equal(denied.status, 403);

    const before = {
      signups: (db.prepare('SELECT COUNT(*) AS c FROM signups WHERE trip_id = ?').get(tripId) as { c: number }).c,
      cycles: (db.prepare('SELECT COUNT(*) AS c FROM cycles WHERE trip_id = ?').get(tripId) as { c: number }).c,
      structures: (db.prepare('SELECT COUNT(*) AS c FROM structures WHERE trip_id = ?').get(tripId) as { c: number })
        .c,
    };
    assert.ok(before.signups > 0, 'הטסט הזה דורש גלישה עם שיבוצים');
    assert.ok(before.structures > 0, 'הטסט הזה דורש גלישה עם מבני לינה');

    const deleted = await api('DELETE', `/api/trips/${tripId}`, { token: toToken });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted.signups, before.signups);
    assert.equal(deleted.body.deleted.cycles, before.cycles);
    assert.equal(deleted.body.deleted.structures, before.structures);
    // ההתראות אינן מקושרות בזרות לגלישה, ולכן הן נמחקות במפורש.
    assert.ok(deleted.body.deleted.notifications > 0, 'לא נמחקו התראות של הגלישה');

    // לא נשארו שורות תלויות באף טבלה.
    for (const table of [
      'cycles',
      'signups',
      'structures',
      'trip_leaders',
      'trip_delegations',
      'trip_submissions',
      'bus_assignments',
      'room_assignments',
      'dorm_issues',
    ]) {
      const left = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE trip_id = ?`).get(tripId) as { c: number }).c;
      assert.equal(left, 0, `נשארו שורות ב-${table} אחרי מחיקת הגלישה`);
    }
    // גם העדפות הלינה, שתלויות בהרשמה ולא בגלישה.
    const orphanPreferences = (
      db
        .prepare('SELECT COUNT(*) AS c FROM dorm_preferences WHERE signup_id NOT IN (SELECT id FROM signups)')
        .get() as { c: number }
    ).c;
    assert.equal(orphanPreferences, 0, 'נשארו העדפות לינה בלי הרשמה');
    const leftNotifications = (
      db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE link LIKE ?").get(`/trips/${tripId}%`) as { c: number }
    ).c;
    assert.equal(leftNotifications, 0, 'נשארו התראות שמצביעות על גלישה שנמחקה');

    const gone = await api('GET', `/api/trips/${tripId}`, { token: toToken });
    assert.equal(gone.status, 404);
  });

  test('מפקד מעביר כפיף בתוך השרשרת שלו - חל מיד בלי אישור', async () => {
    const sectorAId = seedUser({
      companyId: '5000001',
      firstName: 'רונית',
      lastName: 'עמית',
      gender: 'female',
      role: 'sector_leader',
      unitName: 'מדור בדיקה א',
      managerId: divisionId,
    });
    const teamAId = seedUser({
      companyId: '5000002',
      firstName: 'גל',
      lastName: 'שני',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקה א',
      managerId: sectorAId,
    });
    const teamBId = seedUser({
      companyId: '5000003',
      firstName: 'הילה',
      lastName: 'רז',
      gender: 'female',
      role: 'team_leader',
      unitName: 'צוות בדיקה ב',
      managerId: sectorAId,
    });
    const soldierAId = seedUser({
      companyId: '5000004',
      firstName: 'איתן',
      lastName: 'כרמי',
      gender: 'male',
      role: 'employee',
      managerId: teamAId,
    });

    const sectorAToken = await login('5000001');
    const moved = await api('POST', `/api/users/${soldierAId}/move`, {
      token: sectorAToken,
      body: { toManagerId: teamBId },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.applied, true);
    assert.equal(moved.body.user.managerId, teamBId);

    const check = await api('GET', `/api/users/${soldierAId}`, { token: sectorAToken });
    assert.equal(check.body.user.managerId, teamBId);
  });

  test('העברה מחוץ לשרשרת הפיקוד ממתינה לאישור המפקד היעד', async () => {
    const sectorCId = seedUser({
      companyId: '5000005',
      firstName: 'נועה',
      lastName: 'בר',
      gender: 'female',
      role: 'sector_leader',
      unitName: 'מדור בדיקה ג',
      managerId: divisionId,
    });
    const teamCId = seedUser({
      companyId: '5000006',
      firstName: 'עדי',
      lastName: 'לביא',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקה ג',
      managerId: sectorCId,
    });
    const soldierBId = seedUser({
      companyId: '5000007',
      firstName: 'תום',
      lastName: 'אלוני',
      gender: 'male',
      role: 'employee',
      managerId: teamCId,
    });

    const teamCToken = await login('5000006');

    // teamLeaderId (1000004) אינו קשור כלל לענף הזה - העברה אליו חייבת אישור.
    const requested = await api('POST', `/api/users/${soldierBId}/move`, {
      token: teamCToken,
      body: { toManagerId: teamLeaderId },
    });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.applied, false);
    assert.ok(requested.body.pending);

    // עדיין לא הוחל.
    const before = await api('GET', `/api/users/${soldierBId}`, { token: teamCToken });
    assert.equal(before.body.user.managerId, teamCId);

    const teamLeaderToken = await login('1000004');
    const pendingList = await api('GET', '/api/users/moves/pending', { token: teamLeaderToken });
    assert.ok(pendingList.body.pending.some((entry: any) => entry.user.id === soldierBId));

    const approved = await api('POST', `/api/users/moves/${requested.body.pending.id}/approve`, {
      token: teamLeaderToken,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.user.managerId, teamLeaderId);

    const after = await api('GET', `/api/users/${soldierBId}`, { token: teamLeaderToken });
    assert.equal(after.body.user.managerId, teamLeaderId);
  });

  test('דחיית בקשת העברה משאירה את המצב כמו שהיה ומודיעה למבקש', async () => {
    const sectorDId = seedUser({
      companyId: '5000008',
      firstName: 'ליאור',
      lastName: 'פז',
      gender: 'male',
      role: 'sector_leader',
      unitName: 'מדור בדיקה ד',
      managerId: divisionId,
    });
    const teamDId = seedUser({
      companyId: '5000009',
      firstName: 'מאיה',
      lastName: 'גל',
      gender: 'female',
      role: 'team_leader',
      unitName: 'צוות בדיקה ד',
      managerId: sectorDId,
    });
    const soldierCId = seedUser({
      companyId: '5000010',
      firstName: 'רועי',
      lastName: 'שדה',
      gender: 'male',
      role: 'employee',
      managerId: teamDId,
    });

    const teamDToken = await login('5000009');
    const requested = await api('POST', `/api/users/${soldierCId}/move`, {
      token: teamDToken,
      body: { toManagerId: teamLeaderId },
    });
    assert.equal(requested.body.applied, false);

    const teamLeaderToken = await login('1000004');
    const rejected = await api('POST', `/api/users/moves/${requested.body.pending.id}/reject`, {
      token: teamLeaderToken,
      body: { note: 'אין מקום בצוות' },
    });
    assert.equal(rejected.status, 200);

    const stillThere = await api('GET', `/api/users/${soldierCId}`, { token: teamDToken });
    assert.equal(stillThere.body.user.managerId, teamDId, 'המשתמש הועבר למרות שהבקשה נדחתה');

    const inbox = await api('GET', '/api/notifications', { token: teamDToken });
    assert.ok(
      inbox.body.notifications.some((entry: any) => entry.kind === 'move_rejected'),
      'המבקש לא קיבל התראה על הדחייה',
    );
  });

  test('העברת מפקד יחידה דורשת ממלא מקום תקין, שיורש את הכפיפים שלו', async () => {
    const sectorEId = seedUser({
      companyId: '5000011',
      firstName: 'דנה',
      lastName: 'אור',
      gender: 'female',
      role: 'sector_leader',
      unitName: 'מדור בדיקה ה',
      managerId: divisionId,
    });
    const teamEId = seedUser({
      companyId: '5000012',
      firstName: 'יובל',
      lastName: 'שקד',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקה ה',
      managerId: sectorEId,
    });
    const soldierEId = seedUser({
      companyId: '5000013',
      firstName: 'שגיא',
      lastName: 'נוי',
      gender: 'male',
      role: 'employee',
      managerId: teamEId,
    });
    // צוות שני עם מפקד משלו - ישמש כממלא מקום לא כשיר, כי כבר יש לו כפיפים.
    const teamFId = seedUser({
      companyId: '5000014',
      firstName: 'אורי',
      lastName: 'שגב',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקה ו',
      managerId: sectorEId,
    });
    seedUser({
      companyId: '5000015',
      firstName: 'נטע',
      lastName: 'הדר',
      gender: 'female',
      role: 'employee',
      managerId: teamFId,
    });
    const sectorGId = seedUser({
      companyId: '5000016',
      firstName: 'אלה',
      lastName: 'ברק',
      gender: 'female',
      role: 'sector_leader',
      unitName: 'מדור בדיקה ז',
      managerId: divisionId,
    });

    const sectorEToken = await login('5000011');

    // בלי ממלא מקום - נדחה, כי לצוות ה׳ יש חייל שייוותר בלי מפקד.
    const missingSuccessor = await api('POST', `/api/users/${teamEId}/move`, {
      token: sectorEToken,
      body: { toManagerId: sectorGId },
    });
    assert.equal(missingSuccessor.status, 400);
    assert.match(missingSuccessor.body.error, /ממלא מקום/);

    // ממלא מקום שכבר מפקד על יחידה משלו - נדחה גם הוא.
    const ineligibleSuccessor = await api('POST', `/api/users/${teamEId}/move`, {
      token: sectorEToken,
      body: { toManagerId: sectorGId, successorId: teamFId },
    });
    assert.equal(ineligibleSuccessor.status, 400);
    assert.match(ineligibleSuccessor.body.error, /כבר מפקד/);

    // חיפוש ממלא המקום לפי שם.
    const search = await api('GET', '/api/users/search?q=שגיא', { token: sectorEToken });
    assert.ok(search.body.results.some((entry: any) => entry.id === soldierEId));

    // מקדם את החייל בצוות שלו למלא את מקומו של המפקד שעובר - התרחיש הריאלי.
    const requested = await api('POST', `/api/users/${teamEId}/move`, {
      token: sectorEToken,
      body: { toManagerId: sectorGId, successorId: soldierEId },
    });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.applied, false, 'מדור ז׳ מחוץ לשרשרת של מדור ה׳ - הייתה אמורה להמתין לאישור');

    const sectorGToken = await login('5000016');
    const approved = await api('POST', `/api/users/moves/${requested.body.pending.id}/approve`, {
      token: sectorGToken,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    // המפקד שעבר - עכשיו תחת מדור ז׳.
    const movedLeader = await api('GET', `/api/users/${teamEId}`, { token: sectorGToken });
    assert.equal(movedLeader.body.user.managerId, sectorGId);

    // ממלא המקום ירש את התפקיד, שם היחידה, והמפקד הקודם (מדור ה׳) - שעדיין
    // מחזיק בסמכות עליו, ולכן משמש לצפייה כאן (מדור ז׳ אינו כפוף אליו).
    const successor = await api('GET', `/api/users/${soldierEId}`, { token: sectorEToken });
    assert.equal(successor.status, 200, JSON.stringify(successor.body));
    assert.equal(successor.body.user.role, 'team_leader');
    assert.equal(successor.body.user.unitName, 'צוות בדיקה ה');
    assert.equal(successor.body.user.managerId, sectorEId);
  });

  test('משתמש יכול לבטל בקשת העברה שהוא עצמו ביקש', async () => {
    const teamGId = seedUser({
      companyId: '5000017',
      firstName: 'עומרי',
      lastName: 'טל',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקה ח',
      managerId: divisionId,
    });
    const soldierDId = seedUser({
      companyId: '5000018',
      firstName: 'שירן',
      lastName: 'כץ',
      gender: 'female',
      role: 'employee',
      managerId: teamGId,
    });

    const teamGToken = await login('5000017');
    const requested = await api('POST', `/api/users/${soldierDId}/move`, {
      token: teamGToken,
      body: { toManagerId: teamLeaderId },
    });
    assert.equal(requested.body.applied, false);

    const withdrawn = await api('DELETE', `/api/users/${soldierDId}/move`, { token: teamGToken });
    assert.equal(withdrawn.status, 200);

    const teamLeaderToken = await login('1000004');
    const pendingList = await api('GET', '/api/users/moves/pending', { token: teamLeaderToken });
    assert.ok(!pendingList.body.pending.some((entry: any) => entry.user.id === soldierDId));
  });

  describe('רכב פרטי לעומת אוטובוס', () => {
    let carTripId = 0;
    let carCycleId = 0;

    before(async () => {
      const toToken = await login('1000001');
      const created = await api('POST', '/api/trips', {
        token: toToken,
        body: { name: 'גלישה', launchDate: '2026-10-01', leaderIds: [divisionId], cycles: [{ exitDate: '2026-10-08' }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      carTripId = created.body.trip.id;
      carCycleId = created.body.trip.cycles[0].id;

      // הרת״ח משבץ את כל השרשרת שלו: את עצמו, הרמ״ד, הר״צ ושני חיילים.
      const divisionToken = await login('1000002');
      const signed = await api('POST', `/api/trips/${carTripId}/signups`, {
        token: divisionToken,
        body: { cycleId: carCycleId, userIds: [divisionId, sectorId, teamLeaderId, soldierIds[0], soldierIds[1]] },
      });
      assert.equal(signed.status, 201, JSON.stringify(signed.body));
      assert.equal(signed.body.added, 5);

      await toApproveTrip(carTripId, toToken);
    });

    test('רת״ח תמיד מגיע ברכב הפרטי שלו - אי אפשר לבקש עבורו, והוא מוחרג מהאוטובוס אוטומטית', async () => {
      const divisionToken = await login('1000002');

      const attempt = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: divisionToken,
        body: { wantsCar: true },
      });
      assert.equal(attempt.status, 400);
      assert.match(attempt.body.error, /תמיד מגיעים ברכב הפרטי שלהם/);

      // גם בלי אף בקשה - רת״ח לא צריך מקום באוטובוס, כי זו עובדה קבועה בתפקיד.
      const toToken = await login('1000001');
      const preview = await api('GET', `/api/trips/${carTripId}/buses/preview`, { token: toToken });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.ok(preview.body.cycles[0].carCount >= 1, 'הרת״ח לא הוחרג מהספירה');
    });

    test('מפמ״ר מוחרג מהאוטובוס אוטומטית, בדיוק כמו רת״ח', async () => {
      // מפמ״ר אינו חלק מהשרשרת של רת״ח הגלישה הזאת, אז משבצים אותו ישירות במסד -
      // הטסט הזה בודק רק את ההחרגה מהאוטובוס, לא את הרשאת השיבוץ.
      const ceoSignup = db
        .prepare(
          `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now')) RETURNING id`,
        )
        .get(carTripId, carCycleId, ceoId) as { id: number };

      const toToken = await login('1000001');
      const before = await api('GET', `/api/trips/${carTripId}/buses/preview`, { token: toToken });
      const withoutCeo = before.body.cycles[0].carCount;

      db.prepare('DELETE FROM signups WHERE id = ?').run(ceoSignup.id);
      const after = await api('GET', `/api/trips/${carTripId}/buses/preview`, { token: toToken });
      assert.equal(after.body.cycles[0].carCount, withoutCeo - 1, 'המפמ״ר לא הוחרג מהספירה');
    });

    test('רמ״ד מבקש רכב עם נוסע וממתין לאישור הרת״ח - ההעדפה היא שכולם יגיעו באוטובוס', async () => {
      const sectorToken = await login('1000003');

      const sectorCar = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: sectorToken,
        body: { wantsCar: true, carPassengerId: teamLeaderId },
      });
      assert.equal(sectorCar.status, 200, JSON.stringify(sectorCar.body));
      assert.equal(sectorCar.body.signup.carStatus, 'pending');
      assert.equal(sectorCar.body.signup.carPassenger.id, teamLeaderId);

      // חייל אחר לא יכול לבחור נוסע שכבר ביקש רכב בעצמו (הרמ״ד).
      const soldierToken = await login('2000001');
      const takenByDriver = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: soldierToken,
        body: { wantsCar: true, carPassengerId: sectorId },
      });
      assert.equal(takenByDriver.status, 400);
      assert.match(takenByDriver.body.error, /כבר ביקש רכב בעצמו/);

      // וגם לא מי שכבר נוסע ברכב של מישהו אחר (הר״צ אצל הרמ״ד).
      const takenAsPassenger = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: soldierToken,
        body: { wantsCar: true, carPassengerId: teamLeaderId },
      });
      assert.equal(takenAsPassenger.status, 400);
      assert.match(takenAsPassenger.body.error, /רשום ברכב של מישהו אחר/);

      // ולא את עצמו.
      const selfPassenger = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: soldierToken,
        body: { wantsCar: true, carPassengerId: soldierIds[0] },
      });
      assert.equal(selfPassenger.status, 400);
      assert.match(selfPassenger.body.error, /לבחור את עצמך/);

      // הרת״ח מאשר את בקשת הרמ״ד.
      const divisionToken = await login('1000002');
      const approvedSector = await api(
        'POST',
        `/api/trips/${carTripId}/car-requests/${sectorCar.body.signup.id}/approve`,
        { token: divisionToken },
      );
      assert.equal(approvedSector.status, 200, JSON.stringify(approvedSector.body));
      assert.equal(approvedSector.body.signup.carStatus, 'approved');
    });

    test('בקשת רכב של חייל ממתינה לאישור רת״ח, ורק רת״ח או אופרטיבי יכולים להחליט', async () => {
      const soldierToken = await login('2000001');
      const requested = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: soldierToken,
        body: { wantsCar: true },
      });
      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      assert.equal(requested.body.signup.carStatus, 'pending');
      const signupId = requested.body.signup.id;

      // הרמ״ד רואה את הבקשה אבל אינו רשאי להחליט עליה - רק רת״ח בשרשרת או אופרטיבי.
      const sectorToken = await login('1000003');
      const deniedDecision = await api('POST', `/api/trips/${carTripId}/car-requests/${signupId}/approve`, {
        token: sectorToken,
      });
      assert.equal(deniedDecision.status, 403);

      const divisionToken = await login('1000002');
      const pendingForDivision = await api('GET', `/api/trips/${carTripId}/car-requests`, { token: divisionToken });
      assert.equal(pendingForDivision.status, 200);
      assert.ok(pendingForDivision.body.requests.some((entry: any) => entry.id === signupId));

      const approved = await api('POST', `/api/trips/${carTripId}/car-requests/${signupId}/approve`, {
        token: divisionToken,
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.signup.carStatus, 'approved');

      const notified = await api('GET', '/api/notifications', { token: soldierToken });
      assert.ok(
        notified.body.notifications.some((entry: any) => entry.kind === 'car_request_approved'),
        'החייל לא קיבל התראה על אישור בקשת הרכב',
      );

      // בקשה נוספת, הפעם נדחית.
      const anotherToken = await login('2000002');
      const anotherRequest = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: anotherToken,
        body: { wantsCar: true },
      });
      assert.equal(anotherRequest.body.signup.carStatus, 'pending');

      const rejected = await api('POST', `/api/trips/${carTripId}/car-requests/${anotherRequest.body.signup.id}/reject`, {
        token: divisionToken,
        body: { note: 'אין מקום' },
      });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.signup.carStatus, 'rejected');

      const stillPending = await api('GET', `/api/trips/${carTripId}/car-requests`, { token: divisionToken });
      assert.ok(!stillPending.body.requests.some((entry: any) => entry.id === signupId));
    });

    test('גם האופרטיבי צריך לבקש ולקבל אישור - אין לו יותר מעמד מיוחד', async () => {
      // האופרטיבי אינו רשום לגלישה הזאת (leaderIds=[divisionId] בלבד), אז משבצים אותו
      // ישירות במסד - הטסט בודק רק את הרשאת הרכב, לא את הרשאת השיבוץ.
      const toSignup = db
        .prepare(
          `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now')) RETURNING id`,
        )
        .get(carTripId, carCycleId, toId) as { id: number };

      const toToken = await login('1000001');
      const toCar = await api('PATCH', `/api/trips/${carTripId}/my-signup`, {
        token: toToken,
        body: { wantsCar: true },
      });
      assert.equal(toCar.status, 200, JSON.stringify(toCar.body));
      assert.equal(toCar.body.signup.carStatus, 'pending');

      // אין רת״ח בשרשרת שלו, אז האופרטיבי עצמו הוא הכתובת לאישור - ורואה את הבקשה.
      const ownRequest = await api('GET', `/api/trips/${carTripId}/car-requests`, { token: toToken });
      assert.ok(ownRequest.body.requests.some((entry: any) => entry.id === toCar.body.signup.id));

      const selfApproved = await api(
        'POST',
        `/api/trips/${carTripId}/car-requests/${toCar.body.signup.id}/approve`,
        { token: toToken },
      );
      assert.equal(selfApproved.status, 200, JSON.stringify(selfApproved.body));
      assert.equal(selfApproved.body.signup.carStatus, 'approved');

      // מוסר כדי לא להשפיע על ספירת הרכבים בטסט הבא.
      db.prepare('DELETE FROM signups WHERE id = ?').run(toSignup.id);
    });

    test('שיבוץ האוטובוסים מחריג נהגים ונוסעים ברכב פרטי מאושר מהספירה', async () => {
      const toToken = await login('1000001');

      // מהחמישה ששובצו לפעימה: הרת״ח מוחרג אוטומטית (נהג), הרמ״ד (נהג) והר״צ
      // (נוסע אצלו) אושרו בטסט הקודם, וחייל אחד אושר גם הוא - כל אלה מהטסטים
      // הקודמים. נשאר רק חייל אחד (שבקשתו נדחתה) שנוסע באוטובוס.
      const preview = await api('GET', `/api/trips/${carTripId}/buses/preview`, { token: toToken });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const cycle = preview.body.cycles[0];
      assert.equal(cycle.carCount, 4, 'מספר נוסעי הרכב הפרטי שגוי');
      assert.equal(cycle.result.totalParticipants, 1, 'מי שנוסע ברכב פרטי לא הוחרג מהאוטובוס');

      const locked = await api('POST', `/api/trips/${carTripId}/buses/lock`, { token: toToken, body: {} });
      assert.equal(locked.status, 200, JSON.stringify(locked.body));

      const list = await api('GET', `/api/trips/${carTripId}/buses`, { token: toToken });
      assert.equal(list.body.cycles[0].carCount, 4);
      assert.equal(list.body.cycles[0].totalParticipants, 1);
      const busRiderIds = list.body.cycles[0].buses.flatMap((bus: any) => bus.members.map((m: any) => m.userId));
      assert.deepEqual(busRiderIds, [soldierIds[1]]);
    });
  });

  describe('פתיחה מחדש של גלישה סגורה', () => {
    test('סגירה ופתיחה מחדש של גלישה שהוגשה מבטלות את ההגשה, ואפשר שוב להוסיף אנשים', async () => {
      const toToken = await login('1000001');
      const divisionToken = await login('1000002');

      const created = await api('POST', '/api/trips', {
        token: toToken,
        body: { name: 'גלישה', launchDate: '2026-11-01', leaderIds: [divisionId], cycles: [{ exitDate: '2026-11-08' }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const reopenTripId = created.body.trip.id;
      const reopenCycleId = created.body.trip.cycles[0].id;

      const signed = await api('POST', `/api/trips/${reopenTripId}/signups`, {
        token: divisionToken,
        body: { cycleId: reopenCycleId, userIds: [divisionId] },
      });
      assert.equal(signed.status, 201, JSON.stringify(signed.body));

      const submitted = await api('POST', `/api/trips/${reopenTripId}/submit`, { token: toToken, body: {} });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

      const closed = await api('PATCH', `/api/trips/${reopenTripId}`, {
        token: toToken,
        body: { state: 'CLOSED' },
      });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body.trip.state, 'CLOSED');

      const reopened = await api('PATCH', `/api/trips/${reopenTripId}`, {
        token: toToken,
        body: { state: 'LAUNCHED' },
      });
      assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
      assert.equal(reopened.body.trip.state, 'LAUNCHED');
      // התיקון: פתיחה מחדש מבטלת גם את ההגשה - אחרת assertRosterOpen עדיין חוסם הוספה.
      assert.equal(reopened.body.trip.submitted, false, 'ההגשה לא בוטלה בפתיחה מחדש של הגלישה');

      const added = await api('POST', `/api/trips/${reopenTripId}/signups`, {
        token: divisionToken,
        body: { cycleId: reopenCycleId, userIds: [sectorId] },
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.added, 1, 'אי אפשר להוסיף אנשים אחרי פתיחה מחדש - הבאג לא תוקן');
    });
  });

  describe('לינה - אף אחד לא נשאר בלי מיטה', () => {
    test('נעילת לינה עם מבנים קטנים מדי פותחת עוד חדרים אוטומטית, ולא משאירה אף אחד בלי מיטה', async () => {
      const toToken = await login('1000001');
      const sectorToken = await login('1000003');

      const extraIds = Array.from({ length: 5 }, (_, index) =>
        seedUser({
          companyId: `610${String(index).padStart(4, '0')}`,
          firstName: `נוסף${index}`,
          lastName: 'בדיקתמיטות',
          gender: 'male',
          role: 'employee',
          managerId: teamLeaderId,
        }),
      );

      const created = await api('POST', '/api/trips', {
        token: toToken,
        body: { name: 'גלישה', launchDate: '2026-11-15', leaderIds: [sectorId], cycles: [{ exitDate: '2026-11-20' }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const bedTripId = created.body.trip.id;
      const bedCycleId = created.body.trip.cycles[0].id;

      const signed = await api('POST', `/api/trips/${bedTripId}/signups`, {
        token: sectorToken,
        body: { cycleId: bedCycleId, userIds: extraIds },
      });
      assert.equal(signed.status, 201, JSON.stringify(signed.body));
      assert.equal(signed.body.added, 5);
      await toApproveTrip(bedTripId, toToken);

      // מבנה קטן בכוונה - רק 2 מיטות עבור 5 אנשים.
      const structure = await api('POST', `/api/trips/${bedTripId}/structures`, {
        token: toToken,
        body: { name: 'מבנה קטן', gender: 'male', rooms: [{ name: '1', beds: 2 }] },
      });
      assert.equal(structure.status, 201, JSON.stringify(structure.body));

      const locked = await api('POST', `/api/trips/${bedTripId}/dorms/lock`, { token: toToken, body: {} });
      assert.equal(locked.status, 200, JSON.stringify(locked.body));
      assert.ok(locked.body.roomsAdded >= 1, 'לא נפתחו חדרים נוספים כשהמבנים לא הספיקו');

      const dorms = await api('GET', `/api/trips/${bedTripId}/dorms`, { token: toToken });
      const placedIds = dorms.body.cycles[0].rooms.flatMap((room: any) => room.members.map((m: any) => m.userId));
      for (const id of extraIds) {
        assert.ok(placedIds.includes(id), `${id} נשאר בלי מיטה למרות פתיחת חדרים נוספים`);
      }

      const issues = await api('GET', `/api/trips/${bedTripId}/dorm-issues`, { token: toToken });
      assert.ok(
        !issues.body.issues.some((issue: any) => issue.kind === 'unassigned'),
        'עדיין נפתחה בעיית "לא שובץ" למרות שנפתחו חדרים נוספים',
      );
    });
  });

  describe('בקשת רכב פרטי לכמה אנשים בבת אחת', () => {
    test('רמ״ד מבקש רכב עבור כמה מהאנשים שלו, והבקשות ממתינות לאישור הרת״ח', async () => {
      const toToken = await login('1000001');
      const sectorToken = await login('1000003');
      const divisionToken = await login('1000002');

      const created = await api('POST', '/api/trips', {
        token: toToken,
        body: { name: 'גלישה', launchDate: '2026-11-22', leaderIds: [sectorId], cycles: [{ exitDate: '2026-11-29' }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const bulkTripId = created.body.trip.id;
      const bulkCycleId = created.body.trip.cycles[0].id;

      const signed = await api('POST', `/api/trips/${bulkTripId}/signups`, {
        token: sectorToken,
        body: { cycleId: bulkCycleId, userIds: [teamLeaderId, soldierIds[0], soldierIds[1]] },
      });
      assert.equal(signed.status, 201, JSON.stringify(signed.body));

      // divisionId אינו כפוף לרמ״ד (להפך) - אמור להידלג עם הסבר.
      const bulk = await api('POST', `/api/trips/${bulkTripId}/car-requests/bulk`, {
        token: sectorToken,
        body: { userIds: [soldierIds[0], soldierIds[1], divisionId] },
      });
      assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
      assert.equal(bulk.body.requested, 2);
      assert.equal(bulk.body.skipped.length, 1);
      assert.match(bulk.body.skipped[0].reason, /אינו כפוף לך/);

      const first = db
        .prepare('SELECT car_status FROM signups WHERE trip_id = ? AND user_id = ?')
        .get(bulkTripId, soldierIds[0]!) as { car_status: string };
      const second = db
        .prepare('SELECT car_status FROM signups WHERE trip_id = ? AND user_id = ?')
        .get(bulkTripId, soldierIds[1]!) as { car_status: string };
      assert.equal(first.car_status, 'pending');
      assert.equal(second.car_status, 'pending');

      // הרת״ח, שהוא המאשר בשרשרת שלהם, קיבל התראה אחת על הבקשות.
      const inbox = await api('GET', '/api/notifications', { token: divisionToken });
      assert.ok(
        inbox.body.notifications.some((entry: any) => entry.kind === 'car_request_pending'),
        'הרת״ח לא קיבל התראה על בקשות הרכב',
      );

      // בקשה שוב עבור אותו אדם - מדולגת, כי הבקשה כבר ממתינה.
      const again = await api('POST', `/api/trips/${bulkTripId}/car-requests/bulk`, {
        token: sectorToken,
        body: { userIds: [soldierIds[0]] },
      });
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.equal(again.body.requested, 0);
      assert.match(again.body.skipped[0].reason, /כבר ביקש רכב/);
    });
  });

  describe('מספר רכב בפרופיל - כל תפקיד', () => {
    test('כל משתמש מאושר יכול לעדכן מספר רכב בפרופיל', async () => {
      const divisionToken = await login('1000002');

      const tooShort = await api('PUT', '/api/users/me/car-plate', { token: divisionToken, body: { carPlate: '123456' } });
      assert.equal(tooShort.status, 400);

      const withLetters = await api('PUT', '/api/users/me/car-plate', {
        token: divisionToken,
        body: { carPlate: '123abc4' },
      });
      assert.equal(withLetters.status, 400);

      const eightDigits = await api('PUT', '/api/users/me/car-plate', {
        token: divisionToken,
        body: { carPlate: '12345678' },
      });
      assert.equal(eightDigits.status, 200, JSON.stringify(eightDigits.body));
      assert.equal(eightDigits.body.carPlate, '12345678');

      const me = await api('GET', '/api/auth/me', { token: divisionToken });
      assert.equal(me.body.user.carPlate, '12345678');

      // רמ״ד אינו רת״ח או מפמ״ר, אבל גם הוא יכול לשמור מספר רכב - זה פרט מידע
      // לשימוש בבקשת רכב לכל גלישה, לא רק לבעלי "הגעה קבועה ברכב פרטי".
      const sectorToken = await login('1000003');
      const allowed = await api('PUT', '/api/users/me/car-plate', { token: sectorToken, body: { carPlate: '1234567' } });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      assert.equal(allowed.body.carPlate, '1234567');
    });
  });

  describe('חיילים-לשעבר: מושאלים (הצ״ח) ומילואים', () => {
    test('ר״צ מוסיף חייל מושאל, מאושר מיד וכפוף אליו ישירות', async () => {
      const teamLeaderToken = await login('1000004');

      const missingOrigin = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900001',
          firstName: 'רון',
          lastName: 'מזרחי',
          gender: 'male',
          diet: 'all',
          workerType: 'borrowed',
          borrowedMission: 'תגבור לפרויקט X עד סוף החודש',
        },
      });
      assert.equal(missingOrigin.status, 400, JSON.stringify(missingOrigin.body));

      const missingMission = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900001',
          firstName: 'רון',
          lastName: 'מזרחי',
          gender: 'male',
          diet: 'all',
          workerType: 'borrowed',
          borrowedFrom: 'מדור תשתיות',
        },
      });
      assert.equal(missingMission.status, 400, JSON.stringify(missingMission.body));

      const created = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900001',
          firstName: 'רון',
          lastName: 'מזרחי',
          gender: 'male',
          diet: 'all',
          workerType: 'borrowed',
          borrowedFrom: 'מדור תשתיות',
          borrowedMission: 'תגבור לפרויקט X עד סוף החודש',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.user.status, 'approved');
      assert.equal(created.body.user.workerType, 'borrowed');
      assert.equal(created.body.user.borrowedFrom, 'מדור תשתיות');
      assert.equal(created.body.user.borrowedMission, 'תגבור לפרויקט X עד סוף החודש');
      assert.equal(created.body.user.managerId, teamLeaderId);

      const dup = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900001',
          firstName: 'רון',
          lastName: 'מזרחי',
          gender: 'male',
          diet: 'all',
          workerType: 'reserve',
        },
      });
      assert.equal(dup.status, 409);

      const team = await api('GET', '/api/users/my-team', { token: teamLeaderToken });
      const inTeam = team.body.team.find((member: any) => member.companyId === '5900001');
      assert.ok(inTeam, 'החייל המושאל לא מופיע בצוות של הר״צ');
      assert.equal(inTeam.workerType, 'borrowed');
    });

    test('איש מילואים אינו דורש מקור, ורק מפקד יכול להוסיף חייל-לשעבר', async () => {
      const teamLeaderToken = await login('1000004');
      const soldierToken = await login('2000001');

      const denied = await api('POST', '/api/users/ex-workers', {
        token: soldierToken,
        body: {
          companyId: '5900002',
          firstName: 'טל',
          lastName: 'ברק',
          gender: 'female',
          diet: 'all',
          workerType: 'reserve',
        },
      });
      assert.equal(denied.status, 403);

      const reserve = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900002',
          firstName: 'טל',
          lastName: 'ברק',
          gender: 'female',
          diet: 'all',
          workerType: 'reserve',
        },
      });
      assert.equal(reserve.status, 201, JSON.stringify(reserve.body));
      assert.equal(reserve.body.user.workerType, 'reserve');
      assert.equal(reserve.body.user.borrowedFrom, null);
      assert.equal(reserve.body.user.borrowedMission, null);
    });

    test('ייצוא ה-Excel של הגלישה כולל מעמד, וגיליונות הצחים/רכבים/לינה/תורנויות', async () => {
      const teamLeaderToken = await login('1000004');
      const toToken = await login('1000001');

      const borrowed = await api('POST', '/api/users/ex-workers', {
        token: teamLeaderToken,
        body: {
          companyId: '5900003',
          firstName: 'גל',
          lastName: 'שרון',
          gender: 'male',
          diet: 'all',
          workerType: 'borrowed',
          borrowedFrom: 'מדור תשתיות',
          borrowedMission: 'תגבור לפרויקט Y עד סוף הרבעון',
        },
      });
      assert.equal(borrowed.status, 201, JSON.stringify(borrowed.body));
      const borrowedId = borrowed.body.user.id as number;

      const trip = db
        .prepare(
          `INSERT INTO trips (name, launch_date, created_by) VALUES ('גלישת ייצוא', '2026-11-01', ?) RETURNING id`,
        )
        .get(toId) as { id: number };
      const cycle = db
        .prepare(`INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, 'חלוץ', '2026-11-05') RETURNING id`)
        .get(trip.id) as { id: number };

      const insertSignup = db.prepare(
        `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now')) RETURNING id`,
      );
      insertSignup.run(trip.id, cycle.id, soldierIds[0]!);
      insertSignup.run(trip.id, cycle.id, borrowedId);

      // רכב: חייל אחד נוהג, מסיע חייל אחר - ראו lib/cars.ts (נהג ונוסע אחד לכל היותר).
      const driverSignup = insertSignup.get(trip.id, cycle.id, soldierIds[2]!) as { id: number };
      insertSignup.run(trip.id, cycle.id, soldierIds[3]!);
      db.prepare('UPDATE users SET car_plate = ? WHERE id = ?').run('1234567', soldierIds[2]!);
      db.prepare(`UPDATE signups SET car_status = 'approved', car_passenger_id = ? WHERE id = ?`).run(
        soldierIds[3]!,
        driverSignup.id,
      );

      // לינה: חדר עם שני דיירים, אחרי "נעילת" שיבוץ מדומה (הכנסה ישירה ל-room_assignments).
      const structure = db
        .prepare(`INSERT INTO structures (trip_id, name, gender) VALUES (?, 'מבנה א׳', 'male') RETURNING id`)
        .get(trip.id) as { id: number };
      const room = db
        .prepare(`INSERT INTO rooms (structure_id, name, beds) VALUES (?, '101', 4) RETURNING id`)
        .get(structure.id) as { id: number };
      const insertRoomAssignment = db.prepare(
        `INSERT INTO room_assignments (trip_id, cycle_id, room_id, user_id) VALUES (?, ?, ?, ?)`,
      );
      insertRoomAssignment.run(trip.id, cycle.id, room.id, soldierIds[2]!);
      insertRoomAssignment.run(trip.id, cycle.id, room.id, soldierIds[3]!);

      // תורנות: דיווח מלא, כולל סטאטוס טיפול (מנוהל בנפרד על ידי האופרטיבי - PATCH handling-status).
      db.prepare(
        `INSERT INTO shift_reports
           (trip_id, user_id, reported_by, has_shift, details, duty_type, duty_location, duty_dates, handling_status)
         VALUES (?, ?, ?, 1, 'משמרת שמירה', 'רס״ר', 'גלילות', '2.8', 'תואם מול המדור')`,
      ).run(trip.id, soldierIds[2]!, teamLeaderId);

      const response = await fetch(`${baseUrl}/api/trips/${trip.id}/export.xlsx`, {
        headers: { authorization: `Bearer ${toToken}` },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /spreadsheetml/);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.arrayBuffer());

      /** משטיח גיליון לטקסט מופרד בפסיקים/שורות, בלי להיצמד למבנה התאים המדויק. */
      const flatten = (sheet: ExcelJS.Worksheet): string => {
        const lines: string[] = [];
        sheet.eachRow((row) => {
          const values: string[] = [];
          row.eachCell({ includeEmpty: false }, (cell) => {
            if (cell.type === ExcelJS.ValueType.Merge) return;
            if (cell.value != null && cell.value !== '') values.push(String(cell.value));
          });
          if (values.length > 0) lines.push(values.join(','));
        });
        return lines.join('\n');
      };

      const mainSheet = workbook.getWorksheet('רשימת משתתפים');
      assert.ok(mainSheet, 'הגיליון הראשי לא נמצא');
      const mainText = flatten(mainSheet!);
      assert.match(mainText, /,רגיל,/, 'החייל הרגיל אמור להופיע עם מעמד רגיל');
      assert.match(mainText, /,הצח,/, 'החייל המושאל אמור להופיע עם מעמד הצח');

      const borrowedSheet = workbook.getWorksheet('הצחים');
      assert.ok(borrowedSheet, 'גיליון ההצחים לא נוצר');
      const borrowedText = flatten(borrowedSheet!);
      assert.match(borrowedText, /גל שרון/, 'שם החייל המושאל');
      assert.match(borrowedText, /מדור תשתיות/, 'מאיפה הושאל');
      assert.match(borrowedText, /צוות אלון/, 'לאן ההצח - הצוות שאליו הצטרף');
      assert.match(borrowedText, /תגבור לפרויקט Y עד סוף הרבעון/, 'המשימה');
      assert.match(borrowedText, /אבי שגב/, 'הרת״ח האחראי - הקרוב ביותר בשרשרת');

      const carsSheet = workbook.getWorksheet('רכבים');
      assert.ok(carsSheet, 'גיליון הרכבים לא נוצר');
      const carsText = flatten(carsSheet!);
      assert.match(carsText, /נועם פרץ/, 'שם הנהג');
      assert.match(carsText, /1234567/, 'מספר הרכב');
      assert.match(carsText, /אורי גולן/, 'שם הנוסע');

      const dormsSheet = workbook.getWorksheet('לינה');
      assert.ok(dormsSheet, 'גיליון הלינה לא נוצר');
      const dormsText = flatten(dormsSheet!);
      assert.match(dormsText, /מבנה א׳/, 'שם המבנה');
      assert.match(dormsText, /101/, 'שם החדר');
      assert.match(dormsText, /נועם פרץ/, 'דייר ראשון');
      assert.match(dormsText, /אורי גולן/, 'דייר שני');

      const dutySheet = workbook.getWorksheet('תורנויות');
      assert.ok(dutySheet, 'גיליון התורנויות לא נוצר');
      const dutyText = flatten(dutySheet!);
      assert.match(dutyText, /נועם פרץ/, 'שם החייל');
      assert.match(dutyText, /מדור תוכנה/, 'המדור');
      assert.match(dutyText, /רס״ר/, 'סוג התורנות');
      assert.match(dutyText, /גלילות/, 'המיקום');
      assert.match(dutyText, /תואם מול המדור/, 'סטאטוס הטיפול');

      // עדכון סטאטוס הטיפול - אופרטיבי בלבד, נפרד מ-PUT הדיווח הרגיל.
      const patched = await api('PATCH', `/api/trips/${trip.id}/shift-reports/${soldierIds[2]}/handling-status`, {
        token: toToken,
        body: { handlingStatus: 'סוכם לביטול' },
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.handlingStatus, 'סוכם לביטול');

      const deniedPatch = await api(
        'PATCH',
        `/api/trips/${trip.id}/shift-reports/${soldierIds[2]}/handling-status`,
        { token: teamLeaderToken, body: { handlingStatus: 'לא אמור לעבוד' } },
      );
      assert.equal(deniedPatch.status, 403, 'רק אופרטיבי יכול לעדכן סטאטוס טיפול');

      db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    });
  });

  describe('דיווח על ביטול משמרות', () => {
    test('ר״צ מדווח על עצמו ועל חייל ישיר, והאופרטיבי רואה רק את מי שיש לו משמרת', async () => {
      const toToken = await login('1000001');
      const teamLeaderToken = await login('1000004');
      const sectorToken = await login('1000003');

      const created = await api('POST', '/api/trips', {
        token: toToken,
        body: { name: 'גלישה', launchDate: '2026-12-01', leaderIds: [sectorId], cycles: [{ exitDate: '2026-12-08' }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const shiftTripId = created.body.trip.id;

      // עוד לפני שדווח על אף אחד - כולם מופיעים עם has_shift=false. הצוות
      // עצמו לא נבדק במספר מדויק (טסטים קודמים בקובץ יכלו להוסיף לו כפיפים
      // נוספים - למשל החיילים-לשעבר שנוספו למעלה), אלא שהחיילים המקוריים
      // ועצמו בהחלט מופיעים.
      const mineEmpty = await api('GET', `/api/trips/${shiftTripId}/shift-reports/mine`, { token: teamLeaderToken });
      assert.equal(mineEmpty.status, 200, JSON.stringify(mineEmpty.body));
      assert.ok(mineEmpty.body.subjects.every((subject: any) => subject.hasShift === false));
      const mineIds = mineEmpty.body.subjects.map((subject: any) => subject.userId);
      assert.ok(mineIds.includes(teamLeaderId), 'הר״צ עצמו חסר מהרשימה');
      for (const soldierId of soldierIds) {
        assert.ok(mineIds.includes(soldierId), `חייל ${soldierId} חסר מהרשימה`);
      }
      assert.equal(mineEmpty.body.subjects.find((subject: any) => subject.isSelf).userId, teamLeaderId);

      // דיווח עם משמרת בלי פרטים - נדחה.
      const missingDetails = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${soldierIds[0]}`, {
        token: teamLeaderToken,
        body: { hasShift: true },
      });
      assert.equal(missingDetails.status, 400);

      // דיווח על חייל ישיר, ועל עצמו.
      const forSoldier = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${soldierIds[0]}`, {
        token: teamLeaderToken,
        body: { hasShift: true, details: 'משמרת שמירה' },
      });
      assert.equal(forSoldier.status, 200, JSON.stringify(forSoldier.body));
      assert.equal(forSoldier.body.hasShift, true);
      assert.equal(forSoldier.body.details, 'משמרת שמירה');

      const forSelf = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${teamLeaderId}`, {
        token: teamLeaderToken,
        body: { hasShift: true, details: 'תורנות מטבח' },
      });
      assert.equal(forSelf.status, 200, JSON.stringify(forSelf.body));

      // אי אפשר לדווח על מי שאינו כפוף ישירות - למשל חייל של צוות אחר.
      const notMine = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${toSoldierIds[0]}`, {
        token: teamLeaderToken,
        body: { hasShift: true, details: 'לא רלוונטי' },
      });
      assert.equal(notMine.status, 403);

      // מי שאינו ר״צ אינו יכול לדווח בכלל, גם על עצמו.
      const notTeamLeader = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${sectorId}`, {
        token: sectorToken,
        body: { hasShift: true, details: 'לא רלוונטי' },
      });
      assert.equal(notTeamLeader.status, 403);
      const notTeamLeaderMine = await api('GET', `/api/trips/${shiftTripId}/shift-reports/mine`, {
        token: sectorToken,
      });
      assert.equal(notTeamLeaderMine.status, 403);

      // האופרטיבי רואה רק את שני הדיווחים עם משמרת בפועל.
      const summary = await api('GET', `/api/trips/${shiftTripId}/shift-reports`, { token: toToken });
      assert.equal(summary.status, 200, JSON.stringify(summary.body));
      assert.equal(summary.body.reports.length, 2);
      const ids = summary.body.reports.map((report: any) => report.userId).sort();
      assert.deepEqual(ids, [teamLeaderId, soldierIds[0]].sort());

      // רק אופרטיבי רואה את הסיכום המלא.
      const deniedSummary = await api('GET', `/api/trips/${shiftTripId}/shift-reports`, { token: teamLeaderToken });
      assert.equal(deniedSummary.status, 403);

      // ביטול הדיווח (has_shift=false) מנקה את הפרטים ומוציא מהסיכום.
      const cleared = await api('PUT', `/api/trips/${shiftTripId}/shift-reports/${soldierIds[0]}`, {
        token: teamLeaderToken,
        body: { hasShift: false },
      });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body.hasShift, false);
      assert.equal(cleared.body.details, null);

      const summaryAfter = await api('GET', `/api/trips/${shiftTripId}/shift-reports`, { token: toToken });
      assert.equal(summaryAfter.body.reports.length, 1);
      assert.equal(summaryAfter.body.reports[0].userId, teamLeaderId);
    });
  });

  test('העדפות הפרופיל מזינות את שיבוץ הלינה, והבחירה לגלישה מסוימת גוברת עליהן', async () => {
    const [first, second, third] = [soldierIds[0]!, soldierIds[1]!, soldierIds[2]!];

    // תרחיש עצמאי: גלישה ופעימה משלו, כדי לא להסתמך על מצב של טסטים אחרים.
    const trip = db
      .prepare(
        `INSERT INTO trips (name, launch_date, created_by) VALUES ('גלישת העדפות', '2026-09-01', ?) RETURNING id`,
      )
      .get(toId) as { id: number };
    const cycle = db
      .prepare(`INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, 'חלוץ', '2026-09-05') RETURNING id`)
      .get(trip.id) as { id: number };

    const insertSignup = db.prepare(
      `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now')) RETURNING id`,
    );
    const signupA = insertSignup.get(trip.id, cycle.id, first) as { id: number };
    insertSignup.run(trip.id, cycle.id, second);
    insertSignup.run(trip.id, cycle.id, third);

    // אין העדפות לגלישה הזאת - רק העדפה קבועה מהפרופיל.
    const token = await login('2000001');
    await api('PUT', '/api/users/me/roommate-preferences', {
      token,
      body: { preferences: [second] },
    });

    const fromProfile = loadCycleParticipants(cycle.id).find((entry) => entry.userId === first);
    assert.deepEqual(fromProfile?.preferences, [second], 'העדפת הפרופיל לא הוזנה לשיבוץ כשאין בחירה לגלישה');

    // בחירה ספציפית לגלישה גוברת על העדפת הפרופיל.
    db.prepare('INSERT INTO dorm_preferences (signup_id, preferred_user_id, priority) VALUES (?, ?, 1)').run(
      signupA.id,
      third,
    );

    const fromTrip = loadCycleParticipants(cycle.id).find((entry) => entry.userId === first);
    assert.deepEqual(fromTrip?.preferences, [third], 'הבחירה לגלישה מסוימת לא גברה על העדפת הפרופיל');

    // מי שאין לו כלום נשאר בלי העדפות, ולא יורש מאחרים.
    const without = loadCycleParticipants(cycle.id).find((entry) => entry.userId === third);
    assert.deepEqual(without?.preferences, []);

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    await api('PUT', '/api/users/me/roommate-preferences', { token, body: { preferences: [] } });
  });

  test('רשימת ההסעות מדווחת מי מגיע ברכב פרטי, וסופרת נהג ונוסע', async () => {
    const [passengerId, otherSoldierId] = [soldierIds[0]!, soldierIds[1]!];

    const trip = db
      .prepare(
        `INSERT INTO trips (name, launch_date, created_by) VALUES ('גלישת רכבים', '2026-10-01', ?) RETURNING id`,
      )
      .get(toId) as { id: number };
    const cycle = db
      .prepare(`INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, 'חלוץ', '2026-10-05') RETURNING id`)
      .get(trip.id) as { id: number };

    const insertSignup = db.prepare(
      `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now')) RETURNING id`,
    );
    // הרמ״דית נוהגת ומצרפת חייל כנוסע; חייל נוסף מבקש רכב אבל טרם אושר.
    const driver = insertSignup.get(trip.id, cycle.id, sectorId) as { id: number };
    insertSignup.run(trip.id, cycle.id, passengerId);
    const pendingDriver = insertSignup.get(trip.id, cycle.id, otherSoldierId) as { id: number };

    db.prepare(`UPDATE signups SET car_status = 'approved', car_passenger_id = ? WHERE id = ?`).run(
      passengerId,
      driver.id,
    );
    db.prepare(`UPDATE signups SET car_status = 'pending' WHERE id = ?`).run(pendingDriver.id);

    const toToken = await login('1000001');
    const response = await api('GET', `/api/trips/${trip.id}/buses`, { token: toToken });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    // האוטובוסים עוד לא ננעלו, אבל הרכבים הפרטיים מדווחים בכל מקרה.
    assert.equal(response.body.locked, false);
    const cars = response.body.cars;
    assert.equal(cars.totalCars, 1, 'בקשת רכב שטרם אושרה נספרה כרכב');
    assert.equal(cars.totalPeople, 2, 'נהג ונוסע ביחד הם שני אנשים שאינם צריכים אוטובוס');
    assert.equal(cars.cycles.length, 1);
    assert.equal(cars.cycles[0].people, 2);
    assert.equal(cars.cycles[0].cars[0].driver.userId, sectorId);
    assert.equal(cars.cycles[0].cars[0].passenger.userId, passengerId);

    // רכב בלי נוסע נספר כאדם אחד.
    db.prepare(`UPDATE signups SET car_passenger_id = NULL WHERE id = ?`).run(driver.id);
    const soloResponse = await api('GET', `/api/trips/${trip.id}/buses`, { token: toToken });
    assert.equal(soloResponse.body.cars.totalPeople, 1);
    assert.equal(soloResponse.body.cars.cycles[0].cars[0].passenger, null);

    // מפקד שאין לו קשר לנוסעים לא רואה אותם.
    const otherLeaderToken = await login('1000006'); // ר״צ במדור האופרטיבי
    const scoped = await api('GET', `/api/trips/${trip.id}/buses`, { token: otherLeaderToken });
    assert.equal(scoped.body.cars.totalPeople, 0, 'מפקד רואה רכבים של אנשים שאינם שלו');

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
  });

  test('תוכנית לינה מוקדמת מציעה חדרים בגודל 4-8 בלי לדרוש מבני לינה קיימים', async () => {
    const trip = db
      .prepare(
        `INSERT INTO trips (name, launch_date, created_by) VALUES ('גלישת תוכנית לינה', '2026-11-01', ?) RETURNING id`,
      )
      .get(toId) as { id: number };
    const cycle = db
      .prepare(`INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, 'חלוץ', '2026-11-05') RETURNING id`)
      .get(trip.id) as { id: number };

    const insertSignup = db.prepare(
      `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now'))`,
    );
    // חמישה חיילים בנים - אין שום מבנה או חדר מוגדר לגלישה הזאת בכלל.
    for (const id of [soldierIds[0]!, soldierIds[1]!, soldierIds[2]!]) insertSignup.run(trip.id, cycle.id, id);

    const soldierToken = await login('2000001');
    const denied = await api('GET', `/api/trips/${trip.id}/dorms/plan`, { token: soldierToken });
    assert.equal(denied.status, 403, 'רק אופרטיבי אמור לגשת לתוכנית הלינה המוקדמת');

    const toToken = await login('1000001');
    const plan = await api('GET', `/api/trips/${trip.id}/dorms/plan`, { token: toToken });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.cycles.length, 1);
    const cyclePlan = plan.body.cycles[0].plan;
    assert.equal(cyclePlan.totalPeople, 3);
    assert.equal(cyclePlan.unassigned, 0);
    assert.ok(cyclePlan.totalRooms >= 1);
    for (const room of cyclePlan.rooms) {
      assert.ok(room.size >= 4 && room.size <= 8, `גודל חדר לא בטווח: ${room.size}`);
    }

    // אין מבני לינה אמיתיים לגלישה - התוכנית לא תלויה בהם.
    const structures = await api('GET', `/api/trips/${trip.id}/structures`, { token: toToken });
    assert.deepEqual(structures.body.structures, []);

    // ייצוא ה-Excel של אותה תוכנית - הבקשה שנמסרת בפועל לספק.
    const xlsxDenied = await fetch(`${baseUrl}/api/trips/${trip.id}/dorms/plan.xlsx`, {
      headers: { authorization: `Bearer ${soldierToken}` },
    });
    assert.equal(xlsxDenied.status, 403);

    const xlsxResponse = await fetch(`${baseUrl}/api/trips/${trip.id}/dorms/plan.xlsx`, {
      headers: { authorization: `Bearer ${toToken}` },
    });
    assert.equal(xlsxResponse.status, 200);
    assert.match(xlsxResponse.headers.get('content-type') ?? '', /spreadsheetml/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await xlsxResponse.arrayBuffer());
    const sheet = workbook.getWorksheet('בקשת לינה');
    assert.ok(sheet, 'הגיליון לא נמצא בקובץ');
    assert.equal(sheet!.views[0]?.rightToLeft, true, 'הגיליון אמור להיות RTL');

    // משטיחים כל שורה לא ריקה לטקסט מופרד בפסיקים, כדי לבדוק תוכן בלי
    // להיצמד למבנה התאים המדויק (מיזוגים, עיצוב וכו').
    const lines: string[] = [];
    sheet!.eachRow((row) => {
      const values: string[] = [];
      for (let col = 1; col <= 3; col += 1) {
        const cell = row.getCell(col);
        // תא שהוא חלק ממיזוג אבל אינו התא הראשי מחזיר את אותו הערך כמו
        // הראשי (type === Merge) - מדלגים עליו כדי לא לשכפל כותרות ממוזגות.
        if (cell.type === ExcelJS.ValueType.Merge) continue;
        if (cell.value != null && cell.value !== '') values.push(String(cell.value));
      }
      if (values.length > 0) lines.push(values.join(','));
    });
    const xlsxText = lines.join('\n');

    assert.match(xlsxText, /סיכום הבקשה לספק/);
    assert.match(xlsxText, /בנים,8,\d+/);
    // שלושת החיילים ששובצו הם מ"תחום פיתוח" (ראו seedUser של divisionId למעלה) -
    // טבלה נפרדת לכל תחום, כותרת בעמודה הראשונה ואז שורת מין/אנשים.
    assert.match(xlsxText, /^תחום פיתוח$/m);
    assert.match(xlsxText, /בנים,3/);
    // חדר מתוכנן אחד לפחות, עם שלושת השמות ותחום כל אחד מהם.
    assert.match(xlsxText, /חדרים מתוכננים - אותו חדר משמש כל פעימה בתורה/);
    assert.match(xlsxText, /חדר מתוכנן 1 · בנים · חיילים/);
    assert.match(xlsxText, /חלוץ · יציאה 2026-11-05/);
    assert.match(xlsxText, /מיטה,שם,תחום/);
    // שם החייל עצמו יכול להשתנות בטסטים קודמים בקובץ (עריכת פרופיל וכו') -
    // בודקים רק שהשורה מכילה מיטה, שם כלשהו ותחום פיתוח.
    assert.match(xlsxText, /^\d,.+,תחום פיתוח$/m);

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
  });

  test('תוכנית לינה מוקדמת חוסכת חדרים - פעימה קטנה נכנסת לחדר שכבר סופק, ורק חריגה מהשיא הכולל דורשת תוספת', async () => {
    const trip = db
      .prepare(
        `INSERT INTO trips (name, launch_date, created_by) VALUES ('גלישת חיסכון בחדרים', '2026-12-01', ?) RETURNING id`,
      )
      .get(toId) as { id: number };

    const makeCycle = (name: string, exitDate: string) =>
      db
        .prepare(`INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, ?, ?) RETURNING id`)
        .get(trip.id, name, exitDate) as { id: number };
    const cycleA = makeCycle('חלוץ', '2026-12-01');
    const cycleB = makeCycle('פעימה 1', '2026-12-03');
    const cycleC = makeCycle('פעימה 2', '2026-12-05');

    const insertSignup = db.prepare(
      `INSERT INTO signups (trip_id, cycle_id, user_id, diet, status, to_approved_at) VALUES (?, ?, ?, 'all', 'approved', datetime('now'))`,
    );

    let nextCompanyId = 5920001;
    const makeSoldiers = (count: number) =>
      Array.from({ length: count }, () => {
        const companyId = String(nextCompanyId++);
        return seedUser({
          companyId,
          firstName: `חייל${companyId}`,
          lastName: 'לדוגמה',
          gender: 'male',
          role: 'employee',
          managerId: teamLeaderId,
        });
      });

    // פעימה א׳ - 10 חיילים, זקוקה לשני חדרים (מקסימום 8 מיטות לחדר).
    for (const id of makeSoldiers(10)) insertSignup.run(trip.id, cycleA.id, id);
    // פעימה ב׳ - הרבה יותר קטנה, חדר אחד מספיק - אמורה להיכנס לחדר שכבר
    // סופק לפעימה א׳, ולא לדרוש שום דבר חדש.
    for (const id of makeSoldiers(2)) insertSignup.run(trip.id, cycleB.id, id);
    // פעימה ג׳ - גדולה מפעימה ב׳ שלפניה (זקוקה לשני חדרים בעצמה), אבל לא
    // גדולה מהשיא שכבר נראה (פעימה א׳) - גם היא לא אמורה לדרוש חדר נוסף.
    for (const id of makeSoldiers(9)) insertSignup.run(trip.id, cycleC.id, id);

    const toToken = await login('1000001');
    const plan = await api('GET', `/api/trips/${trip.id}/dorms/plan`, { token: toToken });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const [planA, planB, planC] = plan.body.cycles;

    assert.equal(planA.plan.totalRooms, 2, 'פעימה א׳: 10 חיילים דורשים שני חדרים');
    assert.equal(planA.extraRoomsNeeded, 2, 'הפעימה הראשונה - כל החדרים שלה חדשים, אין עוד מה להשוות אליו');

    assert.equal(planB.plan.totalRooms, 1, 'פעימה ב׳: שני חיילים בחדר אחד מספיק');
    assert.equal(planB.extraRoomsNeeded, 0, 'פעימה קטנה נכנסת לחדר שכבר סופק לפעימה שלפניה');

    assert.equal(planC.plan.totalRooms, 2, 'פעימה ג׳: תשעה חיילים דורשים שני חדרים');
    assert.equal(
      planC.extraRoomsNeeded,
      0,
      'פעימה ג׳ גדולה מפעימה ב׳ שממש לפניה, אבל לא מהשיא שכבר נראה בפעימה א׳ - אין לדרוש חדר נוסף',
    );

    // בקובץ ה-Excel: "חדר מתוכנן 1" משמש את שלוש הפעימות (אותו חדר מתפנה
    // ומתמלא שוב), ו"חדר מתוכנן 2" משמש רק את פעימה א׳ ופעימה ג׳ הגדולות -
    // פעימה ב׳ הקטנה מעולם לא נזקקה לו, ולכן לא מופיעה שם בכלל.
    const xlsxResponse = await fetch(`${baseUrl}/api/trips/${trip.id}/dorms/plan.xlsx`, {
      headers: { authorization: `Bearer ${toToken}` },
    });
    assert.equal(xlsxResponse.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await xlsxResponse.arrayBuffer());
    const sheet = workbook.getWorksheet('בקשת לינה')!;

    const lines: string[] = [];
    sheet.eachRow((row) => {
      const values: string[] = [];
      for (let col = 1; col <= 3; col += 1) {
        const cell = row.getCell(col);
        if (cell.type === ExcelJS.ValueType.Merge) continue;
        if (cell.value != null && cell.value !== '') values.push(String(cell.value));
      }
      if (values.length > 0) lines.push(values.join(','));
    });
    const xlsxText = lines.join('\n');

    const room1Index = xlsxText.indexOf('חדר מתוכנן 1 · בנים · חיילים');
    const room2Index = xlsxText.indexOf('חדר מתוכנן 2 · בנים · חיילים');
    assert.ok(room1Index >= 0 && room2Index > room1Index, 'שני בלוקי חדרים נפרדים, לפי מספר סידורי');

    const room1Block = xlsxText.slice(room1Index, room2Index);
    assert.match(room1Block, /חלוץ · יציאה 2026-12-01/, 'פעימה א׳ ישנה בחדר 1');
    assert.match(room1Block, /פעימה 1 · יציאה 2026-12-03/, 'פעימה ב׳ ישנה באותו חדר 1');
    assert.match(room1Block, /פעימה 2 · יציאה 2026-12-05/, 'פעימה ג׳ חוזרת לישון באותו חדר 1');

    const room2Block = xlsxText.slice(room2Index);
    assert.match(room2Block, /חלוץ · יציאה 2026-12-01/, 'פעימה א׳ נזקקת גם לחדר 2');
    assert.doesNotMatch(room2Block, /פעימה 1 · יציאה 2026-12-03/, 'פעימה ב׳ הקטנה מעולם לא נזקקה לחדר 2');
    assert.match(room2Block, /פעימה 2 · יציאה 2026-12-05/, 'פעימה ג׳ נזקקת גם לחדר 2');

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
  });
});

describe('אימות בסיסמה', () => {
  let opId = 0;
  let leaderId = 0;

  before(() => {
    // אופרטיבי אחד בלבד מותר בכל מסד - לא יוצרים כאן שני, אלא משתמשים
    // בזה שכבר נוצר למעלה בקובץ (companyId '1000001', אותו מסד :memory:
    // משותף לכל הקובץ).
    opId = (db.prepare("SELECT id FROM users WHERE role = 'to'").get() as { id: number }).id;
    leaderId = seedUser({
      companyId: '6900001',
      firstName: 'דן',
      lastName: 'מפקד',
      gender: 'male',
      role: 'team_leader',
      unitName: 'צוות בדיקת סיסמאות',
      managerId: opId,
    });
  });

  test('הרשמה דוחה סיסמה חלשה מדי, וסיסמאות שאינן תואמות', async () => {
    const weak = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500001',
        password: 'short',
        confirmPassword: 'short',
        firstName: 'בודק',
        lastName: 'חלש',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /8 תווים/);

    const mismatch = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500002',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd2',
        firstName: 'בודק',
        lastName: 'אימות',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.error, /תואמות/);
  });

  test('התחברות בשני שלבים: בדיקת מספר אישי לא מחזירה טוקן, וסיסמה נכונה/שגויה מטופלות נכון', async () => {
    const registered = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500003',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        firstName: 'רגילה',
        lastName: 'התחברות',
        gender: 'female',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const check = await api('POST', '/api/auth/login', { body: { companyId: '6500003' } });
    assert.equal(check.status, 200);
    assert.equal(check.body.registered, true);
    assert.equal(check.body.hasPassword, true);
    assert.equal(check.body.token, undefined, 'שלב בדיקת המספר האישי לא אמור להחזיר טוקן');

    const wrong = await api('POST', '/api/auth/login', {
      body: { companyId: '6500003', password: 'WrongPass1' },
    });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /מספר אישי או סיסמה שגויים/);

    const right = await api('POST', '/api/auth/login', {
      body: { companyId: '6500003', password: 'Passw0rd1' },
    });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.ok(right.body.token);
    assert.equal(right.body.user.hasPassword, true);
    assert.equal(right.body.user.mustChangePassword, false);
  });

  test('נעילה זמנית אחרי יותר מדי נסיונות התחברות כושלים', async () => {
    const registered = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500004',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        firstName: 'ננעל',
        lastName: 'בדיקה',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(registered.status, 201);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await api('POST', '/api/auth/login', {
        body: { companyId: '6500004', password: 'WrongPass1' },
      });
      assert.equal(attempt.status, 401, `נסיון ${i + 1} אמור להידחות כשגוי, לא כנעילה`);
    }

    const locked = await api('POST', '/api/auth/login', {
      body: { companyId: '6500004', password: 'WrongPass1' },
    });
    assert.equal(locked.status, 429, JSON.stringify(locked.body));

    // גם עם הסיסמה הנכונה - נעול הוא נעול, עד תום זמן הנעילה.
    const stillLocked = await api('POST', '/api/auth/login', {
      body: { companyId: '6500004', password: 'Passw0rd1' },
    });
    assert.equal(stillLocked.status, 429);
  });

  test('שכחתי סיסמה: התשובה זהה למספר קיים ולא קיים, והאופרטיבי בלבד מטפל בבקשות', async () => {
    const registered = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500005',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        firstName: 'שוכחת',
        lastName: 'סיסמה',
        gender: 'female',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(registered.status, 201);

    const unknown = await api('POST', '/api/auth/forgot-password', { body: { companyId: '9990001' } });
    const known = await api('POST', '/api/auth/forgot-password', { body: { companyId: '6500005' } });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.equal(unknown.body.message, known.body.message, 'התשובה חושפת אם המספר האישי קיים במערכת');

    // מי שאינו אופרטיבי לא רואה ולא מטפל בבקשות איפוס - זו סמכות ניהול מערכת.
    const leaderToken = await login('6900001');
    const forbiddenList = await api('GET', '/api/auth/password-resets', { token: leaderToken });
    assert.equal(forbiddenList.status, 403);

    const opToken = await login('1000001');
    const list = await api('GET', '/api/auth/password-resets', { token: opToken });
    assert.equal(list.status, 200);
    const request = list.body.requests.find((entry: any) => entry.user.companyId === '6500005');
    assert.ok(request, 'הבקשה לא מופיעה אצל האופרטיבי');

    const forbiddenResolve = await api('POST', `/api/auth/password-resets/${request.id}/resolve`, {
      token: leaderToken,
    });
    assert.equal(forbiddenResolve.status, 403);

    const resolved = await api('POST', `/api/auth/password-resets/${request.id}/resolve`, { token: opToken });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const tempPassword = resolved.body.tempPassword as string;
    assert.ok(tempPassword.length >= 8, 'הסיסמה הזמנית קצרה מדי');

    // הבקשה שטופלה כבר לא ברשימת הבקשות הממתינות.
    const listAfter = await api('GET', '/api/auth/password-resets', { token: opToken });
    assert.ok(!listAfter.body.requests.some((entry: any) => entry.id === request.id));

    // הסיסמה הישנה כבר לא עובדת, הזמנית כן, וה-mustChangePassword נדלק.
    const oldFails = await api('POST', '/api/auth/login', {
      body: { companyId: '6500005', password: 'Passw0rd1' },
    });
    assert.equal(oldFails.status, 401);

    const tempLogin = await api('POST', '/api/auth/login', {
      body: { companyId: '6500005', password: tempPassword },
    });
    assert.equal(tempLogin.status, 200, JSON.stringify(tempLogin.body));
    assert.equal(tempLogin.body.user.mustChangePassword, true);
    const userToken = tempLogin.body.token as string;

    // בלי הסיסמה הנוכחית (הזמנית) הנכונה, אי אפשר להחליף לסיסמה קבועה.
    const badChange = await api('PATCH', '/api/auth/password', {
      token: userToken,
      body: { currentPassword: 'WrongOne1', newPassword: 'NewPassw0rd1' },
    });
    assert.equal(badChange.status, 403);

    const changed = await api('PATCH', '/api/auth/password', {
      token: userToken,
      body: { currentPassword: tempPassword, newPassword: 'NewPassw0rd1' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.user.mustChangePassword, false);

    const finalLogin = await api('POST', '/api/auth/login', {
      body: { companyId: '6500005', password: 'NewPassw0rd1' },
    });
    assert.equal(finalLogin.status, 200);
    assert.equal(finalLogin.body.user.mustChangePassword, false);
  });

  test('התעלמות מבקשת איפוס לא משנה את הסיסמה הקיימת', async () => {
    const registered = await api('POST', '/api/auth/register', {
      body: {
        phone: '0501234567',
        companyId: '6500006',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        firstName: 'נדחית',
        lastName: 'בקשה',
        gender: 'male',
        diet: 'all',
        role: 'employee',
        managerId: leaderId,
      },
    });
    assert.equal(registered.status, 201);

    await api('POST', '/api/auth/forgot-password', { body: { companyId: '6500006' } });
    const opToken = await login('1000001');
    const list = await api('GET', '/api/auth/password-resets', { token: opToken });
    const request = list.body.requests.find((entry: any) => entry.user.companyId === '6500006');
    assert.ok(request);

    const dismissed = await api('POST', `/api/auth/password-resets/${request.id}/dismiss`, { token: opToken });
    assert.equal(dismissed.status, 200);

    const listAfter = await api('GET', '/api/auth/password-resets', { token: opToken });
    assert.ok(!listAfter.body.requests.some((entry: any) => entry.id === request.id));

    // הסיסמה המקורית עדיין עובדת - לא הוחלפה.
    const stillWorks = await api('POST', '/api/auth/login', {
      body: { companyId: '6500006', password: 'Passw0rd1' },
    });
    assert.equal(stillWorks.status, 200);
  });

  test('חשבון בלי סיסמה מוגדרת (מלפני הוספת האימות) חסום עד איפוס, ויכול להגדיר סיסמה ראשונה בלי סיסמה נוכחית', async () => {
    const legacyId = seedUser({
      companyId: '6500007',
      firstName: 'ותיק',
      lastName: 'לפני-סיסמה',
      gender: 'male',
      role: 'employee',
      managerId: leaderId,
    });
    // seedUser (כמו בדמו הישן) לא מגדיר password_hash - בדיוק המצב שדורש טיפול.

    const check = await api('POST', '/api/auth/login', { body: { companyId: '6500007' } });
    assert.equal(check.body.hasPassword, false);

    const blocked = await api('POST', '/api/auth/login', {
      body: { companyId: '6500007', password: 'AnyPassword1' },
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.hasPassword, false, 'חשבון בלי סיסמה לא אמור להתחבר עם שום סיסמה');
    assert.equal(blocked.body.token, undefined);

    // אבל אם עדיין יש לו טוקן ישן ותקף (מלפני המעבר לאימות בסיסמה) - כמו
    // /auth/debug-login שמדמה זאת - הוא יכול להגדיר סיסמה ראשונה דרך הפרופיל.
    const legacyToken = await login('6500007');
    const setFirst = await api('PATCH', '/api/auth/password', {
      token: legacyToken,
      body: { newPassword: 'FirstPassw0rd1' },
    });
    assert.equal(setFirst.status, 200, JSON.stringify(setFirst.body));
    assert.equal(setFirst.body.user.hasPassword, true);

    const worksNow = await api('POST', '/api/auth/login', {
      body: { companyId: '6500007', password: 'FirstPassw0rd1' },
    });
    assert.equal(worksNow.status, 200);

    db.prepare('DELETE FROM users WHERE id = ?').run(legacyId);
  });
});
