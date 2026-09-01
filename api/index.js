/**
 * נקודת הכניסה של ה־API ב־Vercel.
 *
 * כל /api/* מנותב לכאן דרך rewrite ב־vercel.json, שמעביר את הנתיב המקורי
 * בפרמטר `__path`. הנתיב מורכב מחדש לתוך `req.url` לפני המסירה ל־express,
 * כדי שהראוטרים שממופים ל-/api/... יעבדו בלי שינוי.
 *
 * (ראוט catch-all בשם `[...path].js` היה פתרון טבעי יותר, אבל ה־CLI מייצר
 * עבורו regex של מקטע יחיד ולכן נתיבים עמוקים כמו /api/auth/login מחזירים
 * 404 ברמת הפלטפורמה.)
 */
import { app } from '../server/dist/main.js';

const PATH_PARAM = '__path';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get(PATH_PARAM) ?? '';
  url.searchParams.delete(PATH_PARAM);

  const query = url.searchParams.toString();
  req.url = `/api/${path}${query ? `?${query}` : ''}`;

  return app(req, res);
}
