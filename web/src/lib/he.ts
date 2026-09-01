/** כל המונחים בעברית במקום אחד, לפי מילון המונחים של המערכת. */

import type { Role } from './api';

/** התפקידים מלמעלה למטה בשרשרת הפיקוד. רמ״ד והאופרטיבי הם אותו דרג. */
export const ROLE_ORDER: Role[] = ['ceo', 'division_leader', 'sector_leader', 'to', 'team_leader', 'employee'];

export const ROLE_LABEL: Record<string, string> = {
  ceo: 'מפמ״ר',
  division_leader: 'רת״ח',
  sector_leader: 'רמ״ד',
  to: 'אופרטיבי',
  team_leader: 'ר״צ',
  employee: 'חייל',
};

export const ROLE_LABEL_LONG: Record<string, string> = {
  ceo: 'מפמ״ר',
  division_leader: 'ראש תחום',
  sector_leader: 'ראש מדור',
  to: 'אופרטיבי',
  team_leader: 'ראש צוות',
  employee: 'חייל',
};

/**
 * הדרגים שמעל כל תפקיד - חייב להתאים ל־PARENT_ROLES בשרת.
 * לתפקיד אחד יכול להיות יותר מדרג אחד מעליו: האופרטיבי הוא גם רמ״ד, ולכן ר״צ
 * יכול להיות כפוף לרמ״ד או לאופרטיבי. חייל יכול להיות כפוף ישירות לכל דרג
 * מפקד, לא רק לר״צ. המפמ״ר הוא ראש השרשרת ואין לו דרג מעליו.
 */
export const PARENT_ROLE: Record<string, Role[]> = {
  employee: ['team_leader', 'sector_leader', 'to', 'division_leader', 'ceo'],
  team_leader: ['sector_leader', 'to'],
  sector_leader: ['division_leader'],
  division_leader: ['ceo'],
  ceo: [],
};

/** מיקום התפקיד בשרשרת הפיקוד, למיון רשימות מלמעלה למטה. */
export function roleRank(role: Role): number {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

export const UNIT_LABEL = {
  team: 'צוות',
  sector: 'מדור',
  division: 'תחום',
} as const;

/**
 * שם היחידה שמפקד מסוג זה עומד בראשה, לתצוגה כמו "5 בצוות" / "12 במדור" -
 * חייב להתאים ל-SECTOR_ROLES בשרת (האופרטיבי הוא רמ״ד לצורך הזה).
 */
export function unitWordForRole(role: Role): string {
  switch (role) {
    case 'division_leader':
      return UNIT_LABEL.division;
    case 'sector_leader':
    case 'to':
      return UNIT_LABEL.sector;
    case 'ceo':
      return 'חברה';
    case 'team_leader':
    default:
      return UNIT_LABEL.team;
  }
}

/**
 * שם הפעימה לפי מקומה בסדר היציאה - חייב להתאים ל־cycleName בשרת.
 * הפעימה שיוצאת ראשונה היא תמיד "חלוץ", ואחריה "פעימה 1", "פעימה 2".
 */
export function cycleName(index: number): string {
  return index === 0 ? 'חלוץ' : `פעימה ${index}`;
}

export const GENDER_LABEL: Record<string, string> = {
  male: 'בנים',
  female: 'בנות',
};

export const GENDER_LABEL_SINGULAR: Record<string, string> = {
  male: 'זכר',
  female: 'נקבה',
};

export const DIET_LABEL: Record<string, string> = {
  all: 'הכל',
  vegetarian: 'צמחוני',
  vegan: 'טבעוני',
};

/** עובד רגיל מול עובד-לשעבר שהמפקד הוסיף ישירות לצוות. */
export const WORKER_TYPE_LABEL: Record<string, string> = {
  regular: 'עובד רגיל',
  borrowed: 'מושאל (הצ״ח)',
  reserve: 'מילואים',
};

export const USER_STATUS_LABEL: Record<string, string> = {
  pending: 'ממתין לאישור',
  approved: 'מאושר',
  rejected: 'נדחה',
};

export const SIGNUP_STATUS_LABEL: Record<string, string> = {
  pending: 'ממתין לאישור מפקד',
  approved: 'מאושר',
  rejected: 'נדחה',
  cancelled: 'בוטל',
};

/** מצב בקשת הרכב הפרטי בהרשמה. */
export const CAR_STATUS_LABEL: Record<string, string> = {
  none: 'אוטובוס',
  pending: 'ממתין לאישור רכב פרטי',
  approved: 'רכב פרטי מאושר',
  rejected: 'בקשת הרכב נדחתה',
};

/** מצבי מכונת המצבים של הגלישה. */
export const TRIP_STATE_LABEL: Record<string, string> = {
  LAUNCHED: 'פורסם - בשיבוץ אנשים',
  CLOSED: 'סגור',
};

/** הרשאת השיבוץ של המשתמש בגלישה. */
export const SIGNING_AUTHORITY_LABEL: Record<string, string> = {
  leader: 'אחראי שיבוץ',
  delegated: 'שיבוץ באצילה',
};

/** מצב ההגשה של רשימת השיבוץ של מפקד. */
export const SIGNING_SUBMISSION_LABEL: Record<string, string> = {
  submitted: 'הרשימה הוגשה',
  open: 'הרשימה טרם הוגשה',
};

/** מצב הגשת הגלישה על ידי האופרטיבי - ההגשה מקפיאה את השיבוץ לכולם. */
export const TRIP_SUBMISSION_LABEL: Record<string, string> = {
  submitted: 'הגלישה הוגשה',
  open: 'הגלישה טרם הוגשה',
};

export const ISSUE_KIND_LABEL: Record<string, string> = {
  no_preference_met: 'לא קיבל אף העדפה',
  unassigned: 'לא נמצאה מיטה',
};

/** תאריך בפורמט עברי קצר. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** תאריך ושעה, לרשימות התראות. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.endsWith('Z') || value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * צורת רבים פשוטה: "3 חיילים" / "חייל אחד" / "פעימה אחת".
 * המין נדרש כי "אחד" ו"אחת" נגזרים ממין שם העצם: פעימה, התראה והרשמה הן
 * נקביות, חייל ומפקד זכריים.
 */
export function plural(
  count: number,
  singular: string,
  pluralForm: string,
  gender: 'male' | 'female' = 'male',
): string {
  if (count === 1) return `${singular} ${gender === 'female' ? 'אחת' : 'אחד'}`;
  return `${count} ${pluralForm}`;
}
