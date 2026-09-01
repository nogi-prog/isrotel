import { useAuth } from '../lib/auth';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

/**
 * מסך חובה אחרי איפוס סיסמה על ידי האופרטיבי (must_change_password) - אין
 * גישה לשאר המערכת עד שהמשתמש מחליף את הסיסמה הזמנית לסיסמה קבועה משלו.
 * מוצג על ידי App.tsx לפני הראוטים הרגילים, בדיוק כמו PendingApprovalPage.
 */
export function ChangePasswordRequiredPage() {
  const { refresh } = useAuth();

  return (
    <div className="auth">
      <div className="auth__card">
        <h1 className="auth__title">נדרשת החלפת סיסמה</h1>
        <p className="auth__subtitle">
          הסיסמה שלך אופסה על ידי האופרטיבי. יש להחליף אותה לסיסמה קבועה משלך לפני המשך השימוש במערכת.
        </p>

        <ChangePasswordForm
          requireCurrent
          currentLabel="הסיסמה הזמנית שקיבלת מהאופרטיבי"
          submitLabel="החלפת הסיסמה והמשך"
          onSuccess={() => void refresh()}
        />
      </div>
    </div>
  );
}
