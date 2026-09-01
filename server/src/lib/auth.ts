import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { db } from '../db/index.ts';
import { getUser } from './org.ts';
import { forbidden, unauthorized } from './errors.ts';
import type { Role, UserRow } from '../types.ts';

const SECRET = process.env.SESSION_SECRET ?? 'trip-organize-dev-secret-change-me';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // שבועיים

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[auth] SESSION_SECRET לא הוגדר - נעשה שימוש בסוד פיתוח. אין להריץ כך בייצור.');
}

interface TokenPayload {
  userId: number;
  companyId: string;
  exp: number;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const sign = (data: string) => createHmac('sha256', SECRET).update(data).digest('base64url');

/** יוצר טוקן חתום (HMAC-SHA256) עבור המשתמש. */
export function createToken(user: UserRow): string {
  const payload: TokenPayload = {
    userId: user.id,
    companyId: user.company_id,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** מאמת טוקן ומחזיר את תוכנו, או null אם אינו תקין / פג תוקף. */
export function readToken(token: string): TokenPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.userId !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return null;
}

/** טוען את המשתמש המאומת אל הבקשה, בלי לדרוש התחברות. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token) {
    const payload = readToken(token);
    if (payload) {
      const user = getUser(db, payload.userId);
      if (user) req.currentUser = user;
    }
  }
  next();
}

/** מחזיר את המשתמש המאומת או זורק 401. */
export function requireUser(req: Request): UserRow {
  if (!req.currentUser) throw unauthorized();
  return req.currentUser;
}

/** דורש התחברות. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  requireUser(req);
  next();
};

/** דורש שהרישום של המשתמש אושר על ידי המפקד. */
export const requireApproved: RequestHandler = (req, _res, next) => {
  const user = requireUser(req);
  if (user.status !== 'approved') {
    throw forbidden('הרישום שלך ממתין לאישור המפקד');
  }
  next();
};

/** דורש תפקיד מסוים. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = requireUser(req);
    if (!roles.includes(user.role)) throw forbidden('אין לך הרשאה לפעולה הזו');
    next();
  };
}

/** דורש הרשאת אופרטיבי. */
export const requireTO: RequestHandler = (req, _res, next) => {
  const user = requireUser(req);
  if (user.role !== 'to') throw forbidden('הפעולה מותרת לאופרטיבי בלבד');
  next();
};
