import { useState } from 'react';
import { api, type CurrentUser } from '../lib/api';
import { errorMessage } from '../lib/useApi';
import { Alert, Field } from './ui';

/**
 * טופס החלפת סיסמה - משמש גם במסך הפרופיל (המשתמש בוחר להחליף) וגם במסך
 * "חובה להחליף סיסמה" אחרי איפוס על ידי האופרטיבי. ההבדל היחיד הוא הכיתוב
 * מעל שדה הסיסמה הנוכחית - בפרופיל זו הסיסמה של המשתמש, ואחרי איפוס זו
 * הסיסמה הזמנית שקיבל מהאופרטיבי.
 */
export function ChangePasswordForm({
  requireCurrent,
  currentLabel = 'סיסמה נוכחית',
  submitLabel = 'שמירת הסיסמה',
  onSuccess,
}: {
  requireCurrent: boolean;
  currentLabel?: string;
  submitLabel?: string;
  onSuccess: (user: CurrentUser) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('הסיסמאות החדשות אינן תואמות');
      return;
    }

    setBusy(true);
    try {
      const response = await api.patch<{ ok: true; user: CurrentUser }>('/auth/password', {
        ...(requireCurrent ? { currentPassword } : {}),
        newPassword,
      });
      onSuccess(response.user);
    } catch (caught) {
      setError(errorMessage(caught, 'החלפת הסיסמה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <Alert kind="error">{error}</Alert>

      {requireCurrent && (
        <Field label={currentLabel}>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </Field>
      )}

      <Field label="סיסמה חדשה" hint="לפחות 8 תווים, אותיות (אנגלית) וגם ספרות">
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus={!requireCurrent}
        />
      </Field>

      <Field label="אימות סיסמה חדשה">
        <input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>

      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'שומר...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
