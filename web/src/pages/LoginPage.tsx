import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type CurrentUser,
  type Diet,
  type Gender,
  type LoginResponse,
  type Role,
  type RoommateOption,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { DIET_LABEL, GENDER_LABEL_SINGULAR, NO_ALLERGIES, ROLE_LABEL_LONG } from '../lib/he';
import { Alert, Badge, Field } from '../components/ui';
import { ManagerPicker, useEligibleManagers } from '../components/ManagerPicker';

type Step = 'login' | 'forgot-sent' | 'register';

/** התפקידים שאפשר להירשם בהם, מלמעלה למטה. האופרטיבי אינו נרשם - הוא מוגדר במערכת. */
const REGISTRABLE_ROLES: Role[] = ['ceo', 'division_leader', 'sector_leader', 'team_leader', 'employee'];

/** אותה בדיקה כמו בשרת (lib/password.ts) - כדי לתת משוב מיידי בלי סיבוב לשרת. */
function passwordStrengthError(value: string): string | null {
  if (value.length < 8) return 'הסיסמה חייבת להכיל לפחות 8 תווים';
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return 'הסיסמה חייבת להכיל גם אותיות (אנגלית) וגם ספרות';
  return null;
}

/** אותה בדיקה כמו בשרת (lib/phone.ts) - כדי לתת משוב מיידי בלי סיבוב לשרת. */
const PHONE_PATTERN = /^0\d{8,9}$/;

export function LoginPage() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>('login');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // מסך הכניסה מציג מספר אישי וסיסמה יחד, בטופס אחד - לא בשני שלבים
  // נפרדים. אם המספר האישי אינו רשום, הלקוח עובר להרשמה עם אותה סיסמה
  // שכבר הוקלדה (נוח למי שלא ידע אם הוא רשום). אם רשום אבל בלי סיסמה
  // מוגדרת (חשבון מלפני הוספת האימות), מוצגת הצעה לבקש איפוס באותו מסך.
  const [noPasswordSet, setNoPasswordSet] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');

  // שדות ההרשמה הראשונית
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [diet, setDiet] = useState<Diet>('all');
  const [role, setRole] = useState<Role>('employee');
  const [unitName, setUnitName] = useState('');
  const [phone, setPhone] = useState('');
  const [allergies, setAllergies] = useState('');
  const [managerId, setManagerId] = useState<number | null>(null);
  // מסומן אחרי ניסיון שמירה ראשון - מציג שדות חובה ריקים באדום (ראו Field).
  const [attempted, setAttempted] = useState(false);
  const [roommatePreferences, setRoommatePreferences] = useState<number[]>([]);
  // אותו state של הסיסמה משמש גם לניסיון ההתחברות וגם, אם התברר שהמספר
  // האישי לא רשום, כברירת מחדל לשדה הסיסמה בטופס ההרשמה.
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // השרת קובע מי המפקדים האפשריים ואם מדובר בהרשמה בלי מפקד בכלל.
  const eligible = useEligibleManagers(role);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNoPasswordSet(false);
    setBusy(true);
    try {
      const response = await api.post<LoginResponse>(
        '/auth/login',
        password ? { companyId, password } : { companyId },
      );

      if (!response.registered) {
        setStep('register');
        return;
      }
      if (response.token && response.user) {
        signIn(response.token, response.user);
        return;
      }
      if (!response.hasPassword) {
        setNoPasswordSet(true);
        return;
      }
      // רשום ויש לו סיסמה, אבל השדה נשלח ריק - כנראה נשכח למלא.
      setError('יש להזין סיסמה');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'שגיאה בהתחברות');
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    setError('');
    setBusy(true);
    try {
      const response = await api.post<{ ok: true; message: string }>('/auth/forgot-password', { companyId });
      setForgotMessage(response.message);
      setStep('forgot-sent');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'שליחת הבקשה נכשלה');
    } finally {
      setBusy(false);
    }
  };

  const backToStart = () => {
    setError('');
    setNoPasswordSet(false);
    setStep('login');
  };

  const needsManager = !eligible.rootRegistration;
  const needsUnitName = role !== 'employee';
  const firstNameInvalid = attempted && firstName.trim().length < 2;
  const lastNameInvalid = attempted && lastName.trim().length < 2;
  const genderInvalid = attempted && !gender;
  const phoneInvalid = attempted && !PHONE_PATTERN.test(phone.trim().replace(/[\s-]/g, ''));
  const unitNameInvalid = attempted && needsUnitName && !unitName.trim();
  const managerInvalid = attempted && needsManager && managerId == null;
  const passwordInvalid = attempted && !!passwordStrengthError(password);
  const confirmPasswordInvalid = attempted && password !== confirmPassword;

  const submitRegistration = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setAttempted(true);

    if (!gender) {
      setError('חובה לבחור מין');
      return;
    }
    const passwordError = passwordStrengthError(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setError('הסיסמאות אינן תואמות');
      return;
    }
    if (!PHONE_PATTERN.test(phone.trim().replace(/[\s-]/g, ''))) {
      setError('מספר טלפון לא תקין - יש להזין מספר ישראלי בן 9-10 ספרות');
      return;
    }
    if (needsUnitName && !unitName.trim()) {
      setError('למפקד חובה להזין שם יחידה');
      return;
    }
    // למי שנרשם בראש השרשרת (מפמ״ר), או כשאין עדיין מפקד מאושר מהדרג שמעליו,
    // אין מפקד לבחור - השרת מסמן את זה ב־rootRegistration.
    if (needsManager && managerId == null) {
      setError('חובה לבחור מפקד');
      return;
    }

    setBusy(true);
    try {
      const response = await api.post<{ token: string; user: CurrentUser }>('/auth/register', {
        companyId,
        password,
        confirmPassword,
        firstName,
        lastName,
        gender,
        diet,
        role,
        phone,
        ...(allergies.trim() ? { allergies: allergies.trim() } : {}),
        ...(needsManager ? { managerId } : {}),
        ...(role === 'employee' ? {} : { unitName }),
        // בחירת שותפים אינה חובה - נשלחת רק אם נבחרו.
        ...(roommatePreferences.length > 0 ? { roommatePreferences } : {}),
      });
      signIn(response.token, response.user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'שגיאה ברישום');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'login') {
    return (
      <div className="auth">
        <form className="auth__card" onSubmit={submitLogin}>
          <h1 className="auth__title">ישרוטל</h1>
          <p className="auth__subtitle">כניסה באמצעות מספר אישי וסיסמה</p>

          <Alert kind="error">{error}</Alert>

          <Field label="מספר אישי" hint="7 ספרות">
            <input
              value={companyId}
              onChange={(event) => {
                setCompanyId(event.target.value.replace(/\D/g, '').slice(0, 7));
                setNoPasswordSet(false);
              }}
              inputMode="numeric"
              autoComplete="username"
              placeholder="1234567"
              required
              autoFocus
            />
          </Field>

          <Field label="סיסמה" hint="משתמש/ת חדש/ה? אפשר להשאיר ריק ולבחור סיסמה בהרשמה">
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setNoPasswordSet(false);
              }}
              autoComplete="current-password"
            />
          </Field>

          {noPasswordSet && (
            <Alert kind="warn">
              עדיין לא הוגדרה סיסמה למספר האישי הזה. יש לבקש איפוס מהאופרטיבי כדי לקבל סיסמה זמנית.
            </Alert>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy || companyId.length !== 7}>
            {busy ? 'בודק...' : 'התחברות'}
          </button>

          <div className="row row--between" style={{ marginTop: '0.75rem' }}>
            <span />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || companyId.length !== 7}
              onClick={() => void requestReset()}
            >
              שכחתי סיסמה
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (step === 'forgot-sent') {
    return (
      <div className="auth">
        <div className="auth__card">
          <h1 className="auth__title">הבקשה נשלחה</h1>
          <Alert kind="success">{forgotMessage}</Alert>
          <p className="auth__subtitle">
            האופרטיבי יעביר לך סיסמה זמנית מחוץ למערכת (בעל פה / פנים אל פנים). אחרי הכניסה איתה תידרש/י
            להחליף אותה לסיסמה קבועה משלך.
          </p>
          <button type="button" className="btn btn--primary btn--block" onClick={backToStart}>
            חזרה למסך ההתחברות
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submitRegistration}>
        <h1 className="auth__title">השלמת פרטים</h1>
        <p className="auth__subtitle">
          זו הכניסה הראשונה שלך עם מספר אישי <strong>{companyId}</strong>
        </p>

        <Alert kind="error">{error}</Alert>

        <div className="field-row">
          <Field label="שם פרטי" invalid={firstNameInvalid}>
            <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
          </Field>
          <Field label="שם משפחה" invalid={lastNameInvalid}>
            <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
          </Field>
        </div>

        <Field label="טלפון" hint="לדוגמה 0501234567" invalid={phoneInvalid}>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            autoComplete="tel"
            placeholder="0501234567"
            required
          />
        </Field>

        <div className="field-row">
          <Field label="סיסמה" hint="לפחות 8 תווים, אותיות (אנגלית) וגם ספרות" invalid={passwordInvalid}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="אימות סיסמה" invalid={confirmPasswordInvalid}>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label="מין" hint="קובע את שיוך מבנה הלינה" invalid={genderInvalid}>
            <select value={gender} onChange={(event) => setGender(event.target.value as Gender)} required>
              <option value="">בחר...</option>
              <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
              <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
            </select>
          </Field>

          <Field label="העדפת תזונה">
            <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
              {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
                <option key={option} value={option}>
                  {DIET_LABEL[option]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="אלרגיות" hint={`לא חובה - ברירת המחדל היא "${NO_ALLERGIES}"`}>
          <input value={allergies} onChange={(event) => setAllergies(event.target.value)} placeholder={NO_ALLERGIES} />
        </Field>

        <Field label="תפקיד">
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {REGISTRABLE_ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABEL_LONG[option]}
              </option>
            ))}
          </select>
        </Field>

        {role !== 'employee' && (
          <Field
            label="שם היחידה שבפיקודך"
            hint="לדוגמה: צוות אלון / מדור תוכנה / תחום פיתוח / כל החברה"
            invalid={unitNameInvalid}
          >
            <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
          </Field>
        )}

        <ManagerPicker role={role} options={eligible} value={managerId} onChange={setManagerId} />
        {managerInvalid && <Alert kind="error">חובה לבחור מפקד</Alert>}

        <RoommatePreferencePicker
          gender={gender}
          role={role}
          value={roommatePreferences}
          onChange={setRoommatePreferences}
        />

        <div className="row">
          {/* עד שרשימת המפקדים נטענת עוד לא ידוע אם נדרש מפקד, ולכן ההגשה חסומה */}
          <button type="submit" className="btn btn--primary" disabled={busy || eligible.loading}>
            {busy ? 'שולח...' : 'שלח לאישור המפקד'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={backToStart}>
            חזרה
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * בחירת שותפים מועדפים לחדר בזמן ההרשמה - לא חובה.
 *
 * הרשימה תלויה במין ובתפקיד (דרג ניהולי מדויק), ולכן היא נטענת מחדש בכל
 * שינוי שלהם ומתאפסת - בחירה שכבר אינה חוקית לא תישלח. מי שמדלג כאן יכול
 * להשלים את הבחירה בכל עת במסך הפרופיל.
 */
function RoommatePreferencePicker({
  gender,
  role,
  value,
  onChange,
}: {
  gender: Gender | '';
  role: Role;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [candidates, setCandidates] = useState<RoommateOption[]>([]);
  const [max, setMax] = useState(3);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!gender) {
      setCandidates([]);
      setNote('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    // שינוי במין/בתפקיד/במפקד משנה את קבוצת המועמדים החוקית - הבחירה מתאפסת.
    onChange([]);
    setQuery('');

    void (async () => {
      const params = new URLSearchParams({ gender, role });
      try {
        const response = await api.get<{ max: number; candidates: RoommateOption[]; note?: string }>(
          `/auth/roommate-candidates?${params}`,
        );
        if (cancelled) return;
        setCandidates(response.candidates);
        setMax(response.max);
        setNote(response.note ?? '');
      } catch {
        if (!cancelled) {
          setCandidates([]);
          setNote('לא ניתן לטעון את רשימת המועמדים. אפשר להשלים את הבחירה בהמשך במסך הפרופיל.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // onChange יציב (setState), ואין צורך לרענן בגללו.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, role]);

  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);

  const filtered = useMemo(() => {
    const term = query.trim();
    if (!term) return candidates;
    return candidates.filter(
      (candidate) => candidate.fullName.includes(term) || candidate.unitPath.includes(term),
    );
  }, [candidates, query]);

  const toggle = (id: number) => {
    onChange(
      value.includes(id) ? value.filter((entry) => entry !== id) : value.length >= max ? value : [...value, id],
    );
  };

  if (!gender) return null;

  return (
    <div className="field">
      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
        עם מי היית רוצה לישון? (לא חובה, עד {max}) <Badge>{value.length}/{max}</Badge>
      </span>

      {note && <Alert kind="info">{note}</Alert>}

      {loading ? (
        <span className="field__hint">טוען מועמדים...</span>
      ) : candidates.length === 0 ? (
        !note && (
          <span className="field__hint">
            אין כרגע מועמדים מתאימים. אפשר להשלים את הבחירה בהמשך במסך הפרופיל.
          </span>
        )
      ) : (
        <>
          {value.length > 0 && (
            <ul className="pref-list" style={{ marginBottom: '0.5rem' }}>
              {value.map((id, index) => (
                <li key={id} className="pref-item">
                  <span>
                    <Badge>{index + 1}</Badge> {byId.get(id)?.fullName ?? id}
                    <span className="muted small"> · {byId.get(id)?.unitPath}</span>
                  </span>
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => toggle(id)}>
                    הסר
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="חיפוש לפי שם או יחידה"
            autoComplete="off"
          />

          <div className="table-wrap" style={{ maxHeight: '220px', overflowY: 'auto', marginTop: '0.5rem' }}>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>שם</th>
                  <th>יחידה</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      לא נמצאו תוצאות.
                    </td>
                  </tr>
                ) : (
                  filtered.map((candidate) => (
                    <tr key={candidate.id}>
                      <td data-label="בחירה">
                        <input
                          type="checkbox"
                          checked={value.includes(candidate.id)}
                          disabled={!value.includes(candidate.id) && value.length >= max}
                          onChange={() => toggle(candidate.id)}
                          aria-label={`בחר את ${candidate.fullName}`}
                        />
                      </td>
                      <td data-label="שם">{candidate.fullName}</td>
                      <td className="muted" data-label="יחידה">
                        {candidate.unitPath}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <span className="field__hint">
        בנים עם בנים ובנות עם בנות, וחיילים עם חיילים. השיבוץ ינסה לכבד את הבקשה, אבל אינו מתחייב.
      </span>
    </div>
  );
}
