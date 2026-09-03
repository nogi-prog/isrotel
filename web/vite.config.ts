import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 תפוס לעתים על ידי פרויקטים אחרים, ולכן נבחר פורט ייחודי לפרויקט הזה.
    port: 5273,
    // מאזין על כל הממשקים (לא רק localhost) - כדי שאפשר יהיה להתחבר מהרשת המקומית.
    host: true,
    // בלי זה vite עובר בשקט ל-5274 כשהפורט תפוס, והדפדפן ב-5273 ממשיך להציג
    // את הלקוח הישן - נראה כאילו שינויים בקוד לא נתפסים. עדיף להיכשל ברעש.
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          // ברירת המחדל של vite היא שגיאת ECONNREFUSED סתמית. כאן מוחזרת
          // תשובת JSON שהלקוח יודע להציג, יחד עם הסבר ברור בטרמינל.
          proxy.on('error', (error, _req, res) => {
            const refused = (error as NodeJS.ErrnoException).code === 'ECONNREFUSED';
            if (refused) {
              console.error(
                `\n[proxy] השרת אינו זמין ב-${API_TARGET}.\n` +
                  `        יש להריץ את השרת: npm run dev (מריץ שרת ולקוח יחד)\n` +
                  `        או בנפרד: npm run dev:server\n`,
              );
            }

            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  error: refused
                    ? 'השרת אינו זמין. יש להריץ את השרת (npm run dev).'
                    : 'שגיאה בתקשורת עם השרת.',
                }),
              );
            }
          });
        },
      },
    },
  },
});
