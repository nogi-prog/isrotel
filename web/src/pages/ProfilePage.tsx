import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Diet,
  type Gender,
  type HierarchyMember,
  type MoveRequest,
  type ProfileEditRequest,
  type Role,
  type RoommateOption,
  type TeamMember,
  type UserSearchResult,
  type WorkerType,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage, useApi } from '../lib/useApi';
import {
  DIET_LABEL,
  GENDER_LABEL_SINGULAR,
  NO_ALLERGIES,
  ROLE_LABEL,
  ROLE_LABEL_LONG,
  unitWordForRole,
  WORKER_TYPE_LABEL,
} from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading } from '../components/ui';
import { ManagerPicker, useEligibleManagers } from '../components/ManagerPicker';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

/** אותה בדיקה כמו בשרת (lib/phone.ts) - כדי לתת משוב מיידי בלי סיבוב לשרת. */
const PHONE_PATTERN = /^0\d{8,9}$/;
function isPhoneValid(value: string): boolean {
  return PHONE_PATTERN.test(value.trim().replace(/[\s-]/g, ''));
}

/** אותה בדיקה כמו בשרת (lib/cars.ts) - כדי לתת משוב מיידי בלי סיבוב לשרת. */
const CAR_PLATE_PATTERN = /^\d{7,8}$/;

/** מפמ״ר הוא ראש השרשרת ולאופרטיבי עמדה קבועה - אף אחד מהם אינו ניתן להעברה. */
function isMovableRole(role: Role): boolean {
  return role !== 'to' && role !== 'ceo';
}

/** רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - ראו lib/cars.ts בשרת. */
function alwaysBringsOwnCar(role: string): boolean {
  return role === 'division_leader' || role === 'ceo';
}

/**
 * מסך "פרופיל": כרטיס אחד לפרטים האישיים, בתצוגה או בעריכה - לא שני כרטיסים
 * נפרדים לצפייה ולעריכה. עריכה ממתינה לאישור המפקד, כמו בהרשמה.
 */
export function ProfilePage() {
  const { user, refresh } = useAuth();
  const { data, loading, error, reload } = useApi<{ pending: ProfileEditRequest | null }>('/users/me/profile-edit');
  const hierarchy = useApi<{ chain: HierarchyMember[] }>('/users/me/hierarchy');
  // נשלף רק כדי לצייר את עץ הכפיפים הישירים מתחת לבועת המשתמש בכרטיס
  // "שרשרת הפיקוד שלי" - רשימת הכפיפים המלאה עם חיפוש ועריכה עברה לעמוד
  // "חיילים" הנפרד (SoldiersPage).
  const team = useApi<{ team: TeamMember[] }>(user?.isManager ? '/users/my-team' : null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');

  const pending = data?.pending ?? null;
  const isManager = user ? user.role !== 'employee' : false;
  const ownsCar = user ? alwaysBringsOwnCar(user.role) : false;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [diet, setDiet] = useState<Diet>('all');
  const [unitName, setUnitName] = useState('');
  const [phone, setPhone] = useState('');
  const [allergies, setAllergies] = useState('');
  const [workerType, setWorkerType] = useState<WorkerType>('regular');
  const [borrowedFrom, setBorrowedFrom] = useState('');
  const [borrowedMission, setBorrowedMission] = useState('');
  const [carPlate, setCarPlate] = useState('');
  // דרך הגעה: הסעה כברירת מחדל, ומספר הרכב מוצג רק כשבוחרים עצמאי. נגזר
  // ממספר הרכב הקיים בפרופיל (אם כבר יש - כנראה נבחר עצמאי בעבר), לא שדה
  // עצמאי בשרת - ראו submit() למטה.
  const [arrivalMethod, setArrivalMethod] = useState<'bus' | 'own'>('bus');
  // מסומן אחרי ניסיון שמירה - מציג שדות חובה ריקים באדום (ראו Field).
  const [attempted, setAttempted] = useState(false);

  // הטופס מוצג עם ערכי הבקשה הממתינה אם יש, אחרת עם הערכים הנוכחיים.
  useEffect(() => {
    if (!user) return;
    const source = pending?.proposed ?? {
      firstName: user.firstName,
      lastName: user.lastName,
      gender: user.gender,
      diet: user.diet,
      unitName: user.unitName,
      phone: user.phone,
      allergies: user.allergies,
      workerType: user.workerType,
      borrowedFrom: user.borrowedFrom,
      borrowedMission: user.borrowedMission,
    };
    setFirstName(source.firstName);
    setLastName(source.lastName);
    setGender(source.gender);
    setDiet(source.diet);
    setUnitName(source.unitName ?? '');
    setPhone(source.phone ?? '');
    setAllergies(source.allergies === NO_ALLERGIES ? '' : source.allergies);
    setWorkerType(source.workerType);
    setBorrowedFrom(source.borrowedFrom ?? '');
    setBorrowedMission(source.borrowedMission ?? '');
    setCarPlate(user.carPlate ?? '');
    setArrivalMethod(user.carPlate ? 'own' : 'bus');
  }, [user, pending]);

  const childrenByManager = useMemo(() => buildChildrenMap(team.data?.team ?? []), [team.data]);

  if (!user) return null;
  if (loading) return <Loading />;

  const isEmployee = user.role === 'employee';
  const isBorrowed = isEmployee && workerType === 'borrowed';
  const firstNameInvalid = attempted && firstName.trim().length < 2;
  const lastNameInvalid = attempted && lastName.trim().length < 2;
  const phoneInvalid = attempted && !isPhoneValid(phone);
  const unitNameInvalid = attempted && isManager && !unitName.trim();
  const borrowedFromInvalid = attempted && isBorrowed && !borrowedFrom.trim();
  const borrowedMissionInvalid = attempted && isBorrowed && !borrowedMission.trim();
  // רת״ח ומפמ״ר תמיד ברכב פרטי - אין להם בחירה, השדה מוצג תמיד עבורם בלי תלות ב"דרך הגעה".
  const showsCarPlate = ownsCar || arrivalMethod === 'own';
  const plateInvalid = attempted && showsCarPlate && !CAR_PLATE_PATTERN.test(carPlate.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    setSuccess('');
    setAttempted(true);

    if (firstNameInvalid || lastNameInvalid || phoneInvalid || unitNameInvalid) {
      setFormError('יש למלא את כל השדות המסומנים באדום');
      return;
    }
    if (isBorrowed && (borrowedFromInvalid || borrowedMissionInvalid)) {
      setFormError('לחייל מושאל (הצ״ח) חובה למלא מאיפה הושאל ומהי המשימה');
      return;
    }
    if (plateInvalid) {
      setFormError('יש להזין מספר רכב תקין (7-8 ספרות)');
      return;
    }

    setBusy(true);
    try {
      // מספר הרכב מתעדכן מיד בלי אישור - זה פרט מנהלי, לא שינוי בזהות
      // או בשיוך הארגוני, ולכן הוא נשלח בנפרד משאר הפרטים. בחירת "הסעה"
      // מנקה מספר רכב קודם, כדי שלא יישאר תלוי באוויר בלי תפקיד.
      const nextCarPlate = showsCarPlate ? carPlate.trim() : '';
      if (nextCarPlate !== (user.carPlate ?? '')) {
        await api.put('/users/me/car-plate', { carPlate: nextCarPlate || null });
        await refresh();
      }

      const response = await api.post<{ pending: ProfileEditRequest | null }>('/users/me/profile-edit', {
        firstName,
        lastName,
        gender,
        diet,
        phone,
        allergies: allergies.trim() || NO_ALLERGIES,
        ...(isManager ? { unitName } : {}),
        ...(isEmployee ? { workerType } : {}),
        ...(isBorrowed ? { borrowedFrom, borrowedMission } : {}),
      });
      setSuccess(response.pending ? 'הבקשה נשלחה לאישור המפקד.' : 'הפרטים נשמרו.');
      setEditing(false);
      setAttempted(false);
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught, 'שליחת הבקשה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setFormError('');
    setSuccess('');
    setWithdrawing(true);
    try {
      await api.delete('/users/me/profile-edit');
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught, 'ביטול הבקשה נכשל'));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>פרופיל</h1>
          <p>הפרטים האישיים שלך - כל שינוי ממתין לאישור המפקד, בדיוק כמו בהרשמה</p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {pending && (
        <Alert kind="warn">
          <div className="stack" style={{ gap: '0.4rem' }}>
            <strong>יש לך בקשת עדכון ממתינה לאישור המפקד</strong>
            <span className="small">
              {pending.proposed.firstName} {pending.proposed.lastName} ·{' '}
              {GENDER_LABEL_SINGULAR[pending.proposed.gender]} · {DIET_LABEL[pending.proposed.diet]}
              {pending.proposed.unitName ? ` · ${pending.proposed.unitName}` : ''}
            </span>
            <div>
              <button type="button" className="btn btn--sm" disabled={withdrawing} onClick={() => void withdraw()}>
                {withdrawing ? 'מבטל...' : 'בטל בקשה'}
              </button>
            </div>
          </div>
        </Alert>
      )}

      <Card
        title="הפרטים שלי"
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setFormError('');
              setSuccess('');
              setEditing((value) => !value);
            }}
          >
            {editing ? 'ביטול' : 'עריכה'}
          </button>
        }
      >
        <Alert kind="error">{formError}</Alert>
        <Alert kind="success">{success}</Alert>

        {editing ? (
          <form onSubmit={submit}>
            <div className="field-row">
              <Field label="שם פרטי" invalid={firstNameInvalid}>
                <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
              </Field>
              <Field label="שם משפחה" invalid={lastNameInvalid}>
                <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
              </Field>
            </div>

            <div className="field-row">
              <Field label="מין" hint="קובע את שיוך מבנה הלינה">
                <select value={gender} onChange={(event) => setGender(event.target.value as Gender)} required>
                  <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
                  <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
                </select>
              </Field>

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
            </div>

            <div className="field-row">
              <Field label="העדפת תזונה">
                <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
                  {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
                    <option key={option} value={option}>
                      {DIET_LABEL[option]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="אלרגיות" hint={`לא חובה - ברירת המחדל היא "${NO_ALLERGIES}"`}>
                <input
                  value={allergies}
                  onChange={(event) => setAllergies(event.target.value)}
                  placeholder={NO_ALLERGIES}
                />
              </Field>
            </div>

            {isManager && (
              <Field label="שם היחידה שבפיקודך" hint="לדוגמה: צוות אלון / מדור תוכנה / תחום פיתוח" invalid={unitNameInvalid}>
                <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
              </Field>
            )}

            {isEmployee && (
              <>
                <Field label="סוג חייל">
                  <select value={workerType} onChange={(event) => setWorkerType(event.target.value as WorkerType)}>
                    {(['regular', 'borrowed', 'reserve'] as WorkerType[]).map((option) => (
                      <option key={option} value={option}>
                        {WORKER_TYPE_LABEL[option]}
                      </option>
                    ))}
                  </select>
                </Field>

                {workerType === 'borrowed' && (
                  <div className="field-row">
                    <Field label="מאיפה הושאל" hint="לדוגמה: מדור תוכנה / חברה חיצונית" invalid={borrowedFromInvalid}>
                      <input value={borrowedFrom} onChange={(event) => setBorrowedFrom(event.target.value)} required />
                    </Field>
                    <Field label="המשימה שבשבילה מבקשים את ההשאלה" invalid={borrowedMissionInvalid}>
                      <input
                        value={borrowedMission}
                        onChange={(event) => setBorrowedMission(event.target.value)}
                        required
                      />
                    </Field>
                  </div>
                )}
              </>
            )}

            {ownsCar ? (
              <Field
                label="מספר רכב (7-8 ספרות)"
                hint="מתעדכן מיד - רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם, בלי צורך באישור"
                invalid={plateInvalid}
              >
                <input
                  value={carPlate}
                  onChange={(event) => setCarPlate(event.target.value)}
                  placeholder="1234567"
                  inputMode="numeric"
                  maxLength={8}
                  required
                />
              </Field>
            ) : (
              <>
                <Field label="דרך הגעה" hint="מתעדכן מיד. משמש בבקשת הגעה ברכב פרטי לגלישה - עדיין טעון בקשה ואישור רת״ח בכל גלישה">
                  <select
                    value={arrivalMethod}
                    onChange={(event) => setArrivalMethod(event.target.value as 'bus' | 'own')}
                  >
                    <option value="bus">הסעה</option>
                    <option value="own">עצמאי (רכב פרטי)</option>
                  </select>
                </Field>

                {arrivalMethod === 'own' && (
                  <Field label="מספר רכב (7-8 ספרות)" invalid={plateInvalid}>
                    <input
                      value={carPlate}
                      onChange={(event) => setCarPlate(event.target.value)}
                      placeholder="1234567"
                      inputMode="numeric"
                      maxLength={8}
                      required
                    />
                  </Field>
                )}
              </>
            )}

            <div className="row">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {busy ? 'שומר...' : 'שמירה'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setEditing(false);
                  setAttempted(false);
                }}
              >
                ביטול
              </button>
            </div>
          </form>
        ) : (
          <div className="stack">
            <InfoRow label="מספר אישי" value={user.companyId} />
            <InfoRow label="שם" value={user.fullName} />
            <InfoRow label="תפקיד" value={ROLE_LABEL_LONG[user.role] ?? user.role} />
            <InfoRow label="מפקד" value={user.managerName ?? '—'} />
            <InfoRow label="מין" value={GENDER_LABEL_SINGULAR[user.gender] ?? user.gender} />
            <InfoRow label="טלפון" value={user.phone ?? 'לא הוזן'} />
            <InfoRow label="העדפת תזונה" value={DIET_LABEL[user.diet] ?? user.diet} />
            <InfoRow label="אלרגיות" value={user.allergies} />
            {user.unitName && <InfoRow label="יחידה" value={user.unitName} />}
            {isEmployee && <InfoRow label="סוג חייל" value={WORKER_TYPE_LABEL[user.workerType] ?? user.workerType} />}
            {isEmployee && user.workerType === 'borrowed' && (
              <>
                <InfoRow label="מאיפה הושאל" value={user.borrowedFrom ?? '—'} />
                <InfoRow label="המשימה" value={user.borrowedMission ?? '—'} />
              </>
            )}
            {ownsCar ? (
              <InfoRow label="מספר רכב" value={user.carPlate ?? 'לא הוזן'} />
            ) : (
              <InfoRow label="דרך הגעה" value={user.carPlate ? `עצמאי · ${user.carPlate}` : 'הסעה'} />
            )}
            <p className="muted small" style={{ marginTop: '0.25rem' }}>
              מספר אישי ותפקיד אינם ניתנים לעריכה - כל שינוי אחר ממתין לאישור המפקד, חוץ ממספר הרכב שמתעדכן
              מיד. שינוי מפקד נעשה בכרטיס "שרשרת הפיקוד שלי" למטה.
            </p>
          </div>
        )}
      </Card>

      <Card title="שרשרת הפיקוד שלי">
        {hierarchy.loading && <Loading />}
        <Alert kind="error">{hierarchy.error}</Alert>
        {hierarchy.data && (
          <HierarchyChain chain={hierarchy.data.chain} selfId={user.id} childrenByManager={childrenByManager} />
        )}
        <ChangeCommanderCard />
      </Card>

      <RoommatePreferencesCard />

      <PasswordCard hasPassword={user.hasPassword} />
    </>
  );
}

/**
 * שינוי מפקד עצמאי (בקשה, לא עדכון מיידי) - ראו POST/DELETE/GET /users/:id/move
 * בשרת. אם המפקד היעד מחוץ לשרשרת הפיקוד של המשתמש (המקרה הרגיל) הבקשה
 * ממתינה לאישורו, בדיוק כמו הרשמה ראשונית. מפמ״ר ואופרטיבי לא רואים את
 * הכרטיס הזה כלל - להם אין מפקד להחליף (isMovableRole).
 */
function ChangeCommanderCard() {
  const { user, refresh } = useAuth();
  const canMove = !!user && isMovableRole(user.role);
  const { data, loading, error, reload } = useApi<{ pending: MoveRequest | null }>(canMove ? '/users/me/move' : null);
  const eligible = useEligibleManagers(user?.role ?? 'employee');

  const [changing, setChanging] = useState(false);
  const [toManagerId, setToManagerId] = useState<number | null>(null);
  const [needsSuccessor, setNeedsSuccessor] = useState(false);
  const [successorQuery, setSuccessorQuery] = useState('');
  const [successorResults, setSuccessorResults] = useState<UserSearchResult[]>([]);
  const [successor, setSuccessor] = useState<UserSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = successorQuery.trim();
    if (!term) {
      setSuccessorResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void api
        .get<{ results: UserSearchResult[] }>(`/users/search?q=${encodeURIComponent(term)}`)
        .then((response) => setSuccessorResults(response.results))
        .catch(() => setSuccessorResults([]));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [successorQuery]);

  if (!user || !canMove) return null;

  const pending = data?.pending ?? null;

  const cancelForm = () => {
    setChanging(false);
    setToManagerId(null);
    setSuccessor(null);
    setSuccessorQuery('');
    setNeedsSuccessor(false);
    setFormError('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    setSuccess('');
    if (toManagerId == null) {
      setFormError('יש לבחור מפקד חדש');
      return;
    }
    setBusy(true);
    try {
      const response = await api.post<{ applied: boolean }>(`/users/${user.id}/move`, {
        toManagerId,
        ...(successor ? { successorId: successor.id } : {}),
      });
      if (response.applied) {
        setSuccess('המפקד עודכן.');
        await refresh();
      } else {
        setSuccess('בקשת שינוי המפקד נשלחה וממתינה לאישורו.');
      }
      cancelForm();
      await reload();
    } catch (caught) {
      const message = errorMessage(caught, 'שליחת הבקשה נכשלה');
      // הודעת השרת כשיש כפיפים ועדיין לא נבחר ממלא מקום - חושפת את השדה לבחירה.
      if (message.includes('ממלא מקום')) setNeedsSuccessor(true);
      setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setFormError('');
    setSuccess('');
    setWithdrawing(true);
    try {
      await api.delete(`/users/${user.id}/move`);
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught, 'ביטול הבקשה נכשל'));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
      <div className="row row--between">
        <strong className="small">מפקד: {user.managerName ?? '—'}</strong>
        {!pending && !changing && (
          <button type="button" className="btn btn--sm" onClick={() => setChanging(true)}>
            שינוי מפקד
          </button>
        )}
      </div>

      {!loading && <Alert kind="error">{error}</Alert>}
      <Alert kind="error">{formError}</Alert>
      <Alert kind="success">{success}</Alert>

      {pending && (
        <Alert kind="warn">
          <div className="stack" style={{ gap: '0.4rem' }}>
            <span className="small">
              בקשת שינוי מפקד ממתינה לאישור <strong>{pending.toManager.fullName}</strong>
              {pending.toManager.unitName ? ` · ${pending.toManager.unitName}` : ''}
            </span>
            <div>
              <button type="button" className="btn btn--sm" disabled={withdrawing} onClick={() => void withdraw()}>
                {withdrawing ? 'מבטל...' : 'בטל בקשה'}
              </button>
            </div>
          </div>
        </Alert>
      )}

      {changing && !pending && (
        <form onSubmit={submit} className="stack" style={{ marginTop: '0.5rem' }}>
          <ManagerPicker role={user.role} options={eligible} value={toManagerId} onChange={setToManagerId} label="מפקד חדש" />

          {needsSuccessor && (
            <div className="field">
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>ממלא מקום ביחידה הנוכחית שלך</span>
              {successor ? (
                <div className="combo__selected">
                  <span>
                    <strong>{successor.fullName}</strong>
                    <span className="muted"> · {successor.companyId}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => {
                      setSuccessor(null);
                      setSuccessorQuery('');
                    }}
                  >
                    שינוי
                  </button>
                </div>
              ) : (
                <div className="combo">
                  <input
                    value={successorQuery}
                    onChange={(event) => setSuccessorQuery(event.target.value)}
                    placeholder="חיפוש לפי שם או מספר אישי"
                    autoComplete="off"
                  />
                  {successorQuery.trim() && (
                    <ul className="combo__list" role="listbox">
                      {successorResults.length === 0 ? (
                        <li className="combo__empty">לא נמצאו תוצאות</li>
                      ) : (
                        successorResults.map((candidate) => (
                          <li key={candidate.id}>
                            <button
                              type="button"
                              className="combo__option"
                              role="option"
                              aria-selected={false}
                              disabled={candidate.id === user.id || candidate.hasDirectReports}
                              onClick={() => {
                                setSuccessor(candidate);
                                setSuccessorQuery('');
                                setSuccessorResults([]);
                              }}
                            >
                              <span>
                                {candidate.fullName}
                                <span className="muted small"> · {ROLE_LABEL[candidate.role]}</span>
                              </span>
                              <span className="muted small">
                                {candidate.id === user.id
                                  ? 'זה אתה'
                                  : candidate.hasDirectReports
                                    ? 'כבר מפקד על יחידה משלו'
                                    : candidate.unitPath}
                              </span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              )}
              <span className="field__hint">
                יש לך כפיפים משלך - יש לבחור מי יורש את היחידה שלך לפני שהמעבר יחול.
              </span>
            </div>
          )}

          <div className="row">
            <button type="submit" className="btn btn--sm btn--primary" disabled={busy || eligible.loading}>
              {busy ? 'שולח...' : 'שליחת הבקשה'}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={cancelForm}>
              ביטול
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row row--between">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** החלפת סיסמה עצמית. חשבון בלי סיסמה מוגדרת (מלפני הוספת האימות) יכול להגדיר אחת בלי סיסמה נוכחית. */
function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [success, setSuccess] = useState('');

  return (
    <Card title="סיסמה">
      <Alert kind="success">{success}</Alert>
      <ChangePasswordForm
        requireCurrent={hasPassword}
        onSuccess={() => setSuccess('הסיסמה עודכנה בהצלחה.')}
      />
    </Card>
  );
}

/**
 * העדפות השותפים הקבועות: "עם מי הייתי רוצה לישון" באופן כללי, ולא לגלישה
 * מסוים. נשאלות (לא חובה) בהרשמה, ונערכות כאן. הן משמשות כברירת מחדל בכל
 * גלישה שבו המשתמש לא בחר שותפים ספציפיים.
 *
 * האילוצים הקשיחים (אותו מין, ואותו דרג ניהולי בדיוק) נאכפים בשרת, ולכן
 * רשימת המועמדים כבר מגיעה מסוננת.
 */
function RoommatePreferencesCard() {
  const { data, loading, error, reload } = useApi<{
    max: number;
    preferences: RoommateOption[];
    candidates: RoommateOption[];
  }>('/users/me/roommate-preferences');

  const [selected, setSelected] = useState<number[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');

  const max = data?.max ?? 3;
  const current = selected ?? (data?.preferences ?? []).map((entry) => entry.id);
  const dirty = selected != null;

  const byId = useMemo(
    () => new Map((data?.candidates ?? []).map((candidate) => [candidate.id, candidate])),
    [data],
  );

  const filtered = useMemo(() => {
    const list = data?.candidates ?? [];
    const term = search.trim();
    if (!term) return list;
    return list.filter(
      (candidate) =>
        candidate.fullName.includes(term) ||
        candidate.companyId.includes(term) ||
        candidate.unitPath.includes(term),
    );
  }, [data, search]);

  const toggle = (id: number) => {
    setSuccess('');
    setSelected(
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : current.length >= max
          ? current
          : [...current, id],
    );
  };

  const save = async () => {
    setSaveError('');
    setSuccess('');
    setBusy(true);
    try {
      await api.put('/users/me/roommate-preferences', { preferences: current });
      setSelected(null);
      setSuccess('העדפות השותפים נשמרו.');
      await reload();
    } catch (caught) {
      setSaveError(errorMessage(caught, 'שמירת ההעדפות נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="העדפות שותפים לחדר"
      actions={<Badge kind={current.length > 0 ? 'ok' : 'default'}>{current.length}/{max}</Badge>}
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="error">{saveError}</Alert>
      <Alert kind="success">{success}</Alert>

      {loading ? (
        <Loading />
      ) : (
        <>
          <p className="muted small">
            הבחירה אינה חובה. היא משמשת כברירת מחדל בכל גלישה שבה לא בחרת שותפים ספציפיים - ואפשר תמיד לשנות
            אותה לגלישה מסוימת במסך הגלישה. השיבוץ מנסה לכבד את הבקשה, אבל אינו מתחייב.
          </p>

          {(data?.candidates ?? []).length === 0 ? (
            <Empty>אין כרגע מועמדים מתאימים. אפשר לבחור רק אנשים מאותו מין ומאותו דרג ניהולי בדיוק.</Empty>
          ) : (
            <>
              {current.length > 0 && (
                <ul className="pref-list" style={{ marginBottom: '0.75rem' }}>
                  {current.map((id, index) => (
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

              <Field label="חיפוש">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="שם, מספר אישי או יחידה"
                />
              </Field>

              {filtered.length === 0 ? (
                <p className="muted">לא נמצאו מועמדים תואמים.</p>
              ) : (
                <div className="table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th />
                        <th>שם</th>
                        <th>יחידה</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((candidate) => (
                        <tr key={candidate.id}>
                          <td data-label="בחירה">
                            <input
                              type="checkbox"
                              checked={current.includes(candidate.id)}
                              disabled={!current.includes(candidate.id) && current.length >= max}
                              onChange={() => toggle(candidate.id)}
                              aria-label={`בחר את ${candidate.fullName}`}
                            />
                          </td>
                          <td data-label="שם">{candidate.fullName}</td>
                          <td className="muted" data-label="יחידה">
                            {candidate.unitPath}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="row" style={{ marginTop: '0.75rem' }}>
                <button type="button" className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? 'שומר...' : 'שמירת ההעדפות'}
                </button>
                {dirty && (
                  <button type="button" className="btn" disabled={busy} onClick={() => setSelected(null)}>
                    ביטול
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** ראשי התיבות של שם מלא, לתצוגה בתוך הבועה - עד שתי אותיות. */
function initials(fullNameValue: string): string {
  const letters = fullNameValue
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean);
  return letters.slice(0, 2).join('');
}

/** ממפה כל מפקד למי שכפוף לו ישירות מתוך רשימת כפיפים שטוחה. */
function buildChildrenMap(team: TeamMember[]): Map<number, TeamMember[]> {
  const map = new Map<number, TeamMember[]>();
  for (const member of team) {
    const key = member.managerId ?? -1;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(member);
  }
  return map;
}

/** כמה אנשים כפופים למישהו בכל העומקים (לא כולל אותו עצמו). */
function subtreeSize(id: number, childrenByManager: Map<number, TeamMember[]>): number {
  const children = childrenByManager.get(id) ?? [];
  return children.reduce((sum, child) => sum + 1 + subtreeSize(child.id, childrenByManager), 0);
}

/**
 * שרשרת הפיקוד כשרשרת בועות אנכית - מהמשתמש עצמו (למטה) ועד ראש השרשרת
 * (למעלה), עם קו מחבר בין כל שתי בועות סמוכות. מתחת לבועת המשתמש מתחיל
 * עץ משפחה הניתן להרחבה: לחיצה על כפיף חושפת את הכפיפים שלו, וכן הלאה.
 */
function HierarchyChain({
  chain,
  selfId,
  childrenByManager,
}: {
  chain: HierarchyMember[];
  selfId: number;
  childrenByManager: Map<number, TeamMember[]>;
}) {
  if (chain.length === 0) return null;
  const topDown = [...chain].reverse();
  const directReports = childrenByManager.get(selfId) ?? [];

  return (
    <div className="org-bubbles">
      {topDown.map((member, index) => {
        const isSelf = member.id === selfId;
        return (
          <div className="org-bubbles__item" key={member.id}>
            {index > 0 && <div className="org-bubbles__connector" aria-hidden />}
            <div className={`org-bubble${isSelf ? ' org-bubble--self' : ''}`}>{initials(member.fullName)}</div>
            <div className="org-bubbles__label">
              <span className="org-bubbles__name">
                {member.fullName}
                {isSelf ? ' (אתה)' : ''}
              </span>
              <span className="org-bubbles__role">
                {ROLE_LABEL_LONG[member.role] ?? member.role}
                {member.unitName ? ` · ${member.unitName}` : ''}
              </span>
            </div>
          </div>
        );
      })}

      {directReports.length > 0 && (
        <>
          <div className="org-bubbles__connector" aria-hidden />
          <div className="org-fam__children">
            {directReports.map((report) => (
              <div className="org-fam__branch" key={report.id}>
                <FamilyNode member={report} childrenByManager={childrenByManager} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * צומת בעץ המשפחה: בועה עם שם ותפקיד, וחץ לחיצה אם יש לו כפיפים משלו -
 * לחיצה חושפת אותם עם אותו רכיב באופן רקורסיבי, ובכך "מרחיבה" את העץ.
 */
function FamilyNode({
  member,
  childrenByManager,
}: {
  member: TeamMember;
  childrenByManager: Map<number, TeamMember[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = childrenByManager.get(member.id) ?? [];
  const hasChildren = children.length > 0;
  const teamSize = hasChildren ? subtreeSize(member.id, childrenByManager) : 0;

  const toggle = () => {
    if (hasChildren) setExpanded((value) => !value);
  };

  return (
    <div className="org-fam__node">
      <div
        className={`org-fam__item${hasChildren ? ' org-fam__item--clickable' : ''}`}
        role={hasChildren ? 'button' : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (hasChildren && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <div className={`org-bubble org-bubble--sm${hasChildren ? ' org-bubble--expandable' : ''}`}>
          {initials(member.fullName)}
        </div>
        <div className="org-bubbles__label">
          <span className="org-bubbles__name">{member.fullName}</span>
          <span className="org-bubbles__role">
            {ROLE_LABEL_LONG[member.role] ?? member.role}
            {teamSize > 0 ? ` · ${teamSize} ב${unitWordForRole(member.role)}` : ''}
          </span>
        </div>
        {hasChildren && (
          <span className="org-fam__caret" aria-hidden>
            {expanded ? '▴' : '▾'}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <div className="org-fam__children">
          {children.map((child) => (
            <div className="org-fam__branch" key={child.id}>
              <FamilyNode member={child} childrenByManager={childrenByManager} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
