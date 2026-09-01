import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/useApi';
import { Alert } from './ui';

/**
 * ייצוא ה-Excel מקביל לגיליון שבו נוהלו הגלישות לפני המערכת: שורה אחת לכל
 * משתתף מאושר בכל פעימה. ההורדה חייבת לעבור דרך api.download ולא קישור
 * רגיל, כי האימות מבוסס Bearer בכותרת ולא בעוגייה - ראו lib/api.ts.
 * זמין לאופרטיבי (כל הגלישה) ולרת״ח (התחום שלו בלבד) - ראו requireRole
 * ב-reports.routes.ts בשרת.
 */
export function ExportRosterButton({ tripId, tripName }: { tripId: number | string; tripName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setError('');
    setBusy(true);
    try {
      await api.download(`/trips/${tripId}/export.xlsx`, `${tripName}.xlsx`);
    } catch (caught) {
      setError(errorMessage(caught, 'הורדת הקובץ נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void download()}>
        {busy ? 'מוריד...' : 'ייצוא Excel'}
      </button>
    </>
  );
}
