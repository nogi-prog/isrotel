/**
 * ייבוא חד-פעמי של גיליון הכוח אדם האמיתי (Google Sheet) לתוך users + trip
 * אחד עם שתי פעימות. מריץ לצד נתוני הדמו הקיימים (לא מוחק כלום).
 *
 * הרצה:  DB_FILE=<path> node --experimental-strip-types server/src/db/importSheet.ts
 */
import { readFileSync } from 'node:fs';
import { db, tx } from './index.ts';
import { cycleName } from '../types.ts';
import type { Diet, Gender, Role, WorkerType } from '../types.ts';

const CSV_PATH = process.env.SHEET_CSV ?? 'C:/Users/Ernik/AppData/Local/Temp/sheet0.csv';

// --- CSV parsing (quote-aware) ------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

interface SheetRow {
  name: string; sector: string; team: string; personalNum: string; managerName: string;
  status: string; allergies: string; diet: string; day1: string; bringCar: string;
  howArrive: string; cycle: string; genderRole: string; room: string;
}

const raw = parseCsv(readFileSync(CSV_PATH, 'utf8'));
// שורה 0 = כותרות, עמודה 1 (index 1) היא "Column 15" הריקה - מדלגים עליה.
const allRows: SheetRow[] = raw.slice(1)
  .filter((r) => r[0] && r[0].trim() !== '')
  .map((r) => ({
    name: (r[0] ?? '').trim(),
    sector: (r[2] ?? '').trim(),
    team: (r[3] ?? '').trim(),
    personalNum: (r[4] ?? '').trim(),
    managerName: (r[5] ?? '').trim(),
    status: (r[6] ?? '').trim(),
    allergies: (r[7] ?? '').trim(),
    diet: (r[8] ?? '').trim(),
    day1: (r[9] ?? '').trim(),
    bringCar: (r[10] ?? '').trim(),
    howArrive: (r[11] ?? '').trim(),
    cycle: (r[12] ?? '').trim(),
    genderRole: (r[13] ?? '').trim(),
    room: (r[14] ?? '').trim(),
  }));

// --- explicit corrections agreed on with the TO during the Q&A --------------

const NAME_ALIASES: Record<string, string> = {
  'אחינעם בלייכברד': 'אחינעם בלייכבנד',
  'שיר מרדכי': 'שיר מרדכי בלולו',
};
const normName = (n: string): string => NAME_ALIASES[n.trim()] ?? n.trim();

// שורות שנפסלות ידנית: כפילות עם איות שונה (לא נתפסת ע"י דה-דופ לפי שם זהה),
// ושורה עם שם בן מילה אחת בלבד וכמעט בלי נתונים.
function isExplicitlySkipped(r: SheetRow): boolean {
  if (r.name === 'נעם מנשר' && r.sector === '332' && r.personalNum === '') return true; // כפילות של נועם מנשר (שורה 60)
  if (r.name === 'גלמן' && r.personalNum === '') return true; // שם חלקי, אין מספיק נתונים לזהות
  return false;
}

interface LeaderOverride {
  gender: Gender;
  role: Role;
  managerName: string | null;
  unitName: string;
  companyId?: string;
}

// אנשי מפתח שאין להם שורה משלהם בגיליון בכלל (מוזכרים רק כ"מפקד בבראשית"
// של אחרים), וסטטוסים/תפקידים שנקבעו בשיחה עם ה-TO ולא ניתנים לחילוץ מהטור
// genderRole. הטבלה הזו גוברת על מה שנחלץ מהשורה עצמה, אם יש שורה.
const LEADER_OVERRIDES: Record<string, LeaderOverride> = {
  'מירית רייניש': { gender: 'female', role: 'ceo', managerName: null, unitName: 'החברה' },
  'דן פילבסקי': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 330' },
  'אמיל קולק': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 360' },
  'אלעד גת': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 380' },
  'חן לידרמן': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 325' },
  'עמית קדרון': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 340' },
  'יובל רוטשטיין': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 304' },
  'הראל פריימון': { gender: 'male', role: 'division_leader', managerName: 'מירית רייניש', unitName: 'תחום 370' },
  'אביב רדמרד': { gender: 'male', role: 'to', managerName: 'יובל רוטשטיין', unitName: 'אופרטיבי' },
  'שחר גרימברג': { gender: 'female', role: 'sector_leader', managerName: 'מירית רייניש', unitName: 'לשכה' },
  'רוני הרוש': { gender: 'female', role: 'team_leader', managerName: 'מירית רייניש', unitName: 'סגל' },
  'אהרון כהן': { gender: 'male', role: 'employee', managerName: 'שיר מרדכי בלולו', unitName: 'ארגון' },
  'תאיר פרטוש': { gender: 'female', role: 'team_leader', managerName: 'שיר מרדכי בלולו', unitName: 'ע׳ רמ״ד' },
};

// חמישה מהאנשים ב-LEADER_OVERRIDES אין להם שורה בגיליון בכלל - הם מסונתזים.
const SYNTHETIC_LEADERS = ['מירית רייניש', 'אלעד גת', 'חן לידרמן', 'עמית קדרון', 'יובל רוטשטיין', 'הראל פריימון'];

// מדור -> שם הרת"ח שמפקד עליו, כשל השורה של הרמ"ד/אופרטיבי של אותו מדור
// אין ערך בעמודת "מפקד בבראשית".
const SECTOR_TO_DIVISION_LEADER: Record<string, string> = {
  '330': 'דן פילבסקי', '331': 'דן פילבסקי', '332': 'דן פילבסקי',
  '360': 'אמיל קולק', '367': 'אמיל קולק',
  '377': 'הראל פריימון',
  '381': 'אלעד גת', '383': 'אלעד גת', '385': 'אלעד גת', '389': 'אלעד גת',
  '325': 'חן לידרמן', '326': 'חן לידרמן', '329': 'חן לידרמן',
  '341': 'עמית קדרון', '349': 'עמית קדרון',
  '304': 'יובל רוטשטיין', 'אופרטיבי': 'יובל רוטשטיין', 'ארגון': 'יובל רוטשטיין',
};
// מדורים שמדווחים ישירות למפמ"רית, בלי רת"ח באמצע.
const SECTOR_TO_CEO_DIRECT = new Set(['לשכה', 'משא״ן']);

// --- role/gender parsing מעמודת genderRole -----------------------------------

function parseGenderRole(text: string): { gender: Gender | null; role: Role | null } {
  const t = text.trim();
  if (t === 'רתח') return { gender: null, role: 'division_leader' };
  if (t.startsWith('זכר')) {
    const rest = t.slice(3).trim();
    const role: Role = rest === 'רמד' ? 'sector_leader' : rest === 'רצ' ? 'team_leader' : 'employee';
    return { gender: 'male', role };
  }
  if (t.startsWith('נקבה')) {
    const rest = t.slice(4).trim();
    const role: Role = rest === 'רמד' ? 'sector_leader' : rest === 'רצ' ? 'team_leader' : 'employee';
    return { gender: 'female', role };
  }
  return { gender: null, role: null };
}

function parseWorkerType(status: string): WorkerType {
  const t = status.trim();
  if (t.startsWith('הצח')) return 'borrowed';
  if (t.startsWith('מיל')) return 'reserve';
  return 'regular';
}

interface DietResult { diet: Diet; note: string | null }
function parseDiet(text: string): DietResult {
  const t = text.trim();
  if (t === 'צמחוני') return { diet: 'vegetarian', note: null };
  if (t === 'טבעוני') return { diet: 'vegan', note: null };
  if (t === '' || t === 'ללא') return { diet: 'all', note: null };
  // ללא גלוטן / כשר למהדרין / כל ערך אחר שלא זוהה - נשמר כהערה על ה-signup.
  return { diet: 'all', note: t };
}

// --- בניית רשימת האנשים לייבוא ------------------------------------------------

interface Person {
  name: string;
  companyId: string | null; // null = דורש מספר רנדומלי
  companyIdIsPlaceholder: boolean;
  firstName: string;
  lastName: string;
  gender: Gender;
  role: Role;
  workerType: WorkerType;
  unitName: string | null;
  managerName: string | null;
  diet: Diet;
  dietNote: string | null;
  allergies: string | null;
  cycleIndex: number | null; // null = לא רשום לגלישה (מנהיגים מסונתזים)
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full, lastName: parts.slice(1).join(' ') || (parts[0] ?? full) };
}

function isValidCompanyId(n: string): boolean {
  return /^\d{7}$/.test(n);
}

function resolveCycleIndex(row: SheetRow): number {
  if (row.cycle === 'ראשונה') return 0;
  if (row.cycle === 'שניה') return 1;
  if (row.day1.includes('שני')) return 1;
  return 0;
}

const people = new Map<string, Person>(); // name -> Person (post de-dupe)
const excluded: string[] = [];
const duplicateIdConflicts: string[] = [];
const claimedRealIds = new Set<string>();

// שלב 1: דה-דופ - לכל שם, שומרים את השורה עם הכי הרבה שדות מלאים.
function completeness(r: SheetRow): number {
  return Object.values(r).filter((v) => v && v.trim() !== '').length;
}
const bestRowByName = new Map<string, SheetRow>();
for (const r of allRows) {
  if (isExplicitlySkipped(r)) { excluded.push(`${r.name} (כפילות/שורה חלקית מדי)`); continue; }
  const key = normName(r.name);
  const existing = bestRowByName.get(key);
  if (!existing || completeness(r) > completeness(existing)) bestRowByName.set(key, r);
}

// שלב 2: הפיכת כל שורה שנבחרה לאדם, עם override אם קיים.
for (const [name, row] of bestRowByName) {
  const override = LEADER_OVERRIDES[name];
  const parsed = parseGenderRole(row.genderRole);
  const gender = override?.gender ?? parsed.gender;
  const role = override?.role ?? parsed.role;
  if (!gender || !role) { excluded.push(`${name} (אין מגדר/תפקיד ניתן לזיהוי)`); continue; }

  const { firstName, lastName } = splitName(name);
  const { diet, note: dietNote } = parseDiet(row.diet);

  let managerName: string | null;
  if (override?.managerName !== undefined) managerName = override.managerName;
  else if (row.managerName) managerName = normName(row.managerName);
  else if (role === 'sector_leader' || role === 'to') {
    const sector = row.sector;
    managerName = SECTOR_TO_CEO_DIRECT.has(sector) ? 'מירית רייניש' : SECTOR_TO_DIVISION_LEADER[sector] ?? null;
  } else managerName = null;

  let companyIdValid = isValidCompanyId(row.personalNum);
  if (companyIdValid && claimedRealIds.has(row.personalNum)) {
    duplicateIdConflicts.push(`${name} (${row.personalNum}) - מספר כבר בשימוש על ידי אדם אחר בגיליון`);
    companyIdValid = false;
  }
  if (companyIdValid) claimedRealIds.add(row.personalNum);
  people.set(name, {
    name,
    companyId: companyIdValid ? row.personalNum : null,
    companyIdIsPlaceholder: !companyIdValid,
    firstName,
    lastName,
    gender,
    role,
    workerType: parseWorkerType(row.status),
    unitName: override?.unitName ?? (role === 'team_leader' ? (row.team || null)
      : role === 'sector_leader' || role === 'to' ? (row.sector ? `מדור ${row.sector}` : null)
      : null),
    managerName,
    diet,
    dietNote,
    allergies: row.allergies || null,
    cycleIndex: resolveCycleIndex(row),
  });
}

// שלב 3: הוספת המנהיגים המסונתזים (אין להם שורה בגיליון כלל).
for (const name of SYNTHETIC_LEADERS) {
  if (people.has(name)) continue;
  const override = LEADER_OVERRIDES[name]!;
  const { firstName, lastName } = splitName(name);
  people.set(name, {
    name,
    companyId: null,
    companyIdIsPlaceholder: true,
    firstName,
    lastName,
    gender: override.gender,
    role: override.role,
    workerType: 'regular',
    unitName: override.unitName,
    managerName: override.managerName,
    diet: 'all',
    dietNote: null,
    allergies: null,
    cycleIndex: null, // לא נרשמים לגלישה - אין להם נתוני פעימה/תזונה מהגיליון
  });
}

// --- מספרים אישיים רנדומליים לכל מי שחסר/פגום ---------------------------------

const existingIds = new Set<string>(
  (db.prepare('SELECT company_id FROM users').all() as { company_id: string }[]).map((r) => r.company_id),
);
for (const p of people.values()) if (p.companyId) existingIds.add(p.companyId);

function randomCompanyId(): string {
  let id: string;
  do {
    id = String(1000000 + Math.floor(Math.random() * 9000000)).slice(0, 7);
  } while (existingIds.has(id));
  existingIds.add(id);
  return id;
}

for (const p of people.values()) {
  if (!p.companyId) p.companyId = randomCompanyId();
}

// --- כתיבה למסד --------------------------------------------------------------

tx(() => {
  const insertUser = db.prepare(
    `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, unit_name, worker_type, password_hash, status, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'approved', datetime('now'))`,
  );
  const idByName = new Map<string, number>();

  for (const p of people.values()) {
    const result = insertUser.run(
      p.companyId, p.firstName, p.lastName, p.gender, p.role, p.diet, p.unitName, p.workerType,
    );
    idByName.set(p.name, Number(result.lastInsertRowid));
  }

  const updateManager = db.prepare('UPDATE users SET manager_id = ? WHERE id = ?');
  const unresolvedManagers: string[] = [];
  for (const p of people.values()) {
    if (!p.managerName) continue;
    const managerId = idByName.get(p.managerName);
    if (managerId === undefined) { unresolvedManagers.push(`${p.name} -> "${p.managerName}"`); continue; }
    updateManager.run(managerId, idByName.get(p.name)!);
  }

  const toId = idByName.get('אביב רדמרד')!;

  const trip = db
    .prepare(`INSERT INTO trips (name, state, launch_date, bus_capacity, created_by) VALUES ('', 'LAUNCHED', ?, 50, ?) RETURNING id`)
    .get('2026-08-07', toId) as { id: number };
  db.prepare('UPDATE trips SET name = ? WHERE id = ?').run(`גלישה #${trip.id}`, trip.id);

  db.prepare(
    `INSERT INTO trip_leaders (trip_id, manager_id)
     SELECT ?, id FROM users WHERE status = 'approved' AND role IN ('sector_leader', 'division_leader', 'to')`,
  ).run(trip.id);

  const insertCycle = db.prepare('INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, ?, ?) RETURNING id');
  const cycleIds = [
    (insertCycle.get(trip.id, cycleName(0), '2026-08-16') as { id: number }).id,
    (insertCycle.get(trip.id, cycleName(1), '2026-08-17') as { id: number }).id,
  ];

  const insertSignup = db.prepare(
    `INSERT INTO signups (trip_id, cycle_id, user_id, created_by, diet, diet_confirmed, notes, status, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'approved', ?, datetime('now'))`,
  );
  let signupCount = 0;
  for (const p of people.values()) {
    if (p.cycleIndex === null) continue;
    const userId = idByName.get(p.name)!;
    const createdBy = p.managerName ? idByName.get(p.managerName) ?? userId : userId;
    const notes = [p.dietNote, p.allergies].filter(Boolean).join('; ') || null;
    insertSignup.run(trip.id, cycleIds[p.cycleIndex]!, userId, createdBy, p.diet, notes, createdBy);
    signupCount += 1;
  }

  const placeholderIds = [...people.values()].filter((p) => p.companyIdIsPlaceholder).map((p) => `${p.name} (${p.companyId})`);

  console.log(`\n=== ייבוא הגיליון הושלם ===`);
  console.log(`נוצרו ${people.size} משתמשים, גלישה #${trip.id} עם 2 פעימות, ${signupCount} הרשמות.`);
  console.log(`\n--- שורות שהוחרגו (${excluded.length}) ---`);
  for (const e of excluded) console.log(`  ${e}`);
  console.log(`\n--- מספרים אישיים כפולים בגיליון עצמו (${duplicateIdConflicts.length}) ---`);
  for (const d of duplicateIdConflicts) console.log(`  ${d}`);
  console.log(`\n--- מפקדים שלא נמצאו (manager_id נשאר NULL) (${unresolvedManagers.length}) ---`);
  for (const u of unresolvedManagers) console.log(`  ${u}`);
  console.log(`\n--- מספרים אישיים רנדומליים-זמניים (${placeholderIds.length}) - דורשים תיקון לפני שהאדם יוכל להתחבר ---`);
  for (const id of placeholderIds) console.log(`  ${id}`);
});
