import { useState } from 'react';
import { api, type PasswordResetRequest } from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import { ROLE_LABEL, formatDateTime } from '../lib/he';
import { Alert, Badge, Card, Empty, Loading } from '../components/ui';

/**
 * מסך "שכחתי סיסמה" - לאופרטיבי בלבד. כל בקשה מאפסת סיסמה למשתמש ומייצרת
 * סיסמה זמנית שמוצגת פעם אחת בלבד, מיד אחרי האיפוס - היא לא נשמרת בשום
 * מקום בטקסט גלוי, ולכן אין דרך לשלוף אותה שוב. יש להעביר אותה למשתמש
 * מחוץ למערכת (בעל פה / פנים אל פנים), ולא בהודעה כתובה.
 */
export function PasswordResetsPage() {
  const { data, loading, error, reload } = useApi<{ requests: PasswordResetRequest[] }>('/auth/password-resets');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [resolved, setResolved] = useState<{ fullName: string; companyId: string; tempPassword: string } | null>(
    null,
  );

  const resolve = async (request: PasswordResetRequest) => {
    setActionError('');
    setBusyId(request.id);
    try {
      const response = await api.post<{
        ok: true;
        tempPassword: string;
        user: { id: number; fullName: string; companyId: string };
      }>(`/auth/password-resets/${request.id}/resolve`, {});
      setResolved({
        fullName: response.user.fullName,
        companyId: response.user.companyId,
        tempPassword: response.tempPassword,
      });
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (request: PasswordResetRequest) => {
    setActionError('');
    setBusyId(request.id);
    try {
      await api.post(`/auth/password-resets/${request.id}/dismiss`, {});
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const requests = data?.requests ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>איפוס סיסמאות</h1>
          <p>בקשות "שכחתי סיסמה" שממתינות - האיפוס מייצר סיסמה זמנית להעביר למבקש/ת מחוץ למערכת</p>
        </div>
      </div>

      {resolved && (
        <Alert kind="success">
          <div className="stack" style={{ gap: '0.4rem' }}>
            <strong>
              הסיסמה של {resolved.fullName} ({resolved.companyId}) אופסה. הסיסמה הזמנית:
            </strong>
            <code style={{ fontSize: '1.1rem', userSelect: 'all' }}>{resolved.tempPassword}</code>
            <span className="small muted">
              מוצגת כאן פעם אחת בלבד - יש להעביר אותה למבקש/ת בעל פה או פנים אל פנים, לא בהודעה כתובה. הוא/היא
              יידרש/תידרש להחליף אותה מיד עם הכניסה.
            </span>
            <div>
              <button type="button" className="btn btn--sm" onClick={() => setResolved(null)}>
                סגירה
              </button>
            </div>
          </div>
        </Alert>
      )}

      <Alert kind="error">{error || actionError}</Alert>

      <Card title="בקשות ממתינות" actions={<Badge kind={requests.length > 0 ? 'warn' : 'ok'}>{requests.length}</Badge>}>
        {loading ? (
          <Loading />
        ) : requests.length === 0 ? (
          <Empty>אין בקשות איפוס סיסמה שממתינות.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>שם</th>
                  <th>מספר אישי</th>
                  <th>תפקיד</th>
                  <th>נשלחה</th>
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="שם">{request.user.fullName}</td>
                    <td data-label="מספר אישי">{request.user.companyId}</td>
                    <td data-label="תפקיד">
                      {ROLE_LABEL[request.user.role]}
                      {request.user.unitName ? ` · ${request.user.unitName}` : ''}
                    </td>
                    <td className="muted" data-label="נשלחה">
                      {formatDateTime(request.requestedAt)}
                    </td>
                    <td data-label="פעולות">
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={busyId === request.id}
                          onClick={() => void resolve(request)}
                        >
                          איפוס והפקת סיסמה זמנית
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busyId === request.id}
                          onClick={() => void dismiss(request)}
                        >
                          התעלמות
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
