// מעתיק נכסים שאינם TypeScript אל תיקיית ה־build.
import { cpSync, mkdirSync, existsSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
cpSync('src/db/schema.sql', 'dist/db/schema.sql');
console.log('postbuild: copied schema.sql -> dist/db/schema.sql');

// מסד הדמו נשמר ב־repo כדי שפריסה חסרת אחסון קבוע תעלה עם נתונים.
// הוא אופציונלי - סביבה שלא צריכה אותו פשוט לא תמצא אותו.
const SEED_SRC = 'seed/trip-organize.seed.db';
if (existsSync(SEED_SRC)) {
  cpSync(SEED_SRC, 'dist/db/seed.db');
  console.log('postbuild: copied seed database -> dist/db/seed.db');
} else {
  console.log(`postbuild: no seed database at ${SEED_SRC}, skipping`);
}
