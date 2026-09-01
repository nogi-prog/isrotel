import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type SignablePerson,
  type SignableResponse,
  type SubmitSigningResponse,
  type Trip,
  type TripCycle,
} from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import {
  DIET_LABEL,
  formatDate,
  formatDateTime,
  GENDER_LABEL_SINGULAR,
  ROLE_LABEL,
  SIGNING_SUBMISSION_LABEL,
  SIGNUP_STATUS_LABEL,
} from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Field, Loading, Stat, StatusBadge } from '../components/ui';

/**
 * מסך שיבוץ האנשים לגלישה - לכל מי שקיבל את משימת השיבוץ (רמ״ד, רת״ח או האופרטיבי,
 * שהוא גם רמ״ד), ולר״צ שקיבל האצלה.
 * מי שקיבל את המשימה יכול לבחור את האנשים בעצמו, או להאציל את השיבוץ למפקדים שמתחתיו.
 *
 * המפקד מגיש את הרשימה שלו כשהיא מוכנה. ההגשה אינה סוגרת את השיבוץ: אם אחר כך
 * מאושר אצלו אדם חדש, הוא מוקפץ לראש המסך ואפשר לצרף אותו. השיבוץ נסגר סופית
 * רק כשהאופרטיבי מגיש את הגלישה (rosterClosed מהשרת).
 */
export function TripSigningPage() {
  const { tripId } = useParams();
  const trip = useApi<{ trip: Trip }>(tripId ? `/trips/${tripId}` : null);
  const signable = useApi<SignableResponse>(tripId ? `/trips/${tripId}/signable` : null);

  const [cycleId, setCycleId] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const data = trip.data?.trip;
  const people = signable.data?.people ?? [];
  const authority = signable.data?.authority ?? null;

  const unsigned = useMemo(() => people.filter((person) => person.signup == null), [people]);
  const signed = useMemo(() => people.filter((person) => person.signup != null), [people]);

  const filteredUnsigned = useMemo(() => {
    const term = search.trim();
    if (!term) return unsigned;
    return unsigned.filter(
      (person) =>
        person.fullName.includes(term) || person.companyId.includes(term) || person.unitPath.includes(term),
    );
  }, [unsigned, search]);

  /**
   * מי שאושר ליחידה אחרי שהמפקד הגיש. השרת מחזיר מזהים בלבד, והאנשים עצמם
   * נמצאים ב־people הרגילים. מסננים גם מי שכבר שובץ, כדי שהכרטיס יתרוקן מיד.
   */
  const lateAdditions = useMemo(() => {
    const ids = new Set(signable.data?.lateAdditions ?? []);
    if (ids.size === 0) return [];
    return people.filter((person) => ids.has(person.userId) && person.signup == null);
  }, [people, signable.data]);

  const reload = async () => {
    await Promise.all([trip.reload(), signable.reload()]);
    setSelected([]);
  };

  if (trip.loading || signable.loading) return <Loading />;
  if (!data) return <Alert kind="error">{trip.error || 'הגלישה לא נמצאה'}</Alert>;

  // אין הרשאת שיבוץ - מסבירים למה.
  if (authority == null) {
    return (
      <>
        <div className="page-head">
          <h1>שיבוץ אנשים · {data.name}</h1>
          <BackToTrip tripId={data.id} />
        </div>
        <Alert kind="warn">{signable.data?.note ?? 'אין לך הרשאת שיבוץ בגלישה הזאת.'}</Alert>
      </>
    );
  }

  // השרת מחשב אם השיבוץ סגור: הגלישה אינה פתוחה, האוטובוסים/הלינה נעולים, או שהאופרטיבי הגיש.
  const rosterClosed = signable.data?.rosterClosed ?? data.rosterClosed;
  const rosterClosedNote = signable.data?.rosterClosedNote ?? null;
  const mySubmittedAt = signable.data?.submittedAt ?? data.mySubmittedAt;

  const toggle = (userId: number) =>
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );

  const signSelected = async () => {
    setError('');
    setMessage('');
    if (!cycleId) {
      setError('חובה לבחור פעימת יציאה');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ added: number; skipped: Array<{ reason: string }>; status: string }>(
        `/trips/${data.id}/signups`,
        { cycleId: Number(cycleId), userIds: selected },
      );
      setMessage(
        result.status === 'approved'
          ? `שובצו ${result.added} אנשים לגלישה.`
          : `שובצו ${result.added} אנשים. הרשימה ממתינה לאישור המפקד שמעליך.`,
      );
      if (result.skipped.length > 0) setError(result.skipped.map((entry) => entry.reason).join(' · '));
      await reload();
    } catch (caught) {
      setError(errorMessage(caught, 'השיבוץ נכשל'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (signupId: number) => {
    setError('');
    setMessage('');
    try {
      await api.delete(`/trips/${data.id}/signups/${signupId}`);
      await reload();
    } catch (caught) {
      setError(errorMessage(caught, 'ההסרה נכשלה'));
    }
  };

  // הדרג שאפשר להאציל אליו תלוי במקומו של המפקד בשרשרת - רת״ח מאציל
  // לרמ״דים, רמ״ד/אופרטיבי לר״צים. תגית כללית עד שהתשובה מהשרת חוזרת.
  const subordinateLabel = signable.data?.subordinateRoleLabel ?? 'המפקדים שתחתיך';

  const toggleDelegation = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (signable.data?.hasDelegated) {
        await api.delete(`/trips/${data.id}/delegation`);
        setMessage('ההאצלה בוטלה. השיבוץ חזר אליך.');
      } else {
        const result = await api.post<{ delegatedTo: number; roleLabel: string }>(`/trips/${data.id}/delegation`);
        setMessage(
          `השיבוץ הואצל ל-${result.delegatedTo} ${result.roleLabel}. הם יקבלו התראה, ואתה תאשר את הרשימה שלהם.`,
        );
      }
      await reload();
    } catch (caught) {
      setError(errorMessage(caught, 'הפעולה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>שיבוץ אנשים · {data.name}</h1>
          <p>
            {data.stateLabel}
            {authority === 'delegated' && ' · השיבוץ שלך ממתין לאישור המפקד שמעליך'}
          </p>
        </div>
        <div className="row">
          <Badge kind={authority === 'leader' ? 'ok' : 'info'}>
            {authority === 'leader' ? 'אחראי שיבוץ' : 'שיבוץ באצילה'}
          </Badge>
          {mySubmittedAt && <Badge kind="ok">{SIGNING_SUBMISSION_LABEL.submitted}</Badge>}
          <Link to={`/trips/${data.id}/approvals`} className="btn btn--sm">
            אישורים
          </Link>
          <BackToTrip tripId={data.id} />
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>
      {rosterClosed && <Alert kind="warn">{rosterClosedNote ?? 'הגלישה אינה פתוחה לשינויי שיבוץ.'}</Alert>}

      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <Stat value={people.length} label="אנשים באחריותך" />
        <Stat value={signed.length} label="שובצו" />
        <Stat value={unsigned.length} label="טרם שובצו" />
      </div>

      {/* מי שאושר ליחידה אחרי ההגשה - הכרטיס הבולט בראש המסך */}
      {lateAdditions.length > 0 && (
        <LateAdditionsCard
          tripId={data.id}
          people={lateAdditions}
          cycles={data.cycles}
          rosterClosed={rosterClosed}
          onChanged={reload}
          onAdded={(text) => {
            // ההודעה עולה לראש המסך, כי הכרטיס עצמו נעלם כשמסתיימת הרשימה.
            setError('');
            setMessage(text);
          }}
        />
      )}

      {/* הגשת הרשימה לאופרטיבי */}
      <SubmitSigningCard
        tripId={data.id}
        submittedAt={mySubmittedAt}
        signedCount={signed.length}
        rosterClosed={rosterClosed}
        onChanged={reload}
      />

      {/* בקשת רכב פרטי לכמה מהאנשים בבת אחת, במקום שכל אחד יבקש בעצמו */}
      {!rosterClosed && (
        <CarRequestsCard tripId={data.id} people={signed} onChanged={reload} />
      )}

      {/* האצלה - רק למי שקיבל את משימת השיבוץ, לא למי שקיבל אותה באצילה */}
      {authority === 'leader' && (
        <Card title="איך לשבץ?">
          <div className="stack">
            <p className="small muted">
              אפשר לבחור את האנשים בעצמך, או להאציל את השיבוץ ל{subordinateLabel} שתחתיך. אם תאציל, הם ישבצו את
              הצוותים שלהם והרשימה תגיע אליך לאישור.
            </p>
            <div className="row">
              <Badge kind={signable.data?.hasDelegated ? 'info' : 'ok'}>
                {signable.data?.hasDelegated ? `השיבוץ הואצל ל${subordinateLabel}` : 'אתה משבץ בעצמך'}
              </Badge>
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || rosterClosed}
                onClick={() => void toggleDelegation()}
              >
                {signable.data?.hasDelegated ? 'ביטול האצלה' : `האצלת השיבוץ ל${subordinateLabel}`}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* בחירת אנשים */}
      {!rosterClosed && (
        <Card
          title={`בחירת אנשים לשיבוץ (${selected.length} נבחרו)`}
          actions={
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || selected.length === 0 || !cycleId}
              title={
                !cycleId
                  ? 'יש לבחור פעימת יציאה למטה לפני השיבוץ'
                  : selected.length === 0
                    ? 'יש לסמן לפחות אדם אחד מהרשימה למטה'
                    : undefined
              }
              onClick={() => void signSelected()}
            >
              {busy ? 'משבץ...' : `שבץ ${selected.length} אנשים`}
            </button>
          }
        >
          <div className="field-row">
            <Field label="פעימת יציאה">
              <select value={cycleId} onChange={(event) => setCycleId(event.target.value)}>
                <option value="">בחר...</option>
                {data.cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.name} · {formatDate(cycle.exitDate)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="חיפוש">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="שם, מספר אישי או יחידה"
              />
            </Field>
          </div>

          {data.cycles.length === 0 && <Alert kind="warn">האופרטיבי עוד לא הגדיר פעימות יציאה.</Alert>}

          {filteredUnsigned.length === 0 ? (
            <Empty>{unsigned.length === 0 ? 'כל האנשים שלך שובצו.' : 'לא נמצאו תוצאות.'}</Empty>
          ) : (
            <>
              <div className="row" style={{ marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setSelected(filteredUnsigned.map((person) => person.userId))}
                >
                  בחר הכל ({filteredUnsigned.length})
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelected([])}>
                  נקה בחירה
                </button>
              </div>

              <div className="table-wrap" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>שם</th>
                      <th>מספר אישי</th>
                      <th>תפקיד</th>
                      <th>יחידה</th>
                      <th>מין</th>
                      <th>תזונה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUnsigned.map((person) => (
                      <tr key={person.userId}>
                        <td data-label="בחירה">
                          <input
                            type="checkbox"
                            checked={selected.includes(person.userId)}
                            onChange={() => toggle(person.userId)}
                            aria-label={`בחר את ${person.fullName}`}
                          />
                        </td>
                        <td data-label="שם">
                          {person.fullName}
                          {person.isSelf && <span className="muted small"> (אתה)</span>}
                        </td>
                        <td data-label="מספר אישי">{person.companyId}</td>
                        <td data-label="תפקיד">{ROLE_LABEL[person.role]}</td>
                        <td className="muted" data-label="יחידה">{person.unitPath || '—'}</td>
                        <td data-label="מין">{GENDER_LABEL_SINGULAR[person.gender]}</td>
                        <td data-label="תזונה">{DIET_LABEL[person.diet]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* מי שכבר שובץ */}
      <Card title={`שובצו לגלישה (${signed.length})`}>
        {signed.length === 0 ? (
          <Empty>אף אחד מהאנשים שלך לא שובץ עדיין.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>שם</th>
                  <th>תפקיד</th>
                  <th>יחידה</th>
                  <th>פעימה</th>
                  <th>מצב</th>
                  <th>שובץ על ידי</th>
                  <th>השלים פרטים</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {signed.map((person) => (
                  <tr key={person.userId}>
                    <td data-label="שם">{person.fullName}</td>
                    <td data-label="תפקיד">{ROLE_LABEL[person.role]}</td>
                    <td className="muted" data-label="יחידה">{person.unitPath || '—'}</td>
                    <td data-label="פעימה">{person.signup?.cycleName ?? '—'}</td>
                    <td data-label="מצב">
                      <StatusBadge status={person.signup!.status} labels={SIGNUP_STATUS_LABEL} />
                    </td>
                    <td className="muted" data-label="שובץ על ידי">{person.signup?.signedUpBy ?? '—'}</td>
                    <td data-label="השלים פרטים">
                      {person.signup?.dietConfirmed ? (
                        <Badge kind="ok">כן</Badge>
                      ) : (
                        <Badge kind="warn">ממתין</Badge>
                      )}
                    </td>
                    <td data-label="פעולות">
                      {!rosterClosed && (
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          onClick={() => void remove(person.signup!.id)}
                        >
                          הסרה
                        </button>
                      )}
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

// --- הגשת הרשימה לאופרטיבי ------------------------------------------------

/**
 * ההגשה היא הצהרה של המפקד שהרשימה שלו מוכנה - היא אינה נועלת אותה.
 * גם אחרי ההגשה אפשר להוסיף אנשים, עד שהאופרטיבי יגיש את הגלישה.
 */
function SubmitSigningCard({
  tripId,
  submittedAt,
  signedCount,
  rosterClosed,
  onChanged,
}: {
  tripId: number;
  submittedAt: string | null;
  signedCount: number;
  rosterClosed: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const submit = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const result = await api.post<SubmitSigningResponse>(`/trips/${tripId}/submit-signing`);
      setMessage(
        `הרשימה הוגשה לאופרטיבי עם ${result.signedCount} אנשים. אם יאושר אצלך אדם חדש, תוכל לצרף אותו כאן.`,
      );
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'ההגשה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await api.delete(`/trips/${tripId}/submit-signing`);
      setMessage('ההגשה בוטלה. הרשימה חזרה לעריכה.');
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'ביטול ההגשה נכשל'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="הגשת הרשימה"
      actions={
        submittedAt ? (
          <Badge kind="ok">
            {SIGNING_SUBMISSION_LABEL.submitted} · {formatDateTime(submittedAt)}
          </Badge>
        ) : (
          <Badge kind="warn">{SIGNING_SUBMISSION_LABEL.open}</Badge>
        )
      }
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      {submittedAt ? (
        <div className="stack">
          <p className="small muted">
            הרשימה שלך הוגשה לאופרטיבי עם {signedCount} אנשים. אפשר להמשיך להוסיף: אם יאושר אצלך אדם חדש הוא
            יופיע כאן בכרטיס נפרד, ותוכל לצרף אותו עד שהאופרטיבי יגיש את הגלישה. אחרי הגשת האופרטיבי אי אפשר
            עוד להוסיף או להסיר.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={busy || rosterClosed}
              title={rosterClosed ? 'האופרטיבי הגיש את הגלישה' : undefined}
              onClick={() => void withdraw()}
            >
              {busy ? 'מבטל...' : 'ביטול ההגשה'}
            </button>
            <span className="small muted">ביטול ההגשה מחזיר את הרשימה לעריכה ומודיע לאופרטיבי.</span>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            ההגשה מודיעה לאופרטיבי שהרשימה שלך מוכנה. היא אינה סוגרת אותה - גם אחרי ההגשה תוכל להוסיף אנשים
            שאושרו אצלך, עד שהאופרטיבי יגיש את הגלישה.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || rosterClosed}
              title={rosterClosed ? 'הגלישה אינה פתוחה לשינויי שיבוץ' : undefined}
              onClick={() => void submit()}
            >
              {busy ? 'מגיש...' : 'הגשת הרשימה'}
            </button>
            <span className="small muted">{signedCount} אנשים שובצו עד כה</span>
          </div>
        </div>
      )}
    </Card>
  );
}

// --- מי שנוסף ליחידה אחרי ההגשה -------------------------------------------

/**
 * הכרטיס הבולט שבראש המסך: מי שאושר ליחידה אחרי שהמפקד הגיש את הרשימה.
 * בלעדיו המפקד היה צריך לחפש את האדם החדש בתוך טבלת "טרם שובצו" הארוכה.
 */
function LateAdditionsCard({
  tripId,
  people,
  cycles,
  rosterClosed,
  onChanged,
  onAdded,
}: {
  tripId: number;
  people: SignablePerson[];
  cycles: TripCycle[];
  rosterClosed: boolean;
  onChanged: () => Promise<void>;
  onAdded: (message: string) => void;
}) {
  // כשיש פעימה אחת בלבד אין מה לבחור - חוסכים למפקד קליק.
  const [cycleId, setCycleId] = useState(cycles.length === 1 ? String(cycles[0]!.id) : '');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const add = async (person: SignablePerson) => {
    setError('');
    setBusy(person.userId);
    try {
      const result = await api.post<{ added: number; skipped: Array<{ reason: string }>; status: string }>(
        `/trips/${tripId}/signups`,
        { cycleId: Number(cycleId), userIds: [person.userId] },
      );
      if (result.added > 0) {
        onAdded(
          result.status === 'approved'
            ? `${person.fullName} צורף לגלישה.`
            : `${person.fullName} צורף. השיבוץ ממתין לאישור המפקד שמעליך.`,
        );
      }
      if (result.skipped.length > 0) setError(result.skipped.map((entry) => entry.reason).join(' · '));
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'ההוספה נכשלה'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      className="card--attention"
      title={`נוספו ליחידה שלך אחרי ההגשה (${people.length})`}
      actions={<Badge kind="warn">דורש טיפול</Badge>}
    >
      <Alert kind="error">{error}</Alert>

      <div className="stack">
        <p className="small muted">
          האנשים האלה אושרו ליחידה שלך אחרי שהגשת את הרשימה, ולכן הם עדיין לא בגלישה. אפשר לצרף אותם מכאן - עד
          שהאופרטיבי יגיש את הגלישה.
        </p>

        {rosterClosed ? (
          <Alert kind="warn">האופרטיבי הגיש את הגלישה. אי אפשר להוסיף אותם לגלישה הזאת.</Alert>
        ) : (
          <div className="field-row">
            <Field label="פעימת יציאה" hint="הפעימה שאליה יצורפו">
              <select value={cycleId} onChange={(event) => setCycleId(event.target.value)}>
                <option value="">בחר...</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.name} · {formatDate(cycle.exitDate)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <ul className="name-list">
          {people.map((person) => (
            <li key={person.userId}>
              <span>
                {person.fullName}
                <span className="muted small">
                  {' · '}
                  {ROLE_LABEL[person.role]}
                  {person.unitPath ? ` · ${person.unitPath}` : ''}
                </span>
              </span>
              {!rosterClosed && (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={busy !== null || !cycleId}
                  title={!cycleId ? 'יש לבחור פעימת יציאה' : undefined}
                  onClick={() => void add(person)}
                >
                  {busy === person.userId ? 'מוסיף...' : 'הוספה לגלישה'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// --- בקשת רכב פרטי לכמה אנשים בבת אחת --------------------------------------

/**
 * מפקד יכול לבקש רכב פרטי עבור כמה מהאנשים שלו יחד, במקום שכל אחד יבקש
 * בנפרד דרך "השלמת הפרטים" שלו. הבקשה עדיין ממתינה לאישור הרת״ח בשרשרת,
 * בדיוק כמו בקשה אישית - ראו POST /car-requests/bulk בשרת.
 */
function CarRequestsCard({
  tripId,
  people,
  onChanged,
}: {
  tripId: number;
  people: SignablePerson[];
  onChanged: () => Promise<void>;
}) {
  const eligible = useMemo(
    () => people.filter((person) => !person.isSelf && person.signup?.status === 'approved' && person.signup?.carStatus === 'none'),
    [people],
  );

  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (eligible.length === 0) return null;

  const toggle = (userId: number) =>
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );

  const requestCars = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const result = await api.post<{ requested: number; skipped: Array<{ reason: string }> }>(
        `/trips/${tripId}/car-requests/bulk`,
        { userIds: selected },
      );
      setMessage(`נשלחו ${result.requested} בקשות רכב לאישור. ` + (result.requested > 0 ? 'ממתין לאישור הרת״ח.' : ''));
      if (result.skipped.length > 0) setError(result.skipped.map((entry) => entry.reason).join(' · '));
      setSelected([]);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'בקשת הרכב נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`בקשת רכב פרטי לכמה מהאנשים שלי (${selected.length} נבחרו)`}
      actions={
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || selected.length === 0}
          onClick={() => void requestCars()}
        >
          {busy ? 'שולח...' : `בקשת רכב ל-${selected.length}`}
        </button>
      }
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>
      <p className="small muted">
        הבקשה עוברת לאישור הרת״ח בשרשרת הפיקוד (או האופרטיבי, אם אין רת״ח בדרך) - בדיוק כמו בקשת רכב אישית.
      </p>
      <ul className="name-list">
        {eligible.map((person) => (
          <li key={person.userId}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selected.includes(person.userId)}
                onChange={() => toggle(person.userId)}
              />
              <span>
                {person.fullName}
                <span className="muted small"> · {ROLE_LABEL[person.role]}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}
