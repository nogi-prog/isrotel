/** מספר טלפון ישראלי: מתחיל ב-0, 9-10 ספרות בסך הכול (אחרי הסרת מקפים/רווחים). */
export const PHONE_PATTERN = /^0\d{8,9}$/;

export function normalizePhone(value: string): string {
  return value.trim().replace(/[\s-]/g, '');
}
