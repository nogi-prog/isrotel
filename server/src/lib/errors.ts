import type { NextFunction, Request, Response } from 'express';

/** שגיאה עם קוד HTTP, מתורגמת אוטומטית לתשובת JSON. */
export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'נדרשת התחברות') => new HttpError(401, message);
export const forbidden = (message = 'אין לך הרשאה לפעולה הזו') => new HttpError(403, message);
export const notFound = (message = 'הפריט המבוקש לא נמצא') => new HttpError(404, message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, details);
export const tooManyRequests = (message: string) => new HttpError(429, message);

/** middleware לטיפול בשגיאות - חייב להיות אחרון בשרשרת. */
export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, details: error.details ?? undefined });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  // הפרות אילוצים של SQLite מתורגמות לשגיאת קונפליקט קריאה.
  if (/UNIQUE constraint failed/i.test(message)) {
    res.status(409).json({ error: 'הרשומה כבר קיימת במערכת' });
    return;
  }
  if (/CHECK constraint failed|FOREIGN KEY constraint failed/i.test(message)) {
    res.status(400).json({ error: 'הנתונים שנשלחו אינם תקינים' });
    return;
  }

  console.error('[unhandled]', error);
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
}
