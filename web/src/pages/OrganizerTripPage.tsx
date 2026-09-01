import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type BusListResponse,
  type DormPlanResponse,
  type Gender,
  type ParticipantsResponse,
  type SigningLeaderOption,
  type Structure,
  type SubmitTripResponse,
  type Trip,
} from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import {
  DIET_LABEL,
  formatDate,
  formatDateTime,
  GENDER_LABEL,
  GENDER_LABEL_SINGULAR,
  plural,
  ROLE_LABEL,
  TRIP_SUBMISSION_LABEL,
} from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading, Stat } from '../components/ui';
import { CarsCard } from '../components/CarsCard';
import { ExportRosterButton } from '../components/ExportRosterButton';

type Tab = 'cycles' | 'dorms' | 'assignments' | 'participants';

const TAB_LABEL: Record<Tab, string> = {
  cycles: 'פעימות יציאה',
  dorms: 'מבני לינה',
  assignments: 'שיבוצים',
  participants: 'משתתפים',
};

export function OrganizerTripPage() {
  const { tripId } = useParams();
  const trip = useApi<{ trip: Trip }>(tripId ? `/trips/${tripId}` : null);
  const [tab, setTab] = useState<Tab>('cycles');

  if (trip.loading) return <Loading />;
  if (trip.error) return <Alert kind="error">{trip.error}</Alert>;
  if (!trip.data || !tripId) return null;

  const data = trip.data.trip;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.name}</h1>
          <p>
            פורסם {formatDate(data.launchDate)} · קיבולת אוטובוס: {data.busCapacity}
          </p>
        </div>
        <div className="row">
          <Link to="/manage" className="btn btn--sm">
            חזרה לגלישות
          </Link>
          <Badge kind={data.state === 'LAUNCHED' ? 'ok' : 'default'}>{data.stateLabel}</Badge>
          {data.submitted && <Badge kind="info">השיבוץ קפוא</Badge>}
          {/* דוח המזון רלוונטי רק בסיכום הגלישה, אחרי שהוא נסגר - לא כפעולה שוטפת. */}
          {data.state === 'CLOSED' && (
            <Link to={`/trips/${tripId}/food`} className="btn btn--sm">
              הזמנת מזון
            </Link>
          )}
          {/* ייצוא ה-CSV זמין תמיד, לא רק בסיום - סיכום ביניים שימושי גם באמצע הגלישה. */}
          <ExportRosterButton tripId={tripId} tripName={data.name} />
          <StateControl trip={data} onChanged={() => void trip.reload()} />
        </div>
      </div>

      <LaunchedPanel trip={data} onChanged={() => void trip.reload()} />
      <SubmitTripPanel trip={data} onChanged={() => void trip.reload()} />

      <div className="tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`tab${tab === key ? ' tab--active' : ''}`}
            onClick={() => setTab(key)}
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      {tab === 'cycles' && <CyclesTab trip={data} onChanged={() => void trip.reload()} />}
      {tab === 'dorms' && <DormsTab trip={data} />}
      {tab === 'assignments' && <AssignmentsTab trip={data} onChanged={() => void trip.reload()} />}
      {tab === 'participants' && <ParticipantsTab tripId={tripId} />}
    </>
  );
}

// --- מכונת המצבים של הגלישה ------------------------------------------------

function StateControl({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setState = async (state: 'LAUNCHED' | 'CLOSED') => {
    setError('');
    setBusy(true);
    try {
      await api.patch(`/trips/${trip.id}`, { state });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      {trip.state === 'LAUNCHED' ? (
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void setState('CLOSED')}>
          סגירת הגלישה
        </button>
      ) : (
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void setState('LAUNCHED')}>
          פתיחה מחדש
        </button>
      )}
    </>
  );
}

/**
 * הפעולה של מצב LAUNCHED: האופרטיבי מודיע למפקדים שקיבלו את המשימה שעליהם לשבץ
 * את האנשים שלהם. האופרטיבי הוא גם רמ״ד, ולכן אם הוטלה עליו המשימה גם הוא משבץ -
 * במסך שיבוץ האנשים, ולא כאן.
 */
function LaunchedPanel({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (trip.state !== 'LAUNCHED') return null;

  const notify = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const result = await api.post<{ notified: number; reminder: boolean }>(`/trips/${trip.id}/notify-leaders`);
      setMessage(
        result.reminder
          ? `נשלחה תזכורת ל-${result.notified} מפקדים.`
          : `נשלחה הודעה ל-${result.notified} מפקדים. הם ישבצו את האנשים שלהם.`,
      );
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'שליחת ההודעה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="מצב הגלישה: פורסמה"
      actions={
        trip.leadersNotified ? (
          <Badge kind="ok">הודעה נשלחה · {formatDate(trip.leadersNotifiedAt)}</Badge>
        ) : (
          <Badge kind="warn">טרם נשלחה הודעה למפקדים</Badge>
        )
      }
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      <p className="small muted">
        בשלב הזה השיבוץ באחריות המפקדים שקיבלו את המשימה: הם משבצים את האנשים שלהם, או מאצילים את השיבוץ
        לר״צים שתחתיהם. הפעולה שלך כאן היא להודיע להם שהגלישה פורסמה.
        {trip.signingAuthority && ' גם עליך הוטלה משימת השיבוץ - את האנשים שלך אתה משבץ במסך שיבוץ האנשים.'}
      </p>

      <div className="row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || trip.cycles.length === 0}
          title={trip.cycles.length === 0 ? 'יש להגדיר לפחות פעימת יציאה אחת' : undefined}
          onClick={() => void notify()}
        >
          {busy
            ? 'שולח...'
            : trip.leadersNotified
              ? 'שליחת תזכורת למפקדים'
              : 'הודעה למפקדים - נדרש שיבוץ אנשים'}
        </button>

        {/* האופרטיבי הוא גם רמ״ד: אם הוטלה עליו המשימה, מכאן הוא מגיע למסך השיבוץ */}
        {trip.signingAuthority && (
          <Link to={`/trips/${trip.id}/signing`} className="btn">
            שיבוץ האנשים שלי
          </Link>
        )}
      </div>
      {trip.cycles.length === 0 && (
        <p className="small muted" style={{ marginTop: '0.5rem' }}>
          יש להגדיר פעימות יציאה לפני ההודעה למפקדים.
        </p>
      )}
    </Card>
  );
}

// --- הגשת הגלישה -----------------------------------------------------------

/**
 * הגשת הגלישה היא הפעולה שמקפיאה את השיבוץ. עד אליה מפקד שהגיש את הרשימה שלו
 * עוד יכול להוסיף מי שאושר ליחידה שלו אחר כך; מרגע ההגשה אף אחד לא מוסיף ולא מסיר.
 */
function SubmitTripPanel({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const pending = trip.cycles.reduce((sum, cycle) => sum + cycle.pendingCount, 0);
  const notSubmitted = trip.leaders.filter((leader) => leader.submittedAt == null);

  const submit = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const result = await api.post<SubmitTripResponse>(`/trips/${trip.id}/submit`);
      const missing = result.leadersNotSubmitted.map((leader) => leader.fullName).join(', ');
      setMessage(
        `הגלישה הוגשה. ${result.approved} נרשמים מאושרים` +
          (result.pending > 0 ? ` · ${result.pending} ממתינים לאישור מפקד ולא ייכנסו לשיבוץ` : '') +
          (missing
            ? ` · מפקדים שלא הגישו את הרשימה: ${missing}. מה ששיבצו עד כה נכנס.`
            : ' · כל המפקדים הגישו את הרשימות שלהם.'),
      );
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'הגשת הגלישה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const reopen = async () => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await api.delete(`/trips/${trip.id}/submit`);
      setMessage('השיבוץ נפתח מחדש. המפקדים יכולים שוב להוסיף ולהסיר אנשים.');
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'פתיחת השיבוץ נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="הגשת הגלישה"
      actions={
        trip.submitted ? (
          <Badge kind="ok">
            {TRIP_SUBMISSION_LABEL.submitted} · {formatDateTime(trip.submittedAt)}
          </Badge>
        ) : (
          <Badge kind="warn">{TRIP_SUBMISSION_LABEL.open}</Badge>
        )
      }
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      {trip.submitted ? (
        <div className="stack">
          <p className="small muted">
            השיבוץ קפוא: אף מפקד אינו יכול להוסיף או להסיר אנשים, גם לא מי שנוסף ליחידה שלו אחרי שהגיש.
            מי שכבר שובץ עדיין יכול להשלים את השותפים לחדר ואת אישור התזונה.
          </p>
          <div className="row">
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void reopen()}>
              {busy ? 'פותח...' : 'פתיחת השיבוץ מחדש'}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            ההגשה מקפיאה את השיבוץ לכולם: מרגע ההגשה שום מפקד לא יוכל להוסיף או להסיר אנשים. בקשות
            שממתינות לאישור מפקד יישארו ממתינות ולא ייכנסו לשיבוץ האוטובוסים והלינה.
          </p>

          <div>
            <strong className="small">
              מצב ההגשה של המפקדים ({trip.leaders.length - notSubmitted.length}/{trip.leaders.length})
            </strong>
            <ul className="name-list">
              {trip.leaders.map((leader) => (
                <li key={leader.id}>
                  <span>
                    {leader.fullName}
                    <span className="muted small">
                      {' · '}
                      {ROLE_LABEL[leader.role]}
                      {leader.unitName ? ` · ${leader.unitName}` : ''}
                      {' · '}
                      {leader.signedCount} שובצו
                    </span>
                  </span>
                  {leader.submittedAt ? (
                    <Badge kind="ok">הגיש · {formatDateTime(leader.submittedAt)}</Badge>
                  ) : (
                    <Badge kind="warn">טרם הגיש</Badge>
                  )}
                </li>
              ))}
              {trip.leaders.length === 0 && <li className="muted">לא הוגדרו מפקדים</li>}
            </ul>
          </div>

          {notSubmitted.length > 0 && (
            <Alert kind="warn">
              {plural(notSubmitted.length, 'מפקד', 'מפקדים')} טרם הגישו את הרשימה. אפשר להגיש בכל מקרה - מה
              שהם שיבצו עד כה נכנס לשיבוץ.
            </Alert>
          )}
          {pending > 0 && (
            <Alert kind="warn">
              {pending} בקשות ממתינות לאישור מפקד. ההגשה אינה מאשרת אותן - הן יישארו ממתינות ולא ייכנסו
              לשיבוץ.
            </Alert>
          )}

          <div className="row">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'מגיש...' : 'הגשת הגלישה'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// --- מפקדים עם משימת שיבוץ -------------------------------------------------

/**
 * עריכת רשימת המפקדים שקיבלו את משימת השיבוץ. בזמן היצירה זו הפעם היחידה
 * לבחור אותם - כאן אפשר להוסיף עוד מפקדים גם אחרי הפרסום (למשל רת״ח נוסף
 * ששכחו), כל עוד השיבוצים לא ננעלו (PATCH /trips/:id, ראו trips.routes.ts).
 */
function LeadersCard({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const options = useApi<{ leaders: SigningLeaderOption[] }>('/trips/signing-leaders');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');

  const locked = trip.busesLocked || trip.dormsLocked;
  const currentIds = new Set(trip.leaders.map((leader) => leader.id));
  const available = (options.data?.leaders ?? []).filter((leader) => !currentIds.has(leader.id));

  const updateLeaders = async (leaderIds: number[]) => {
    setError('');
    setBusy(true);
    try {
      await api.patch(`/trips/${trip.id}`, { leaderIds });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'עדכון המפקדים נכשל'));
    } finally {
      setBusy(false);
    }
  };

  const addLeader = () => {
    if (!adding) return;
    const next = [...currentIds, Number(adding)];
    setAdding('');
    void updateLeaders(next);
  };

  const removeLeader = (id: number) => {
    if (trip.leaders.length <= 1) {
      setError('חייב להישאר לפחות מפקד אחד עם משימת השיבוץ');
      return;
    }
    void updateLeaders(trip.leaders.filter((leader) => leader.id !== id).map((leader) => leader.id));
  };

  return (
    <Card title={`מפקדים עם משימת שיבוץ (${trip.leaders.length})`}>
      <Alert kind="error">{error}</Alert>
      {locked && <Alert kind="warn">אי אפשר לשנות מפקדים אחרי נעילת האוטובוסים או הלינה.</Alert>}

      <ul className="name-list">
        {trip.leaders.map((leader) => (
          <li key={leader.id}>
            <span>
              {leader.fullName}
              <span className="muted small">
                {' · '}
                {ROLE_LABEL[leader.role]}
                {leader.unitName ? ` · ${leader.unitName}` : ''}
              </span>
            </span>
            {!locked && (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={busy}
                onClick={() => removeLeader(leader.id)}
              >
                הסרה
              </button>
            )}
          </li>
        ))}
      </ul>

      {!locked && (
        <div className="field-row" style={{ marginTop: '0.75rem' }}>
          <Field label="הוספת מפקד נוסף" hint="למשל רת״ח או רמ״ד נוסף שצריך לשבץ את האנשים שלו">
            <select value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">בחר...</option>
              {available.map((leader) => (
                <option key={leader.id} value={leader.id}>
                  {leader.fullName} · {ROLE_LABEL[leader.role]}
                  {leader.unitName ? ` · ${leader.unitName}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="btn btn--sm" disabled={busy || !adding} onClick={addLeader}>
            הוספה
          </button>
        </div>
      )}
    </Card>
  );
}

// --- פעימות יציאה ---------------------------------------------------------

function CyclesTab({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const [exitDate, setExitDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/trips/${trip.id}/cycles`, { exitDate });
      setExitDate('');
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'הוספת הפעימה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cycleId: number) => {
    setError('');
    try {
      await api.delete(`/trips/${trip.id}/cycles/${cycleId}`);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'מחיקת הפעימה נכשלה'));
    }
  };

  return (
    <>
      <Alert kind="error">{error}</Alert>
      {trip.submitted && <Alert kind="warn">הגלישה הוגשה והשיבוץ קפוא. יש לפתוח את השיבוץ מחדש כדי לשנות פעימות.</Alert>}

      <LeadersCard trip={trip} onChanged={onChanged} />

      <Card title={`פעימות יציאה (${trip.cycles.length})`}>
        {!trip.submitted && (
          <form onSubmit={add} className="field-row field-row--end" style={{ marginBottom: '1rem' }}>
            <Field
              label="הוספת פעימת יציאה"
              hint="השם נגזר מסדר היציאה: ראשונה היא החלוץ, ואחריה פעימה 1, פעימה 2 וכן הלאה"
            >
              <input type="date" value={exitDate} onChange={(event) => setExitDate(event.target.value)} required />
            </Field>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              הוספה
            </button>
          </form>
        )}

        {trip.cycles.length === 0 ? (
          <Empty>לא הוגדרו פעימות יציאה. אי אפשר לשבץ אנשים בלי פעימה אחת לפחות.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>פעימה</th>
                  <th>יציאה</th>
                  <th>מאושרים</th>
                  <th>ממתינים</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {trip.cycles.map((cycle) => (
                  <tr key={cycle.id}>
                    <td data-label="פעימה">{cycle.name}</td>
                    <td data-label="יציאה">{formatDate(cycle.exitDate)}</td>
                    <td data-label="מאושרים">
                      <Badge kind="ok">{cycle.approvedCount}</Badge>
                    </td>
                    <td data-label="ממתינים">
                      {cycle.pendingCount > 0 ? (
                        <Badge kind="warn">{cycle.pendingCount}</Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="פעולות">
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        onClick={() => void remove(cycle.id)}
                        disabled={trip.submitted || cycle.approvedCount + cycle.pendingCount > 0}
                        title={
                          trip.submitted
                            ? 'הגלישה הוגשה - השיבוץ קפוא'
                            : cycle.approvedCount + cycle.pendingCount > 0
                              ? 'יש נרשמים לפעימה הזו'
                              : undefined
                        }
                      >
                        מחיקה
                      </button>
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

// --- מבני לינה ------------------------------------------------------------

function DormsTab({ trip }: { trip: Trip }) {
  const { data, loading, error, reload } = useApi<{ structures: Structure[] }>(`/trips/${trip.id}/structures`);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [roomsText, setRoomsText] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  /** קלט חופשי בצורת "101:4" בכל שורה, כדי להזין מבנה שלם במהירות. */
  const parseRooms = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [roomName, beds] = line.split(/[:,\s]+/);
        return { name: (roomName ?? '').trim(), beds: Number(beds) };
      });

  const addStructure = async (event: React.FormEvent) => {
    event.preventDefault();
    setActionError('');

    const rooms = parseRooms(roomsText);
    if (rooms.some((room) => !room.name || !Number.isInteger(room.beds) || room.beds <= 0)) {
      setActionError('כל שורה צריכה להיות בצורת "מספר חדר: מספר מיטות", למשל 101: 4');
      return;
    }

    setBusy(true);
    try {
      await api.post(`/trips/${trip.id}/structures`, { name, gender, rooms });
      setName('');
      setRoomsText('');
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught, 'הוספת המבנה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const removeStructure = async (structureId: number) => {
    setActionError('');
    try {
      await api.delete(`/trips/${trip.id}/structures/${structureId}`);
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught, 'מחיקת המבנה נכשלה'));
    }
  };

  const removeRoom = async (roomId: number) => {
    setActionError('');
    try {
      await api.delete(`/trips/${trip.id}/rooms/${roomId}`);
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught, 'מחיקת החדר נכשלה'));
    }
  };

  if (loading) return <Loading />;

  const structures = data?.structures ?? [];
  const bedsByGender = (target: Gender) =>
    structures.filter((structure) => structure.gender === target).reduce((sum, s) => sum + s.totalBeds, 0);

  return (
    <>
      <Alert kind="error">{error || actionError}</Alert>
      {trip.dormsLocked && <Alert kind="warn">שיבוץ הלינה נעול. יש לבטל את הנעילה כדי לשנות מבנים.</Alert>}

      {!trip.dormsLocked && <DormPlanCard tripId={trip.id} />}

      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <Stat value={structures.length} label="מבנים" />
        <Stat value={structures.reduce((sum, s) => sum + s.rooms.length, 0)} label="חדרים" />
        <Stat value={bedsByGender('male')} label="מיטות בנים" />
        <Stat value={bedsByGender('female')} label="מיטות בנות" />
      </div>

      {!trip.dormsLocked && (
        <Card title="הוספת מבנה">
          <form onSubmit={addStructure}>
            <div className="field-row">
              <Field label="שם המבנה">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="מבנה א׳"
                  required
                />
              </Field>
              <Field label="מין" hint="כל מבנה משויך למין אחד בלבד">
                <select value={gender} onChange={(event) => setGender(event.target.value as Gender)}>
                  <option value="male">{GENDER_LABEL.male}</option>
                  <option value="female">{GENDER_LABEL.female}</option>
                </select>
              </Field>
            </div>
            <Field label="חדרים" hint='שורה לכל חדר, בצורת "מספר חדר: מספר מיטות"'>
              <textarea
                value={roomsText}
                onChange={(event) => setRoomsText(event.target.value)}
                placeholder={'101: 4\n102: 4\n103: 6'}
                rows={5}
              />
            </Field>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              הוספת מבנה
            </button>
          </form>
        </Card>
      )}

      {structures.length === 0 ? (
        <Empty>לא הוגדרו מבני לינה. בלי מבנים אי אפשר להריץ שיבוץ לינה.</Empty>
      ) : (
        <div className="grid">
          {structures.map((structure) => (
            <Card
              key={structure.id}
              title={
                <div>
                  <h3>{structure.name}</h3>
                  <div className="row small">
                    <Badge kind={structure.gender === 'male' ? 'info' : 'warn'}>
                      {GENDER_LABEL[structure.gender]}
                    </Badge>
                    <span className="muted">
                      {structure.rooms.length} חדרים · {structure.totalBeds} מיטות
                    </span>
                  </div>
                </div>
              }
              actions={
                !trip.dormsLocked && (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => void removeStructure(structure.id)}
                  >
                    מחיקת מבנה
                  </button>
                )
              }
            >
              <ul className="name-list">
                {structure.rooms.map((room) => (
                  <li key={room.id}>
                    <span>
                      חדר {room.name} · {room.beds} מיטות
                    </span>
                    <span className="row">
                      {room.assigned > 0 && <Badge kind="ok">{room.assigned} משובצים</Badge>}
                      {!trip.dormsLocked && (
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => void removeRoom(room.id)}
                        >
                          מחיקה
                        </button>
                      )}
                    </span>
                  </li>
                ))}
                {structure.rooms.length === 0 && <li className="muted">אין חדרים במבנה</li>}
              </ul>
              {!trip.dormsLocked && <AddRoomForm tripId={trip.id} structureId={structure.id} onAdded={reload} />}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * תוכנית לינה מוקדמת: לפני שיש מבני לינה בפועל, מריצה את מנוע השיבוץ מול
 * מלאי סינתטי כדי להראות כמה חדרים ובאיזה גודל (4-8 מיטות) כדאי להזמין
 * מהספק - ראו planDormRooms בשרת. מוצגת רק כשהלינה לא נעולה, כי אחריה כבר
 * יש שיבוץ אמיתי לחדרים קיימים.
 */
function DormPlanCard({ tripId }: { tripId: number }) {
  const { data, loading, error } = useApi<DormPlanResponse>(`/trips/${tripId}/dorms/plan`);
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const cycles = data?.cycles ?? [];
  // רק פעימות שיש בהן מישהו, לפי סדר היציאה - כדי להשוות כל פעימה לקודמת
  // שקדמה לה בפועל ולדעת מאיזה תאריך נדרשים עוד חדרים.
  const active = cycles.filter((cycle) => cycle.plan.totalPeople > 0);
  const hasAnyone = active.length > 0;

  const downloadPlan = async () => {
    setDownloadError('');
    setDownloading(true);
    try {
      await api.download(`/trips/${tripId}/dorms/plan.xlsx`, `trip-${tripId}-dorm-request.xlsx`);
    } catch (caught) {
      setDownloadError(errorMessage(caught, 'הורדת הקובץ נכשלה'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card
      title="תוכנית לינה מוקדמת"
      actions={
        hasAnyone && (
          <button type="button" className="btn btn--sm" disabled={downloading} onClick={() => void downloadPlan()}>
            {downloading ? 'מוריד...' : 'הורדת בקשה לספק (Excel)'}
          </button>
        )
      }
    >
      <Alert kind="error">{downloadError}</Alert>
      <p className="muted small">
        לפני שיש מבני לינה במערכת - כך אפשר לדעת כמה חדרים ובאיזה גודל (מומלץ 8 מיטות) לבקש מהספק, על סמך מי
        שכבר שובץ לגלישה. אותם חדרים מתפנים ומשמשים שוב בכל פעימה, ולכן פעימה יידרש לה חדר נוסף רק אם היא גדולה
        יותר מכל הפעימות שיצאו לפניה - לא לפי סכום כל הפעימות.
      </p>
      <Alert kind="error">{error}</Alert>
      {loading ? (
        <Loading />
      ) : !hasAnyone ? (
        <Empty>אין עדיין משתתפים מאושרים באף פעימה.</Empty>
      ) : (
        <div className="stack">
          {active.map((cycle) => (
            <div key={cycle.cycleId}>
              <strong className="small">
                {cycle.cycleName} · יציאה {formatDate(cycle.exitDate)} · {cycle.plan.totalPeople} אנשים ·{' '}
                {cycle.plan.totalRooms} חדרים
              </strong>
              <ul className="name-list">
                {cycle.plan.sizeCounts.map((entry) => (
                  <li key={`${entry.gender}-${entry.size}`}>
                    <span>
                      <Badge kind={entry.gender === 'male' ? 'info' : 'warn'}>{GENDER_LABEL[entry.gender]}</Badge>{' '}
                      {plural(entry.count, 'חדר', `${entry.count} חדרים`)} בני {entry.size} מיטות
                    </span>
                  </li>
                ))}
              </ul>
              {cycle.extraRoomsNeeded > 0 && (
                <Alert kind="warn">
                  מעבר למה שכבר סופק לפעימות שיוצאות לפני {formatDate(cycle.exitDate)}, פעימה זו תדרוש עוד{' '}
                  {plural(cycle.extraRoomsNeeded, 'חדר', `${cycle.extraRoomsNeeded} חדרים`)}.
                </Alert>
              )}
              {cycle.plan.unassigned > 0 && (
                <p className="small muted">{cycle.plan.unassigned} אנשים לא נכנסו לתוכנית.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AddRoomForm({
  tripId,
  structureId,
  onAdded,
}: {
  tripId: number;
  structureId: number;
  onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [beds, setBeds] = useState('4');
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await api.post(`/trips/${tripId}/structures/${structureId}/rooms`, { name, beds: Number(beds) });
      setName('');
      await onAdded();
    } catch (caught) {
      setError(errorMessage(caught, 'הוספת החדר נכשלה'));
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: '0.75rem' }}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="מספר חדר"
          required
          style={{ maxWidth: '120px' }}
        />
        <input
          type="number"
          min={1}
          max={30}
          value={beds}
          onChange={(event) => setBeds(event.target.value)}
          required
          style={{ maxWidth: '90px' }}
        />
        <button type="submit" className="btn btn--sm">
          הוספת חדר
        </button>
      </div>
    </form>
  );
}

// --- שיבוצים --------------------------------------------------------------

function AssignmentsTab({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const buses = useApi<BusListResponse>(`/trips/${trip.id}/buses`);

  const run = async (path: string, successMessage: string) => {
    setError('');
    setMessage('');
    setBusy(path);
    try {
      const result = await api.post<{ roomsAdded?: number }>(`/trips/${trip.id}/${path}`);
      setMessage(
        result.roomsAdded
          ? `${successMessage} · נפתחו ${result.roomsAdded} חדרים נוספים כדי שלכולם תהיה מיטה.`
          : successMessage,
      );
      onChanged();
      void buses.reload();
    } catch (caught) {
      setError(errorMessage(caught, 'הפעולה נכשלה'));
    } finally {
      setBusy(null);
    }
  };

  const totalApproved = trip.cycles.reduce((sum, cycle) => sum + cycle.approvedCount, 0);
  const totalPending = trip.cycles.reduce((sum, cycle) => sum + cycle.pendingCount, 0);

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <Stat value={totalApproved} label="נרשמים מאושרים" />
        <Stat value={totalPending} label="ממתינים לאישור מפקד" />
      </div>

      {trip.submitted && <Alert kind="info">הגלישה הוגשה - רשימת המשתתפים קפואה וניתן לחשב את השיבוצים.</Alert>}

      {totalPending > 0 && (
        <Alert kind="warn">
          יש {totalPending} בקשות שממתינות לאישור מפקד. הן לא ייכנסו לשיבוץ עד שיאושרו.
        </Alert>
      )}

      <div className="grid">
        <Card
          title="שיבוץ אוטובוסים"
          actions={trip.busesLocked ? <Badge kind="ok">נעול</Badge> : <Badge kind="warn">לא נעול</Badge>}
        >
          <p className="small muted">
            המערכת מחלקת את המשתתפים לאוטובוסים בקיבולת {trip.busCapacity}, ומשאירה מדורים וצוותים שלמים באותו
            אוטובוס כשאפשר. השיבוץ מחושב בנפרד לכל פעימת יציאה.
          </p>

          {trip.busesLocked ? (
            <div className="stack">
              <p className="small">נעול ב־{formatDate(trip.busesLockedAt)}</p>
              <div className="row">
                <Link to={`/trips/${trip.id}/buses`} className="btn btn--primary">
                  צפייה ברשימה המלאה
                </Link>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy !== null}
                  onClick={() => void run('buses/unlock', 'נעילת האוטובוסים בוטלה')}
                >
                  ביטול נעילה
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={busy !== null || totalApproved === 0}
              onClick={() => void run('buses/lock', 'שיבוץ האוטובוסים חושב, נשמר ופורסם')}
            >
              {busy === 'buses/lock' ? 'מחשב...' : 'נעילה וחישוב שיבוץ'}
            </button>
          )}
        </Card>

        <Card
          title="שיבוץ לינה"
          actions={trip.dormsLocked ? <Badge kind="ok">נעול</Badge> : <Badge kind="warn">לא נעול</Badge>}
        >
          <p className="small muted">
            המערכת משבצת לחדרים לפי העדפות השותפים, כשמבנה שלם הוא חד-מיני וחיילים ומפקדים אינם ישנים יחד. מי
            שלא קיבל אף העדפה מדווח למפקד שלו עם הצעות חלופיות.
          </p>

          {trip.dormsLocked ? (
            <div className="stack">
              <p className="small">נעול ב־{formatDate(trip.dormsLockedAt)}</p>
              <div className="row">
                <Link to={`/trips/${trip.id}/dorms`} className="btn btn--primary">
                  צפייה ברשימה המלאה
                </Link>
                <Link to={`/trips/${trip.id}/dorm-issues`} className="btn">
                  בעיות שיבוץ
                </Link>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy !== null}
                  onClick={() => void run('dorms/unlock', 'נעילת הלינה בוטלה')}
                >
                  ביטול נעילה
                </button>
              </div>
            </div>
          ) : (
            <div className="stack">
              {/* לפני שיש מבני לינה אמיתיים, נעילת השיבוץ חסומה - התוכנית
                  המוקדמת כאן מראה בדיוק מה לבקש מהספק כדי להסיר את החסימה. */}
              <DormPlanCard tripId={trip.id} />
              <button
                type="button"
                className="btn btn--primary btn--block"
                disabled={busy !== null || totalApproved === 0}
                onClick={() => void run('dorms/lock', 'שיבוץ הלינה חושב, נשמר ופורסם')}
              >
                {busy === 'dorms/lock' ? 'מחשב...' : 'נעילה וחישוב שיבוץ'}
              </button>
            </div>
          )}
        </Card>
      </div>

      <CarsCard cars={buses.data?.cars} />
    </>
  );
}

// --- משתתפים --------------------------------------------------------------

function ParticipantsTab({ tripId }: { tripId: string }) {
  const { data, loading, error } = useApi<ParticipantsResponse>(`/trips/${tripId}/participants`);

  if (loading) return <Loading />;

  return (
    <>
      <Alert kind="error">{error}</Alert>

      {(data?.cycles ?? []).map((cycle) => (
        <Card
          key={cycle.cycleId}
          title={`${cycle.cycleName} · יציאה ${formatDate(cycle.exitDate)}`}
          actions={<Badge kind="ok">{cycle.totalApproved} מאושרים</Badge>}
        >
          {cycle.participants.length === 0 ? (
            <Empty>אין משתתפים מאושרים בפעימה הזו.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>שם</th>
                    <th>מספר אישי</th>
                    <th>תפקיד</th>
                    <th>מדור</th>
                    <th>צוות</th>
                    <th>מין</th>
                    <th>תזונה</th>
                    <th>מפקד</th>
                  </tr>
                </thead>
                <tbody>
                  {cycle.participants.map((participant, index) => (
                    <tr key={participant.userId}>
                      <td className="muted" data-label="#">{index + 1}</td>
                      <td data-label="שם">{participant.fullName}</td>
                      <td data-label="מספר אישי">{participant.companyId}</td>
                      <td data-label="תפקיד">{ROLE_LABEL[participant.role]}</td>
                      <td className="muted" data-label="מדור">{participant.sectorName ?? '—'}</td>
                      <td className="muted" data-label="צוות">{participant.teamName ?? '—'}</td>
                      <td data-label="מין">{GENDER_LABEL_SINGULAR[participant.gender]}</td>
                      <td data-label="תזונה">
                        {participant.diet === 'all' ? (
                          <span className="muted">{DIET_LABEL.all}</span>
                        ) : (
                          <Badge kind="warn">{DIET_LABEL[participant.diet]}</Badge>
                        )}
                      </td>
                      <td className="muted" data-label="מפקד">{participant.managerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </>
  );
}
