/** שכבת התקשורת עם ה־API. הטוקן נשמר ב־localStorage. */

const TOKEN_KEY = 'trip-organize.token';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // הרשת נפלה או שהשרת אינו זמין - fetch עצמו נכשל בלי תשובה.
    throw new ApiError(0, 'לא ניתן להתחבר לשרת. ודא שהשרת רץ (npm run dev).');
  }

  const text = await response.text();

  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // תשובה שאינה JSON - למשל שגיאת proxy או שרת שאינו זמין.
      throw new ApiError(
        response.status,
        response.status >= 500
          ? 'השרת אינו זמין. ודא שהשרת רץ (npm run dev).'
          : 'התקבלה תשובה לא צפויה מהשרת.',
      );
    }
  }

  if (!response.ok) {
    const message = (payload as { error?: string }).error ?? 'שגיאה בתקשורת עם השרת';
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

/**
 * הורדת קובץ (למשל CSV) עם אימות Bearer - לא ניתן להשתמש בקישור `<a href>`
 * רגיל כי הדפדפן לא שולח את כותרת ה-authorization בניווט רגיל.
 */
async function download(path: string, filename: string): Promise<void> {
  const token = getToken();

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError(0, 'לא ניתן להתחבר לשרת. ודא שהשרת רץ (npm run dev).');
  }

  if (!response.ok) {
    const text = await response.text();
    let message = 'שגיאה בתקשורת עם השרת';
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      // תשובת שגיאה שאינה JSON - נשארים עם ההודעה הכללית.
    }
    throw new ApiError(response.status, message);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T,>(path: string) => request<T>('DELETE', path),
  download,
};

// --- טיפוסי התשובות מהשרת ------------------------------------------------

export type Gender = 'male' | 'female';
export type Diet = 'all' | 'vegetarian' | 'vegan';
/** מצב בקשת הרכב הפרטי בהרשמה: 'none' - נוסע באוטובוס, שאר הערכים - ראה lib/cars.ts בשרת. */
export type CarStatus = 'none' | 'pending' | 'approved' | 'rejected';
/**
 * `ceo` (מפמ״ר) הוא ראש שרשרת הפיקוד ומפקד כל אנשי החברה, אבל אין לו הרשאות ניהול
 * מערכת - ניהול המערכת נשאר אצל האופרטיבי (`isTripOrganizer`).
 */
export type Role = 'employee' | 'team_leader' | 'sector_leader' | 'division_leader' | 'to' | 'ceo';

/** עובד רגיל, מושאל מיחידה אחרת (הצ״ח, ראו borrowedFrom) או מילואים. */
export type WorkerType = 'regular' | 'borrowed' | 'reserve';

export interface CurrentUser {
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
  /** אלרגיות מזון - 'ללא' כברירת מחדל כשלא הוזן. */
  allergies: string;
  status: 'pending' | 'approved' | 'rejected';
  /** חייל, או דרג ניהולי מסוים בדיוק - כל דרג ישן רק עם בני אותו דרג. */
  rankGroup: 'soldier' | Exclude<Role, 'employee'>;
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
  /** false לחשבון שנוצר לפני הוספת האימות בסיסמה - ההתחברות שלו חסומה עד איפוס. */
  hasPassword: boolean;
  /** נדלק אחרי איפוס סיסמה על ידי האופרטיבי - חובה להחליף סיסמה מיד. */
  mustChangePassword: boolean;
}

/** תשובת POST /auth/login - שני השלבים (בדיקת מספר אישי, ואז סיסמה) חולקים טיפוס אחד. */
export type LoginResponse =
  | { registered: false; companyId: string }
  | { registered: true; hasPassword: boolean; token?: undefined; user?: undefined }
  | { registered: true; hasPassword: true; token: string; user: CurrentUser };

/** בקשת איפוס סיסמה שממתינה - ראו GET /auth/password-resets (לאופרטיבי בלבד). */
export interface PasswordResetRequest {
  id: number;
  user: { id: number; fullName: string; companyId: string; role: Role; unitName: string | null };
  requestedAt: string;
}

export interface ManagerOption {
  id: number;
  fullName: string;
  role: Role;
  unitName: string | null;
}

/**
 * תשובת GET /auth/managers?role=&q= - המפקדים שמותר לבחור בהרשמה.
 * לתפקיד אחד יכולים להיות כמה דרגים מעליו (ר״צ -> רמ״ד או אופרטיבי), ולכן
 * `parentRoles` היא רשימה ובתוך `managers` מעורבים תפקידים שונים.
 */
export interface ManagersResponse {
  managers: ManagerOption[];
  parentRoles: Role[];
  /** הרשמה בלי מפקד: ראש השרשרת, או שאין עוד מפקד מאושר מהדרג שמעל. */
  rootRegistration: boolean;
  /** הסבר בעברית. קיים כש־rootRegistration. */
  note?: string;
}

export interface TripCycle {
  id: number;
  name: string;
  exitDate: string;
  approvedCount: number;
  pendingCount: number;
}

export type TripState = 'LAUNCHED' | 'CLOSED';

/** הרשאת השיבוץ בגלישה: מפקד שקיבל את המשימה, ר״צ שקיבל האצלה, או ללא הרשאה. */
export type SigningAuthority = 'leader' | 'delegated' | null;

/** מפקד שקיבל את משימת שיבוץ האנשים בגלישה. */
export interface TripLeader {
  id: number;
  fullName: string;
  role: Role;
  unitName: string | null;
  hasDelegated: boolean;
  /** מתי המפקד הגיש את הרשימה שלו, או null אם טרם הגיש. */
  submittedAt: string | null;
  /** כמה אנשים המפקד שיבץ עד כה. */
  signedCount: number;
}

/** מפקד שאפשר להטיל עליו את משימת השיבוץ (רמ״ד, רת״ח או האופרטיבי). */
export interface SigningLeaderOption {
  id: number;
  fullName: string;
  role: Role;
  unitName: string | null;
  directReports: number;
}

export interface Trip {
  id: number;
  /** נוצר אוטומטית: "גלישה #1". */
  name: string;
  state: TripState;
  stateLabel: string;
  launchDate: string;
  busCapacity: number;
  leaders: TripLeader[];
  leadersNotified: boolean;
  leadersNotifiedAt: string | null;
  busesLocked: boolean;
  busesLockedAt: string | null;
  dormsLocked: boolean;
  dormsLockedAt: string | null;
  createdAt: string;
  cycles: TripCycle[];
  signingAuthority: SigningAuthority;
  hasDelegated: boolean;
  /** האופרטיבי הגיש את הגלישה - השיבוץ קפוא לכולם. */
  submitted: boolean;
  submittedAt: string | null;
  /** מתי המפקד שצופה הגיש את הרשימה שלו, או null אם טרם הגיש. */
  mySubmittedAt: string | null;
  /** אי אפשר להוסיף או להסיר אנשים: הגלישה אינו פתוח, נעול, או הוגש. */
  rosterClosed: boolean;
  mySignup: {
    id: number;
    cycleId: number;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    diet: Diet;
    dietConfirmed: boolean;
    notes: string | null;
    decisionNote: string | null;
    signedUpByMe: boolean;
    carStatus: CarStatus;
    carPassenger: { id: number; fullName: string } | null;
    carDecisionNote: string | null;
  } | null;
}

/** אדם שהמפקד רשאי לשבץ, עם מצב השיבוץ הנוכחי שלו. */
export interface SignablePerson {
  userId: number;
  companyId: string;
  fullName: string;
  role: Role;
  gender: Gender;
  diet: Diet;
  unitPath: string;
  isSelf: boolean;
  signup: {
    id: number;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    cycleId: number | null;
    cycleName: string | null;
    dietConfirmed: boolean;
    carStatus: CarStatus | null;
    signedUpBy: string | null;
    signedUpByMe: boolean;
  } | null;
}

export interface SignableResponse {
  authority: SigningAuthority;
  hasDelegated: boolean;
  /**
   * שם התפקיד (ברבים) שהמפקד יכול להאציל אליו - הכפיפים הישירים שלו שהם
   * עצמם מפקדים. תלוי במקומו בשרשרת (רת״ח -> "רמ״דים", רמ״ד -> "ר״צים").
   * null כשאין לו הרשאת leader או שאין לו כפיפים שהם מפקדים.
   */
  subordinateRoleLabel: string | null;
  people: SignablePerson[];
  note?: string;
  /** מתי המפקד הגיש את הרשימה שלו, או null אם טרם הגיש. */
  submittedAt: string | null;
  /** אי אפשר להוסיף או להסיר אנשים. */
  rosterClosed: boolean;
  /** הסבר בעברית למה השיבוץ סגור. קיים כש־rosterClosed. */
  rosterClosedNote: string | null;
  /**
   * מי שאושר ליחידה אחרי שהמפקד הגיש וטרם שובץ. מופיעים גם ב־people
   * הרגילים, וכאן רק כדי להקפיץ אותם לראש המסך.
   */
  lateAdditions: number[];
}

/** תשובת ההגשה של מפקד: POST /trips/:id/submit-signing. */
export interface SubmitSigningResponse {
  ok: true;
  submittedAt: string;
  signedCount: number;
}

/** תשובת הגשת הגלישה על ידי האופרטיבי: POST /trips/:id/submit. */
export interface SubmitTripResponse {
  ok: true;
  trip: Trip;
  approved: number;
  pending: number;
  leadersNotSubmitted: Array<{ id: number; fullName: string }>;
}

/**
 * תשובת מחיקת גלישה: DELETE /trips/:id (לאופרטיבי בלבד).
 * המחיקה מוחקת בשרשור כל מה שתלוי בגלישה, ומדווחת כמה שורות נמחקו מכל סוג.
 */
export interface DeleteTripResponse {
  ok: true;
  deleted: {
    signups: number;
    cycles: number;
    structures: number;
    notifications: number;
  };
}

export interface RoommateCandidate {
  id: number;
  fullName: string;
  unitPath: string;
  signedUpForCycle: boolean;
}

export interface Signup {
  id: number;
  tripId: number;
  cycleId: number;
  userId: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  diet: Diet;
  dietConfirmed: boolean;
  notes: string | null;
  decisionNote: string | null;
  createdAt: string;
  carStatus: CarStatus;
  carPassenger: { id: number; fullName: string } | null;
  carDecisionNote: string | null;
  preferences: Array<{ id: number; priority: number; fullName: string }>;
}

/** מועמד לנוסע ברכב הפרטי - ראו GET /trips/:id/car-passenger-candidates. */
export interface CarPassengerCandidate {
  id: number;
  fullName: string;
  unitPath: string;
}

/** בקשת רכב פרטי שממתינה לאישור - כמו ApprovalRow אבל לבקשות רכב. */
export interface CarRequest extends Signup {
  user: { id: number; fullName: string; companyId: string; role: Role; carPlate: string | null; unitPath: string };
  cycle: { id: number; name: string; exitDate: string };
}

export interface ApprovalRow extends Signup {
  user: { id: number; fullName: string; companyId: string; gender: Gender; role: Role; unitPath: string };
  cycle: { id: number; name: string; exitDate: string };
}

export interface PendingRegistration extends CurrentUser {
  isDirectReport: boolean;
  createdAt: string;
}

/** השדות שמושווים בבקשת עדכון פרופיל - ראו ProfileEditRequest למטה. */
export interface ProfileEditFields {
  firstName: string;
  lastName: string;
  gender: Gender;
  diet: Diet;
  unitName: string | null;
  phone: string | null;
  allergies: string;
  workerType: WorkerType;
  borrowedFrom: string | null;
  borrowedMission: string | null;
}

/**
 * בקשת עדכון פרופיל - שינוי בפרטים אישיים שממתין לאישור המפקד, בדיוק כמו
 * הרשמה ראשונית. `current` ו־`proposed` מאפשרים להציג השוואה בין הערכים.
 */
export interface ProfileEditRequest {
  id: number;
  userId: number;
  userFullName: string;
  companyId: string;
  current: ProfileEditFields;
  proposed: ProfileEditFields;
  status: 'pending' | 'approved' | 'rejected';
  decisionNote: string | null;
  createdAt: string;
}

/** צומת בשרשרת הפיקוד - חלק מתשובת GET /users/me/hierarchy. */
export interface HierarchyMember {
  id: number;
  fullName: string;
  role: Role;
  unitName: string | null;
}

export interface TeamMember extends CurrentUser {
  unitPath: string;
  isDirectReport: boolean;
  /** האם יש לו כפיפים משלו - אם כן, העברה שלו דורשת ממלא מקום. */
  hasDirectReports: boolean;
}

/** תוצאת חיפוש אדם לבחירת ממלא מקום בהעברה - שם או מספר אישי. */
export interface UserSearchResult {
  id: number;
  fullName: string;
  companyId: string;
  role: Role;
  unitPath: string;
  hasDirectReports: boolean;
}

/**
 * בקשת העברה בהיררכיה - מעבר כפיף למפקד אחר בעץ. ממתינה לאישור המפקד היעד
 * כשהוא מחוץ לשרשרת הפיקוד של המבקש; אחרת חלה מיד ואין בקשה כזו בכלל.
 */
export interface MoveRequest {
  id: number;
  user: { id: number; fullName: string; companyId: string; role: Role };
  toManager: { id: number; fullName: string; unitName: string | null };
  successor: { id: number; fullName: string; companyId: string } | null;
  requestedBy: { id: number; fullName: string };
  status: 'pending' | 'approved' | 'rejected';
  decisionNote: string | null;
  createdAt: string;
}

export interface Structure {
  id: number;
  name: string;
  gender: Gender;
  totalBeds: number;
  rooms: Array<{ id: number; name: string; beds: number; assigned: number }>;
}

/** חדר בתוכנית לינה מוקדמת - עדיין לא חדר אמיתי, רק הצעה. */
export interface DormPlanRoom {
  roomId: number;
  gender: Gender;
  size: number;
  occupants: Array<{ userId: number; name: string }>;
}

/** כמה חדרים בגודל נתון, לפי מין - זה מה שמעבירים הלאה לספק. */
export interface DormPlanSizeCount {
  gender: Gender;
  size: number;
  count: number;
}

export interface DormPlan {
  rooms: DormPlanRoom[];
  sizeCounts: DormPlanSizeCount[];
  totalRooms: number;
  totalPeople: number;
  unassigned: number;
}

export interface DormPlanResponse {
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    plan: DormPlan;
    /** חדרים נוספים על מה שכבר סופק לפעימות קודמות - אותם חדרים מתפנים ומשמשים שוב. */
    extraRoomsNeeded: number;
  }>;
}

/**
 * דיווח ר״צ על ביטול משמרת - ראו GET/PUT /trips/:id/shift-reports.
 * המערכת אינה יודעת אילו משמרות אדם נמצא בהן, ולכן זהו דיווח ידני.
 */
export interface ShiftReportSubject {
  userId: number;
  fullName: string;
  companyId: string;
  isSelf: boolean;
  hasShift: boolean;
  details: string | null;
  dutyType: string | null;
  dutyLocation: string | null;
  dutyDates: string | null;
  handlingStatus: string | null;
  updatedAt: string | null;
}

export interface ShiftReportsMineResponse {
  tripId: number;
  subjects: ShiftReportSubject[];
}

/** סיכום הדיווחים לאופרטיבי - רק מי שיש לו משמרת לבטל. */
export interface ShiftReportSummaryEntry {
  userId: number;
  fullName: string;
  companyId: string;
  role: Role;
  unitPath: string;
  details: string | null;
  dutyType: string | null;
  dutyLocation: string | null;
  dutyDates: string | null;
  handlingStatus: string | null;
  reportedByName: string;
  updatedAt: string;
}

export interface ShiftReportsResponse {
  reports: ShiftReportSummaryEntry[];
}

/** נוסע ברכב פרטי - נהג או הנוסע שהצטרף אליו. */
export interface CarOccupant {
  userId: number;
  fullName: string;
  companyId: string;
  carPlate: string | null;
}

/**
 * מי מגיע ברכב פרטי במקום באוטובוס, מקובץ לפי פעימה.
 * `totalPeople` סופר נהגים ונוסעים יחד - אלה שאינם תופסים מקום באוטובוס.
 */
export interface CarTravelers {
  totalPeople: number;
  totalCars: number;
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    people: number;
    cars: Array<{ driver: CarOccupant; passenger: CarOccupant | null }>;
  }>;
}

export interface BusListResponse {
  locked: boolean;
  lockedAt?: string;
  capacity?: number;
  scope?: 'all' | 'my-people';
  cars?: CarTravelers;
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    totalParticipants: number;
    /** כמה מהמשתתפים בפעימה נוסעים ברכב פרטי מאושר ולכן אינם באוטובוס. */
    carCount: number;
    buses: Array<{
      number: number;
      count: number;
      members: Array<{ userId: number; fullName: string; companyId: string; gender: Gender; diet: Diet }>;
    }>;
  }>;
}

/** מועמד לשותפות בחדר - בבחירה בהרשמה ובמסך הפרופיל. */
export interface RoommateOption {
  id: number;
  fullName: string;
  companyId: string;
  unitPath: string;
}

export interface DormListResponse {
  locked: boolean;
  lockedAt?: string;
  scope?: 'all' | 'my-people';
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    rooms: Array<{
      roomId: number;
      roomName: string;
      structureName: string;
      gender: Gender;
      beds: number;
      totalOccupancy: number;
      freeBeds: number;
      members: Array<{ userId: number; fullName: string; companyId: string; role: Role }>;
    }>;
  }>;
}

export interface DormSuggestion {
  kind: 'free_bed' | 'swap_needed';
  roomId: number;
  roomLabel: string;
  freeBeds: number;
  companions: Array<{ userId: number; name: string; teamName: string | null }>;
}

export interface DormIssue {
  id: number;
  cycleId: number;
  cycleName: string;
  kind: 'no_preference_met' | 'unassigned';
  message: string;
  resolved: boolean;
  createdAt: string;
  user: { id: number; fullName: string; companyId: string };
  suggestions: DormSuggestion[];
}

export interface TripSummary {
  signedUp: boolean;
  trip?: { id: number; name: string; location: string | null };
  signup?: { status: string; diet: Diet; dietConfirmed: boolean; decisionNote: string | null };
  cycle?: { id: number; name: string; exitDate: string } | null;
  preferences?: Array<{ id: number; fullName: string; priority: number; gotIt: boolean }>;
  bus?: { published: boolean; number?: number | null };
  car?: {
    status: CarStatus;
    passengerName: string | null;
    decisionNote: string | null;
    ownCar: boolean;
    carPlate: string | null;
  } | null;
  dorm?: {
    published: boolean;
    structureName?: string | null;
    roomName?: string | null;
    beds?: number | null;
    roommates?: Array<{ id: number; fullName: string }>;
  };
}

export interface FoodReport {
  tripName: string;
  mealsPerDay: number;
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    mealsPerDay: number;
    participants: number;
    diets: Array<{ diet: Diet; participants: number; portions: number }>;
    totalPortions: number;
  }>;
  totals: Array<{ diet: Diet; participants: number; portions: number }>;
  grandTotalPortions: number;
  grandTotalParticipants: number;
}

export interface ParticipantsResponse {
  scope: 'all' | 'my-people';
  cycles: Array<{
    cycleId: number;
    cycleName: string;
    exitDate: string;
    totalApproved: number;
    participants: Array<{
      userId: number;
      companyId: string;
      fullName: string;
      gender: Gender;
      role: Role;
      diet: Diet;
      teamName: string | null;
      sectorName: string | null;
      managerName: string | null;
    }>;
  }>;
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}
