/**
 * זריעת נתוני דמו: מבנה ארגוני מלא
 * (מפמ״ר -> תחום -> מדורים -> צוותים -> חיילים), וגלישה לדוגמה עם שתי פעימות
 * יציאה ומבני לינה.
 *
 * המבנה מדגים את שני החלקים החדשים במודל:
 *   - המפמ״ר הוא ראש השרשרת ולכן המפקד של כל אנשי החברה, דרך הרת״ח.
 *   - האופרטיבי כפוף לרת״ח ומפקד על מדור משלו (ר״צ וחיילים תחתיו), בנוסף
 *     לכך שהוא מנהל המערכת.
 *
 * הרצה:  npm run seed          (מוסיף רק אם המסד ריק)
 *        npm run reset         (מוחק הכל וזורע מחדש)
 */
import { db, DB_FILE, tx } from './index.ts';
import { cycleName } from '../types.ts';
import type { Diet, Gender, Role } from '../types.ts';
import { hashPassword } from '../lib/password.ts';

const RESET = process.argv.includes('--reset');

/** סיסמת הדמו של כל המשתמשים הזרועים - ראו README.md, "כניסה לדוגמה". */
const DEMO_PASSWORD = 'Demo1234';

const TABLES = [
  'notifications',
  'trip_submissions',
  'trip_delegations',
  'trip_leaders',
  'dorm_issues',
  'room_assignments',
  'bus_assignments',
  'dorm_preferences',
  'signups',
  'rooms',
  'structures',
  'cycles',
  'trips',
  'users',
];

interface SeedPerson {
  companyId: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  role: Role;
  diet: Diet;
  unitName?: string;
  managerCompanyId?: string;
}

const MALE_FIRST = ['יונתן', 'איתי', 'נועם', 'אורי', 'דניאל', 'עומר', 'רועי', 'גיא', 'אלון', 'יובל', 'תומר', 'שחר'];
const FEMALE_FIRST = ['מאיה', 'שירה', 'נועה', 'תמר', 'יעל', 'אביגיל', 'רוני', 'הדר', 'ליאור', 'עדן', 'טל', 'אור'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'דהן', 'אברהם', 'פרידמן', 'שפירא', 'אזולאי', 'ברק', 'גולן',
  'הררי', 'ויצמן', 'זילבר', 'חדד', 'טולדנו', 'יוספי'];

/** מחולל מספרים פסאודו-רנדומלי עם seed קבוע, כדי שהזריעה תהיה משוחזרת. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const random = makeRandom(20260731);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

// המספרים האישיים של המפקדים הבכירים קבועים, כדי שהכניסות לדוגמה לא ישתנו.
const CEO_CID = '4000000';
const TO_CID = '4000001';
const DIVISION_CID = '4000002';

// המדורים והצוותים מקבלים 41xxxxx, והמדור של האופרטיבי 42xxxxx - כך המספרים
// של הכניסות לדוגמה (4100001 רמ״ד, 4100002 ר״צ, 4100003 חייל) נשארים יציבים.
let nextCompanyId = 4100000;
const newCompanyId = () => String(++nextCompanyId);
let nextToCompanyId = 4200000;
const newToCompanyId = () => String(++nextToCompanyId);

/** חייל אקראי (שם, מין ותזונה) שכפוף לצוות נתון. */
function buildSoldier(companyId: string, managerCompanyId: string): SeedPerson {
  const gender: Gender = random() < 0.55 ? 'male' : 'female';
  const dietRoll = random();
  return {
    companyId,
    firstName: pick(gender === 'male' ? MALE_FIRST : FEMALE_FIRST),
    lastName: pick(LAST),
    gender,
    role: 'employee',
    diet: dietRoll < 0.12 ? 'vegan' : dietRoll < 0.3 ? 'vegetarian' : 'all',
    managerCompanyId,
  };
}

function buildOrg(): SeedPerson[] {
  const people: SeedPerson[] = [];

  // מפמ״ר - ראש שרשרת הפיקוד, המפקד של כל אנשי החברה. אין לו מפקד.
  people.push({
    companyId: CEO_CID,
    firstName: 'נעמה',
    lastName: 'בן-ארי',
    gender: 'female',
    role: 'ceo',
    diet: 'all',
    unitName: 'החברה',
  });

  // רת״ח - ראש תחום, כפוף למפמ״ר
  people.push({
    companyId: DIVISION_CID,
    firstName: 'אבי',
    lastName: 'שגב',
    gender: 'male',
    role: 'division_leader',
    diet: 'all',
    unitName: 'תחום פיתוח',
    managerCompanyId: CEO_CID,
  });

  // אופרטיבי - מנהל המערכת, וגם מפקד מדור בשרשרת הפיקוד: כפוף לרת״ח,
  // ותחתיו ר״צ וחיילים כמו לכל רמ״ד.
  people.push({
    companyId: TO_CID,
    firstName: 'שירה',
    lastName: 'אופיר',
    gender: 'female',
    role: 'to',
    diet: 'vegetarian',
    unitName: 'מדור אופרטיבי',
    managerCompanyId: DIVISION_CID,
  });

  const toTeamCid = newToCompanyId();
  people.push({
    companyId: toTeamCid,
    firstName: 'עומר',
    lastName: 'רגב',
    gender: 'male',
    role: 'team_leader',
    diet: 'all',
    unitName: 'צוות מבצעים',
    managerCompanyId: TO_CID,
  });
  for (let i = 0; i < 5; i += 1) people.push(buildSoldier(newToCompanyId(), toTeamCid));

  const divisionId = DIVISION_CID;
  const sectors = [
    { name: 'מדור תוכנה', teams: ['צוות אלון', 'צוות ארז', 'צוות דקל'] },
    { name: 'מדור סייבר', teams: ['צוות רימון', 'צוות תמר'] },
    { name: 'מדור תשתיות', teams: ['צוות אורן', 'צוות ברוש'] },
  ];

  for (const sector of sectors) {
    const sectorLeaderId = newCompanyId();
    const sectorGender: Gender = random() < 0.5 ? 'male' : 'female';
    people.push({
      companyId: sectorLeaderId,
      firstName: pick(sectorGender === 'male' ? MALE_FIRST : FEMALE_FIRST),
      lastName: pick(LAST),
      gender: sectorGender,
      role: 'sector_leader',
      diet: 'all',
      unitName: sector.name,
      managerCompanyId: divisionId,
    });

    for (const teamName of sector.teams) {
      const teamLeaderId = newCompanyId();
      const leaderGender: Gender = random() < 0.5 ? 'male' : 'female';
      people.push({
        companyId: teamLeaderId,
        firstName: pick(leaderGender === 'male' ? MALE_FIRST : FEMALE_FIRST),
        lastName: pick(LAST),
        gender: leaderGender,
        role: 'team_leader',
        diet: random() < 0.2 ? 'vegetarian' : 'all',
        unitName: teamName,
        managerCompanyId: sectorLeaderId,
      });

      const teamSize = 6 + Math.floor(random() * 5); // 6-10 חיילים בצוות
      for (let i = 0; i < teamSize; i += 1) people.push(buildSoldier(newCompanyId(), teamLeaderId));
    }
  }

  return people;
}

function seed(): void {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };

  if (existing.count > 0 && !RESET) {
    console.log(`המסד כבר מכיל ${existing.count} משתמשים. להרצה מחדש: npm run reset`);
    return;
  }

  tx(() => {
    if (RESET) {
      // TABLES מסודר מהילדים אל האבות, כך שאילוצי המפתח הזר נשמרים.
      for (const table of TABLES) db.exec(`DELETE FROM ${table}`);
      db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('${TABLES.join("','")}')`);
    }

    const people = buildOrg();
    const idByCompanyId = new Map<string, number>();

    const insertUser = db.prepare(
      `INSERT INTO users (company_id, first_name, last_name, gender, role, diet, manager_id, unit_name, password_hash, status, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'))`,
    );
    // אותו גיבוב לכולם - הגיבוב עצמו יקר לחישוב (scrypt), אין טעם לחשב מחדש לכל משתמש.
    const demoPasswordHash = hashPassword(DEMO_PASSWORD);

    for (const person of people) {
      const managerId = person.managerCompanyId ? idByCompanyId.get(person.managerCompanyId) ?? null : null;
      const result = insertUser.run(
        person.companyId,
        person.firstName,
        person.lastName,
        person.gender,
        person.role,
        person.diet,
        managerId,
        person.unitName ?? null,
        demoPasswordHash,
      );
      idByCompanyId.set(person.companyId, Number(result.lastInsertRowid));
    }

    const toId = idByCompanyId.get(TO_CID)!;

    // גלישה לדוגמה. השם נגזר מהמזהה, כמו ביצירה דרך המערכת.
    const trip = db
      .prepare(
        `INSERT INTO trips (name, state, launch_date, bus_capacity, created_by)
         VALUES ('', 'LAUNCHED', ?, 50, ?) RETURNING id`,
      )
      .get('2026-08-01', toId) as { id: number };
    db.prepare('UPDATE trips SET name = ? WHERE id = ?').run(`גלישה #${trip.id}`, trip.id);

    // כל הרמ״דים, הרת״ח והאופרטיבי (שמפקד על מדור משלו) מקבלים את משימת
    // שיבוץ האנשים שלהם. המפמ״ר אינו מקבל אותה בדמו, כי היחידה שלו היא כל
    // החברה והשיבוץ שלו היה חופף לכולם.
    db.prepare(
      `INSERT INTO trip_leaders (trip_id, manager_id)
       SELECT ?, id FROM users
        WHERE status = 'approved' AND role IN ('sector_leader', 'division_leader', 'to')`,
    ).run(trip.id);

    const insertCycle = db.prepare('INSERT INTO cycles (trip_id, name, exit_date) VALUES (?, ?, ?) RETURNING id');
    // שמות הפעימות נגזרים מסדר היציאה: הראשונה חלוץ, ואחריה פעימה 1.
    insertCycle.get(trip.id, cycleName(0), '2026-09-08');
    insertCycle.get(trip.id, cycleName(1), '2026-09-15');

    // מבני לינה
    const insertStructure = db.prepare('INSERT INTO structures (trip_id, name, gender) VALUES (?, ?, ?) RETURNING id');
    const insertRoom = db.prepare('INSERT INTO rooms (structure_id, name, beds) VALUES (?, ?, ?)');

    const structures: Array<{ name: string; gender: Gender; rooms: Array<[string, number]> }> = [
      {
        name: 'מבנה א׳ - בנים',
        gender: 'male',
        rooms: [['101', 4], ['102', 4], ['103', 4], ['104', 6], ['105', 6], ['106', 3], ['107', 3]],
      },
      {
        name: 'מבנה ב׳ - בנים',
        gender: 'male',
        rooms: [['201', 4], ['202', 4], ['203', 5], ['204', 5], ['205', 2]],
      },
      {
        name: 'מבנה ג׳ - בנות',
        gender: 'female',
        rooms: [['301', 4], ['302', 4], ['303', 4], ['304', 6], ['305', 3], ['306', 3]],
      },
      {
        name: 'מבנה ד׳ - בנות',
        gender: 'female',
        rooms: [['401', 4], ['402', 4], ['403', 5], ['404', 2]],
      },
    ];

    for (const structure of structures) {
      const row = insertStructure.get(trip.id, structure.name, structure.gender) as { id: number };
      for (const [name, beds] of structure.rooms) insertRoom.run(row.id, name, beds);
    }

    console.log(`נזרעו ${people.length} משתמשים, גלישה אחד, 2 פעימות ו-${structures.length} מבני לינה.`);
    console.log(`מסד הנתונים: ${DB_FILE}`);
    console.log(`\nכניסה לדוגמה (מספר אישי, סיסמה לכולם: ${DEMO_PASSWORD}):`);
    console.log(`  ${CEO_CID} - נעמה בן-ארי (מפמ״ר)`);
    console.log(`  ${TO_CID} - שירה אופיר (אופרטיבי, וגם מפקד מדור אופרטיבי)`);
    console.log(`  ${DIVISION_CID} - אבי שגב (רת״ח)`);
    console.log('  4100001 - רמ״ד מדור תוכנה');
    console.log('  4100002 - ר״צ צוות אלון');
    console.log('  4100003 - חייל בצוות אלון');
    console.log('  4200001 - ר״צ צוות מבצעים (תחת האופרטיבי)');
    console.log('  4200002 - חייל בצוות מבצעים (המדור שלו הוא האופרטיבי)');
  });
}

seed();
