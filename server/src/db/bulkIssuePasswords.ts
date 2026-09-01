/**
 * הנפקת סיסמאות זמניות בבת אחת לכל מי שעדיין אין לו סיסמה (password_hash
 * NULL) - הכלי הזה קיים בשביל עלייה לאוויר בפני כל החברה בבת אחת, שבה עשרות
 * או מאות אנשים מגיעים למסך ההתחברות באותו יום. במקום שכל אחד ילחץ "שכחתי
 * סיסמה" ויחכה שהאופרטיבי יטפל בבקשה שלו בנפרד (התהליך הרגיל, ראו
 * /auth/forgot-password), הכלי מריץ את אותה פעולה בדיוק (generateTempPassword
 * + hashPassword, ראו POST /auth/password-resets/:id/resolve) על כולם ומוציא
 * רשימה אחת, ממוינת לפי יחידה, שכל ר״צ/רמ״ד יכול לחלק לאנשים שלו.
 *
 * כמו POST /password-resets/:id/resolve - הסיסמה הזמנית עצמה לא נשמרת
 * בשום מקום בטקסט גלוי חוץ מהקובץ שהכלי הזה מפיק. הקובץ נכתב לתוך
 * server/data/, שכבר לגמרי מוחרג ב-.gitignore, אבל הוא עדיין רגיש: יש
 * להדפיס/לחלק ואז למחוק אותו.
 *
 * הרצה:  DB_FILE=<path> node --experimental-strip-types server/src/db/bulkIssuePasswords.ts [--dry-run] [--out <path>]
 * --dry-run מראה כמה חשבונות ייפגעו בלי לשנות כלום ובלי לכתוב קובץ.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db, tx } from './index.ts';
import { generateTempPassword, hashPassword } from '../lib/password.ts';
import { fullName, resolveUnits } from '../lib/org.ts';
import { ROLE_LABEL } from '../types.ts';
import type { UserRow } from '../types.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const outIndex = process.argv.indexOf('--out');
const OUT_PATH =
  outIndex !== -1 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]!
    : join(import.meta.dirname, '..', '..', 'data', `bulk-passwords-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`);

/** שדה יחיד ל-CSV לפי RFC4180: מרכאות סביב שדה שמכיל פסיק, מרכאות או שורה חדשה. */
function csvField(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const rows = (db.prepare(`SELECT * FROM users WHERE password_hash IS NULL ORDER BY id`).all() as unknown[]).map(
  (row) => row as UserRow,
);

if (rows.length === 0) {
  console.log('כולם כבר מוגדרים עם סיסמה - אין למי להנפיק.');
  process.exit(0);
}

// יחידה מלאה (תחום / מדור / צוות) לכל שורה, כדי למיין ולחלק לפי מי שמפיץ בפועל.
const withUnit = rows.map((user) => {
  const units = resolveUnits(db, user.id);
  return {
    user,
    unitPath: [units.division?.name, units.sector?.name, units.team?.name].filter(Boolean).join(' / '),
  };
});
withUnit.sort((a, b) => a.unitPath.localeCompare(b.unitPath, 'he') || fullName(a.user).localeCompare(fullName(b.user), 'he'));

console.log(`${DRY_RUN ? '[dry-run] ' : ''}${withUnit.length} חשבונות בלי סיסמה מוגדרת:`);
const byUnit = new Map<string, number>();
for (const { unitPath } of withUnit) byUnit.set(unitPath || '(ללא יחידה)', (byUnit.get(unitPath || '(ללא יחידה)') ?? 0) + 1);
for (const [unit, count] of byUnit) console.log(`  ${unit}: ${count}`);

if (DRY_RUN) {
  console.log('\n[dry-run] שום דבר לא נשמר ולא נכתב. הרצה בלי --dry-run תנפיק סיסמאות בפועל.');
  process.exit(0);
}

const lines: string[] = [['מספר אישי', 'שם מלא', 'תפקיד', 'יחידה', 'מפקד ישיר', 'סיסמה זמנית'].map(csvField).join(',')];

tx(() => {
  const update = db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`);
  for (const { user, unitPath } of withUnit) {
    const tempPassword = generateTempPassword();
    update.run(hashPassword(tempPassword), user.id);

    const manager = user.manager_id != null ? (db.prepare('SELECT * FROM users WHERE id = ?').get(user.manager_id) as UserRow | undefined) : undefined;
    lines.push(
      [user.company_id, fullName(user), ROLE_LABEL[user.role], unitPath, manager ? fullName(manager) : '', tempPassword]
        .map(csvField)
        .join(','),
    );
  }
});

mkdirSync(dirname(OUT_PATH), { recursive: true });
// ה-BOM נחוץ כדי ש-Excel יזהה UTF-8 ולא יקרא את העברית כג'יבריש - כמו בייצוא הרגיל.
writeFileSync(OUT_PATH, '﻿' + lines.join('\r\n'), 'utf8');

console.log(`\n${withUnit.length} סיסמאות זמניות הונפקו ונשמרו ב-${OUT_PATH}`);
console.log('כולם מסומנים must_change_password - יחויבו להחליף לסיסמה קבועה מיד עם הכניסה הראשונה.');
console.log('\n⚠ הקובץ מכיל סיסמאות בטקסט גלוי. חלקו אותו (לפי יחידה) ואז מחקו אותו - הוא לא נשמר בשום מקום אחר.');
