/**
 * גיבוב סיסמאות (scrypt, מלוח - node:crypto המובנה, בלי תלות חיצונית) והגנה
 * בסיסית מפני ניחוש בכוח גס. גם דליפה מלאה של מסד הנתונים לא חושפת סיסמה
 * בטקסט גלוי: רק את הגיבוב, שאינו הפיך.
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { tooManyRequests } from './errors.ts';

const SCRYPT_N = 16384; // 2^14 - עלות זיכרון/CPU שמאטה ניחוש בכוח גס, בלי להכביד על בקשה בודדת
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/** מגבב סיסמה לפורמט המאוחסן: `scrypt:N:r:p:salt:hash`, שני החלקים האחרונים ב-base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

/** משווה סיסמה לגיבוב מאוחסן בזמן קבוע (timingSafeEqual), כדי לא לדלוף מידע דרך תזמון התשובה. */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64!, 'base64url');
  const expected = Buffer.from(hashB64!, 'base64url');
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const PASSWORD_MIN_LENGTH = 8;

/** מחזיר הודעת שגיאה בעברית אם הסיסמה חלשה מדי, או null אם היא תקינה. */
export function passwordStrengthError(password: string, companyId?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN_LENGTH} תווים`;
  if (!/[0-9]/.test(password) || !/[A-Za-z]/.test(password)) {
    return 'הסיסמה חייבת להכיל גם אותיות (אנגלית) וגם ספרות';
  }
  if (companyId && password.includes(companyId)) return 'הסיסמה לא יכולה להכיל את המספר האישי';
  return null;
}

const TEMP_PASSWORD_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const TEMP_PASSWORD_DIGITS = '23456789';
const TEMP_PASSWORD_ALL = TEMP_PASSWORD_LETTERS + TEMP_PASSWORD_DIGITS;

/**
 * סיסמה זמנית אקראית וקריאה (בלי תווים מבלבלים כמו 0/O ו-1/l), עם לפחות
 * אות אחת וספרה אחת מובטחות. מוחזרת פעם אחת בלבד בתשובת ה-API לאופרטיבי -
 * אינה נשמרת בשום מקום בטקסט גלוי.
 */
export function generateTempPassword(length = 10): string {
  const chars = [
    TEMP_PASSWORD_LETTERS[randomInt(TEMP_PASSWORD_LETTERS.length)]!,
    TEMP_PASSWORD_DIGITS[randomInt(TEMP_PASSWORD_DIGITS.length)]!,
  ];
  while (chars.length < length) chars.push(TEMP_PASSWORD_ALL[randomInt(TEMP_PASSWORD_ALL.length)]!);
  // ערבוב כדי שהאות והספרה המובטחות לא יהיו תמיד בהתחלה.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

// --- הגבלת קצב ניסיונות התחברות --------------------------------------------
// הגנה בסיסית מפני ניחוש בכוח גס: אחרי כמה נסיונות כושלים ברצף על אותו
// מספר אישי, ההתחברות ננעלת זמנית. במקום זיכרון (Map) בתהליך יחיד - מספיק
// למערכת פנימית בהיקף הזה, ומתאפס בכל הפעלה מחדש של השרת.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface AttemptState {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

const loginAttempts = new Map<string, AttemptState>();

/** זורק אם המספר האישי נעול כרגע עקב יותר מדי נסיונות כושלים. */
export function assertLoginNotLocked(companyId: string): void {
  const state = loginAttempts.get(companyId);
  if (!state) return;
  const remainingMs = state.lockedUntil - Date.now();
  if (remainingMs > 0) {
    const minutes = Math.ceil(remainingMs / 60_000);
    throw tooManyRequests(`יותר מדי נסיונות התחברות כושלים. נסה שוב בעוד ${minutes} דקות, או אפס סיסמה.`);
  }
}

export function recordFailedLogin(companyId: string): void {
  const now = Date.now();
  const state = loginAttempts.get(companyId);
  if (!state || now - state.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(companyId, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  state.count += 1;
  if (state.count >= MAX_FAILED_ATTEMPTS) state.lockedUntil = now + LOCKOUT_MS;
}

export function clearLoginAttempts(companyId: string): void {
  loginAttempts.delete(companyId);
}
