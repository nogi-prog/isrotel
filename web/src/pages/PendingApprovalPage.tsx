import { useAuth } from '../lib/auth';
import { DIET_LABEL, ROLE_LABEL_LONG, USER_STATUS_LABEL } from '../lib/he';
import { Alert } from '../components/ui';

/** מסך חסימה עד שהמפקד מאשר את הרישום. */
export function PendingApprovalPage() {
  const { user, signOut, refresh } = useAuth();
  if (!user) return null;

  const rejected = user.status === 'rejected';

  return (
    <div className="auth">
      <div className="auth__card">
        <h1 className="auth__title">{rejected ? 'הרישום נדחה' : 'הרישום ממתין לאישור'}</h1>
        <p className="auth__subtitle">
          {rejected
            ? 'המפקד שלך דחה את בקשת הרישום. יש לפנות אליו לקבלת פרטים.'
            : `הפרטים נשמרו ונשלחו לאישור של ${user.managerName ?? 'המפקד שלך'}.`}
        </p>

        <Alert kind={rejected ? 'error' : 'warn'}>
          מצב הרישום: <strong>{USER_STATUS_LABEL[user.status]}</strong>
        </Alert>

        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th>שם</th>
                <td>{user.fullName}</td>
              </tr>
              <tr>
                <th>מספר אישי</th>
                <td>{user.companyId}</td>
              </tr>
              <tr>
                <th>תפקיד</th>
                <td>{ROLE_LABEL_LONG[user.role]}</td>
              </tr>
              <tr>
                <th>מפקד</th>
                <td>{user.managerName ?? '—'}</td>
              </tr>
              <tr>
                <th>העדפת תזונה</th>
                <td>{DIET_LABEL[user.diet]}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn--primary" onClick={() => void refresh()}>
            בדוק שוב
          </button>
          <button type="button" className="btn btn--ghost" onClick={signOut}>
            יציאה
          </button>
        </div>
      </div>
    </div>
  );
}
