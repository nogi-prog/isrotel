/** טיפוסי הדומיין המשותפים לכל השרת. */

export type Gender = 'male' | 'female';
export type Diet = 'all' | 'vegetarian' | 'vegan';
/**
 * סוג החייל: חייל רגיל, מושאל (הצ״ח - מגיע מיחידה אחרת, ראו borrowed_from),
 * או מילואים (חייל לשעבר שחוזר לתקופה). שניהם עובדים כמו כל חייל אחר -
 * גלישות, אוטובוסים, לינה - רק מקובצים בנפרד במסכי הצוות. ראו POST
 * /users/ex-workers.
 */
export type WorkerType = 'regular' | 'borrowed' | 'reserve';
export const WORKER_TYPES: readonly WorkerType[] = ['regular', 'borrowed', 'reserve'];
/**
 * התפקידים במערכת. `ceo` (מפמ״ר) הוא ראש שרשרת הפיקוד ולכן המפקד של כל
 * אנשי החברה (דרך הרת״חים), ו-`to` (אופרטיבי) מחזיק גם עמדת רמ״ד בשרשרת
 * הפיקוד בנוסף לתפקידו כמנהל המערכת.
 */
export type Role = 'employee' | 'team_leader' | 'sector_leader' | 'division_leader' | 'to' | 'ceo';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type SignupStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * מכונת המצבים של הגלישה.
 * LAUNCHED - המצב הראשון, נקבע כשהאופרטיבי יוצר את הגלישה. בשלב הזה הפעולה
 *            היחידה שלו על הגלישה היא להודיע לרמ״דים ולרת״חים שעליהם לשבץ אנשים.
 * CLOSED   - מצב סופי.
 * מצבי הביניים יוגדרו בהמשך; נעילות האוטובוסים והלינה נשארות חתימות זמן נפרדות.
 */
export type TripState = 'LAUNCHED' | 'CLOSED';

export const TRIP_STATES: readonly TripState[] = ['LAUNCHED', 'CLOSED'];

/** המצב שממנו אפשר לעבור לכל מצב. */
export const TRIP_STATE_TRANSITIONS: Record<TripState, readonly TripState[]> = {
  LAUNCHED: ['CLOSED'],
  CLOSED: ['LAUNCHED'],
};

export const TRIP_STATE_LABEL: Record<TripState, string> = {
  LAUNCHED: 'פורסם - בשיבוץ אנשים',
  CLOSED: 'סגור',
};

/**
 * שם הפעימה לפי מקומה בסדר היציאה, לפי אינדקס מאפס.
 * הפעימה שיוצאת ראשונה היא תמיד "חלוץ", ואחריה "פעימה 1", "פעימה 2" וכן הלאה.
 * השם אינו מוזן על ידי האופרטיבי אלא נגזר מהסדר, ולכן הוא מחושב מחדש
 * (`renumberCycles`) אחרי כל הוספה, שינוי תאריך או מחיקה.
 */
export function cycleName(index: number): string {
  return index === 0 ? 'חלוץ' : `פעימה ${index}`;
}

/**
 * חתימת זמן ברזולוציית מילישנייה, באותה תבנית של `datetime('now')`.
 * נדרשת להשוואה "מי אושר אחרי שהמפקד הגיש": `datetime('now')` מדויק לשנייה,
 * ולכן אישור רישום ששוקע באותה שנייה של ההגשה לא נחשב מאוחר - ההתראה נשלחת
 * אבל האדם אינו מסומן במסך. התבנית נשארת ברת-השוואה לקסיקוגרפית גם מול
 * ערכים ישנים ברזולוציית שנייה ('...:43' < '...:43.500').
 */
export const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

/**
 * התפקידים שאפשר להטיל עליהם את משימת שיבוץ האנשים לגלישה.
 * מסודרים מלמעלה למטה בשרשרת הפיקוד. האופרטיבי נכלל כי מלבד ניהול המערכת
 * הוא מחזיק גם עמדת רמ״ד ומפקד על מדור משלו.
 */
export const SIGNING_LEADER_ROLES: readonly Role[] = ['ceo', 'division_leader', 'sector_leader', 'to'];

/**
 * קבוצת דרגה לצורכי שיבוץ לינה: כל חיילים ישנים יחד, אבל כל דרג ניהולי ישן
 * רק עם בני אותו דרג בדיוק - רמ״ד עם רמ״ד, רת״ח עם רת״ח וכן הלאה, לא כל
 * המפקדים יחד. ראו rankGroup ב-lib/org.ts.
 */
export type RankGroup = 'soldier' | Exclude<Role, 'employee'>;

/** כל התפקידים שהם מפקדים - כלומר כל מי שאינו חייל. */
export const MANAGER_ROLES: readonly Role[] = ['ceo', 'division_leader', 'sector_leader', 'to', 'team_leader'];
export const MAX_DORM_PREFERENCES = 3;

/**
 * התפקידים שנחשבים ל״מדור״ בשרשרת הפיקוד. האופרטיבי מפקד על מדור משלו,
 * ולכן המדור של אדם הוא הרמ״ד או האופרטיבי הקרוב ביותר מעליו (או הוא עצמו).
 */
export const SECTOR_ROLES: readonly Role[] = ['sector_leader', 'to'];

/** קיבולת אוטובוס קבועה במערכת. */
export const DEFAULT_BUS_CAPACITY = 50;

/** שמות התפקידים בעברית, לשימוש בהודעות השגיאה שמוצגות למשתמש. */
export const ROLE_LABEL: Record<Role, string> = {
  employee: 'חייל',
  team_leader: 'ר״צ',
  sector_leader: 'רמ״ד',
  division_leader: 'רת״ח',
  to: 'אופרטיבי',
  ceo: 'מפמ״ר',
};

/**
 * שמות התפקידים בעברית ברבים - לשימוש בהאצלת שיבוץ, שם הדרג שמאציל לו
 * תלוי במקומו של המאציל בשרשרת (רת״ח מאציל לרמ״דים, רמ״ד/אופרטיבי לר״צים).
 */
export const ROLE_LABEL_PLURAL: Record<Role, string> = {
  employee: 'חיילים',
  team_leader: 'ר״צים',
  sector_leader: 'רמ״דים',
  division_leader: 'רת״חים',
  to: 'אופרטיביים',
  ceo: 'מפמ״רים',
};

/** רשימת תפקידים בעברית להודעה למשתמש: "רמ״ד או אופרטיבי", "רת״ח, רמ״ד או ר״צ". */
export function roleLabels(roles: readonly Role[]): string {
  const labels = roles.map((role) => ROLE_LABEL[role]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} או ${labels[labels.length - 1]}`;
}

/**
 * שמות התפקידים בעברית ברבים, מחוברים ב-"ו" - לתיאור קבוצת אנשים בפועל
 * (למשל הכפיפים הישירים של מפקד). האופרטיבי כפוף לרת״ח בדיוק כמו רמ״ד,
 * ולכן לרת״ח יכולים להיות כפיפים משני התפקידים גם יחד - אבל האופרטיבי
 * *הוא* רמ״ד לצורך הזה (בדיוק כמו rankGroup ב-org.ts), אז התערובת נקראת
 * סתם "רמ״דים", לא "רמ״דים ואופרטיביים".
 */
export function pluralRoleLabels(roles: readonly Role[]): string {
  const labelRole = (role: Role): Role => (role === 'to' ? 'sector_leader' : role);
  const unique = [...new Set(roles.map(labelRole))];
  const labels = unique.map((role) => ROLE_LABEL_PLURAL[role]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ו${labels[labels.length - 1]}`;
}

/**
 * סדר התצוגה של אנשים ברשימות, מלמעלה למטה בשרשרת הפיקוד:
 * מפמ״ר, רת״ח, רמ״ד ואופרטיבי (אותו דרג), ר״צ, חייל.
 * מוחזר כביטוי SQL כדי שכל רשימה במערכת תיקרא באותו סדר.
 */
export function roleOrderSql(column: string): string {
  return `CASE ${column}
            WHEN 'ceo' THEN 0
            WHEN 'division_leader' THEN 1
            WHEN 'sector_leader' THEN 2
            WHEN 'to' THEN 2
            WHEN 'team_leader' THEN 3
            ELSE 4
          END`;
}

/** התפקידים שמשתמש יכול להירשם בהם (אופרטיבי אינו נרשם דרך הטופס). */
export const REGISTRABLE_ROLES = [
  'employee',
  'team_leader',
  'sector_leader',
  'division_leader',
  'ceo',
] as const;
export type RegistrableRole = (typeof REGISTRABLE_ROLES)[number];

/**
 * הדרגים שמותר לבחור מהם מפקד בהרשמה:
 *   חייל -> ר״צ / רמ״ד / אופרטיבי / רת״ח / מפמ״ר, ר״צ -> רמ״ד / אופרטיבי -> רת״ח -> מפמ״ר
 * חייל יכול להיות כפוף ישירות לכל דרג מפקד, לא רק לר״צ - ביחידות קטנות
 * לפעמים אין ר״צ בכלל. ר״צ יכול להיות כפוף לרמ״ד או לאופרטיבי, כי לאופרטיבי
 * יש מדור משלו - ולכן זו רשימה ולא ערך בודד. המפמ״ר הוא ראש השרשרת ואין לו
 * מפקד; הרישום שלו (וכל רישום ללא מפקד) מאושר על ידי האופרטיבי.
 */
export const PARENT_ROLES: Record<RegistrableRole, readonly Role[]> = {
  employee: ['team_leader', 'sector_leader', 'to', 'division_leader', 'ceo'],
  team_leader: ['sector_leader', 'to'],
  sector_leader: ['division_leader'],
  division_leader: ['ceo'],
  ceo: [],
};

export interface UserRow {
  id: number;
  company_id: string;
  first_name: string;
  last_name: string;
  gender: Gender;
  role: Role;
  diet: Diet;
  manager_id: number | null;
  unit_name: string | null;
  phone: string | null;
  allergies: string;
  car_plate: string | null;
  worker_type: WorkerType;
  borrowed_from: string | null;
  borrowed_mission: string | null;
  password_hash: string | null;
  must_change_password: number;
  status: UserStatus;
  approved_by: number | null;
  approved_at: string | null;
  created_at: string;
}

/**
 * בקשת איפוס סיסמה - "שכחתי סיסמה". ממתינה לאופרטיבי (סמכות ניהול מערכת,
 * לא סמכות ארגונית - ולכן לא למפקד הישיר). ראו lib/password.ts.
 */
export interface PasswordResetRequestRow {
  id: number;
  user_id: number;
  status: 'pending' | 'resolved' | 'dismissed';
  requested_at: string;
  resolved_by: number | null;
  resolved_at: string | null;
}

/**
 * בקשת עדכון פרופיל - עדכון פרטים אישיים ביוזמת המשתמש עצמו, שממתין לאישור
 * המפקד כמו הרשמה ראשונית. מפקד שעורך ישירות את הפרטים של כפיף לא יוצר שורה
 * כאן. company_id, role ו-manager_id לא נכללים: אלה שדות זהות/ניהול.
 */
export interface ProfileEditRow {
  id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  gender: Gender;
  diet: Diet;
  unit_name: string | null;
  phone: string | null;
  allergies: string;
  worker_type: WorkerType;
  borrowed_from: string | null;
  borrowed_mission: string | null;
  status: UserStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/**
 * בקשת העברה בהיררכיה - מעבר כפיף למפקד אחר בעץ. אם המפקד היעד מחוץ
 * לשרשרת הפיקוד של המבקש, ההעברה ממתינה לאישורו; אחרת חלה מיד.
 * successor_id ממלא את מקומו של המועבר ביחידה הישנה, כשיש לו כפיפים משלו.
 */
export interface MoveRequestRow {
  id: number;
  user_id: number;
  to_manager_id: number;
  successor_id: number | null;
  requested_by: number;
  status: UserStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface TripRow {
  id: number;
  /** נוצר אוטומטית: "גלישה #1". האופרטיבי אינו מזין שם. */
  name: string;
  state: TripState;
  launch_date: string;
  leaders_notified_at: string | null;
  bus_capacity: number;
  buses_locked_at: string | null;
  dorms_locked_at: string | null;
  /** הרגע שבו האופרטיבי הגיש את הגלישה. מכאן רשימת המשתתפים קפואה. */
  submitted_at: string | null;
  created_by: number;
  created_at: string;
}

/** פעימת יציאה - גל של יום אחד. אין תאריך חזרה. */
export interface CycleRow {
  id: number;
  trip_id: number;
  name: string;
  exit_date: string;
  created_at: string;
}

/** מצב בקשת הרכב הפרטי בהרשמה - ראו ההסבר ב-schema.sql וב-lib/cars.ts. */
export type CarStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface SignupRow {
  id: number;
  trip_id: number;
  cycle_id: number;
  user_id: number;
  /** המפקד ששיבץ את האדם לגלישה. חייל אינו משבץ את עצמו. */
  created_by: number | null;
  diet: Diet;
  diet_confirmed: number;
  notes: string | null;
  status: SignupStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  car_status: CarStatus;
  car_passenger_id: number | null;
  car_decided_by: number | null;
  car_decided_at: string | null;
  car_decision_note: string | null;
  created_at: string;
}

/**
 * דיווח על ביטול משמרת - ראו ההסבר ב-schema.sql. שורה אחת לכל (trip_id,
 * user_id); ר״צ מדווח עבור עצמו ועבור החיילים הישירים שלו.
 */
export interface ShiftReportRow {
  id: number;
  trip_id: number;
  user_id: number;
  reported_by: number;
  has_shift: number;
  details: string | null;
  duty_type: string | null;
  duty_location: string | null;
  duty_dates: string | null;
  handling_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface StructureRow {
  id: number;
  trip_id: number;
  name: string;
  gender: Gender;
}

export interface RoomRow {
  id: number;
  structure_id: number;
  name: string;
  beds: number;
}

export interface DormIssueRow {
  id: number;
  trip_id: number;
  cycle_id: number;
  user_id: number;
  manager_id: number | null;
  kind: 'no_preference_met' | 'unassigned';
  message: string;
  suggestions: string;
  resolved: number;
  created_at: string;
}

/** משתמש כפי שהוא מוחזר ל־API, כולל שדות מחושבים מההיררכיה. */
export interface PublicUser {
  id: number;
  companyId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  gender: Gender;
  role: Role;
  diet: Diet;
  managerId: number | null;
  managerName: string | null;
  unitName: string | null;
  phone: string | null;
  allergies: string;
  status: UserStatus;
  rankGroup: RankGroup;
  sectorId: number | null;
  sectorName: string | null;
  teamId: number | null;
  teamName: string | null;
  divisionId: number | null;
  divisionName: string | null;
  isManager: boolean;
  isTripOrganizer: boolean;
  /** מספר הרכב הפרטי - כל משתמש יכול לשמור, לרת״ח ולמפמ״ר זו הגעה קבועה. */
  carPlate: string | null;
  workerType: WorkerType;
  borrowedFrom: string | null;
  /** המשימה שבשבילה מבקשים את ההשאלה - רלוונטי רק כש-workerType הוא 'borrowed'. */
  borrowedMission: string | null;
  /** האם הוגדרה סיסמה - false לחשבון שנוצר לפני הוספת האימות בסיסמה. */
  hasPassword: boolean;
  /** נדלק אחרי איפוס סיסמה על ידי האופרטיבי - מחייב החלפת סיסמה מיד. */
  mustChangePassword: boolean;
}
