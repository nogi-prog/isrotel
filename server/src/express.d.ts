import type { UserRow } from './types.ts';

declare global {
  namespace Express {
    interface Request {
      /** המשתמש המאומת של הבקשה, אם נשלח טוקן תקין. */
      currentUser?: UserRow;
    }
  }
}

export {};
