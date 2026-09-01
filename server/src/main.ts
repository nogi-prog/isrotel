import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE, db } from './db/index.ts';
import { attachUser } from './lib/auth.ts';
import { errorHandler } from './lib/errors.ts';
import { authRouter } from './routes/auth.routes.ts';
import { usersRouter } from './routes/users.routes.ts';
import { tripsRouter } from './routes/trips.routes.ts';
import { signupsRouter } from './routes/signups.routes.ts';
import { busesRouter } from './routes/buses.routes.ts';
import { dormsRouter } from './routes/dorms.routes.ts';
import { reportsRouter } from './routes/reports.routes.ts';
import { shiftsRouter } from './routes/shifts.routes.ts';
import { notificationsRouter } from './routes/notifications.routes.ts';

const PORT = Number(process.env.PORT ?? 4000);

export const app = express();

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  res.json({ ok: true, users: users.count, db: DB_FILE });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/notifications', notificationsRouter);

// כל הראוטרים האלה חולקים את הבסיס /api/trips/:id ומשלימים זה את זה.
app.use('/api/trips', tripsRouter);
app.use('/api/trips', signupsRouter);
app.use('/api/trips', busesRouter);
app.use('/api/trips', dormsRouter);
app.use('/api/trips', reportsRouter);
app.use('/api/trips', shiftsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'נקודת הקצה המבוקשת לא נמצאה' });
});

// בייצור השרת מגיש גם את ה־build של הלקוח.
const webDist = join(import.meta.dirname, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*splat', (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.use(errorHandler);

// בטסטים אין האזנה, וב־Vercel האפליקציה נטענת כ־handler של פונקציה
// serverless ולכן גם שם אין פורט להאזין לו.
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  const server = app.listen(PORT);

  // ההודעה "השרת עלה" נדפסת רק אחרי האזנה מוצלחת. בלי זה, פורט תפוס גרם
  // להודעת הצלחה שקרית ואז ליציאה שקטה - השרת "רץ" אבל אף בקשה לא הגיעה אליו.
  server.on('listening', () => {
    console.log(`[trip-organize] השרת עלה על http://localhost:${PORT}`);
    console.log(`[trip-organize] מסד נתונים: ${DB_FILE}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\n[trip-organize] פורט ${PORT} כבר תפוס - השרת לא עלה.\n` +
          `        כנראה כבר רץ 'npm run dev' אחר (אולי בחלון או בתיקייה אחרת).\n` +
          `        סגירת התהליך הקודם:  npx kill-port ${PORT}\n` +
          `        או הרצה על פורט אחר:  PORT=4001 npm run dev\n`,
      );
    } else {
      console.error(`\n[trip-organize] השרת נכשל בעליה: ${error.message}\n`);
    }
    process.exit(1);
  });
}
