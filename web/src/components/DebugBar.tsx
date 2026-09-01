import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type CurrentUser, type Role } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * פאנל פיתוח למעבר מהיר בין המשתמשים המקושרים בשרשרת פיקוד אחת:
 * מפמ״ר, רת״ח, רמ״ד, אופרטיבי, ר״צ וחייל שכפוף להם. הרשימה מגיעה מהשרת.
 *
 * מוצג רק בפיתוח (`import.meta.env.DEV`), ונקודת הקצה בשרת חסומה בייצור.
 */

interface DebugUser {
  companyId: string;
  fullName: string;
  role: Role;
  roleLabel: string;
  unitName: string | null;
}

/** קיצור התפקיד לכפתור, כדי שהפאנל יישאר צר. מסודר מלמעלה למטה בשרשרת הפיקוד. */
const SHORT_LABEL: Record<Role, string> = {
  ceo: 'מפמ״ר',
  division_leader: 'רת״ח',
  sector_leader: 'רמ״ד',
  to: 'אופרטיבי',
  team_leader: 'ר״צ',
  employee: 'חייל',
};

export function DebugBar() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<DebugUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await api.get<{ users: DebugUser[] }>('/auth/debug-users');
        setUsers(response.users);
      } catch {
        // הפאנל הוא כלי עזר בלבד - כישלון בטעינתו לא אמור להפריע לעבודה.
      }
    })();
  }, []);

  const switchTo = async (companyId: string) => {
    setError('');
    setBusy(companyId);
    try {
      const response = await api.post<{ token: string; user: CurrentUser }>('/auth/debug-login', { companyId });
      signIn(response.token, response.user);
      // חוזרים לדף הבית - למשתמש החדש אין בהכרח הרשאה למסך הנוכחי.
      navigate('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'המעבר נכשל');
    } finally {
      setBusy(null);
    }
  };

  if (users.length === 0) return null;

  return (
    <div className="debugbar">
      <span className="debugbar__label" title="מוצג בפיתוח בלבד">
        מעבר מהיר
      </span>

      <div className="debugbar__buttons">
        {users.map((entry) => {
          const active = user?.companyId === entry.companyId;
          return (
            <button
              key={entry.companyId}
              type="button"
              className={`debugbar__btn${active ? ' debugbar__btn--active' : ''}`}
              disabled={busy !== null}
              title={`${entry.fullName} · ${entry.unitName ?? ''} · ${entry.companyId}`}
              onClick={() => void switchTo(entry.companyId)}
            >
              {SHORT_LABEL[entry.role]}
            </button>
          );
        })}
      </div>

      <span className="debugbar__current">
        {user ? `${user.fullName} · ${user.companyId}` : 'לא מחובר'}
      </span>

      {error && <span className="debugbar__error">{error}</span>}
    </div>
  );
}
