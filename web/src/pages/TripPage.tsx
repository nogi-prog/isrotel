import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type BusListResponse,
  type CarPassengerCandidate,
  type Diet,
  type RoommateCandidate,
  type ShiftReportsMineResponse,
  type ShiftReportsResponse,
  type ShiftReportSubject,
  type ShiftReportSummaryEntry,
  type Signup,
  type Trip,
  type TripSummary,
} from '../lib/api';
import { useCurrentUser } from '../lib/auth';
import { errorMessage, useApi } from '../lib/useApi';
import {
  CAR_STATUS_LABEL,
  DIET_LABEL,
  formatDate,
  formatDateTime,
  GENDER_LABEL_SINGULAR,
  SIGNUP_STATUS_LABEL,
  TRIP_STATE_LABEL,
} from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading, Stat, StatusBadge } from '../components/ui';
import { CarsCard } from '../components/CarsCard';
import { ExportRosterButton } from '../components/ExportRosterButton';
import { MAX_PREFERENCES } from '../lib/constants';

/** רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - עובדה קבועה בפרופיל, לא בקשה לכל גלישה. ראו lib/cars.ts בשרת. */
function alwaysBringsOwnCar(role: string): boolean {
  return role === 'division_leader' || role === 'ceo';
}

export function TripPage() {
  const { tripId } = useParams();
  const user = useCurrentUser();
  const trip = useApi<{ trip: Trip }>(tripId ? `/trips/${tripId}` : null);
  const summary = useApi<TripSummary>(tripId ? `/trips/${tripId}/summary` : null);

  if (trip.loading) return <Loading />;
  if (trip.error) return <Alert kind="error">{trip.error}</Alert>;
  if (!trip.data) return null;

  const data = trip.data.trip;
  const reloadAll = async () => {
    await Promise.all([trip.reload(), summary.reload()]);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.name}</h1>
          <p>פורסם {formatDate(data.launchDate)}</p>
        </div>
        <div className="row">
          <Link to="/" className="btn btn--sm">
            חזרה לגלישות שלי
          </Link>
          <Badge kind={data.state === 'LAUNCHED' ? 'ok' : 'default'}>
            {TRIP_STATE_LABEL[data.state] ?? data.state}
          </Badge>
          {data.signingAuthority && (
            <Link to={`/trips/${data.id}/signing`} className="btn btn--sm btn--primary">
              שיבוץ אנשים
            </Link>
          )}
          {user.isManager && (
            <Link to={`/trips/${data.id}/approvals`} className="btn btn--sm">
              אישורים
            </Link>
          )}
          {data.busesLocked && (
            <Link to={`/trips/${data.id}/buses`} className="btn btn--sm">
              אוטובוסים
            </Link>
          )}
          {data.dormsLocked && (
            <Link to={`/trips/${data.id}/dorms`} className="btn btn--sm">
              לינה
            </Link>
          )}
          {/* ייצוא CSV לרת״ח - התחום שלו בלבד, ראו requireRole ב-reports.routes.ts בשרת. */}
          {user.role === 'division_leader' && <ExportRosterButton tripId={data.id} tripName={data.name} />}
        </div>
      </div>

      {data.mySignup ? (
        <MyTripView trip={data} summary={summary.data} loading={summary.loading} onChanged={reloadAll} />
      ) : (
        <NotSignedUpView trip={data} />
      )}

      {/* חייל רואה את מספר האוטובוס שלו בכרטיס שלמעלה; הפירוט המלא הוא כלי של מפקד. */}
      {user.isManager && <TransportRoster tripId={data.id} />}

      {/* ר״צ מדווח על משמרות שצריך לבטל - לעצמו ולחיילים הישירים שלו. */}
      {user.role === 'team_leader' && <ShiftReportsCard tripId={data.id} />}

      {/* לאופרטיבי - סיכום כל מי שיש לו משמרת לבטל, כדי לדעת למי לפנות. */}
      {user.isTripOrganizer && <ShiftSummaryCard tripId={data.id} />}
    </>
  );
}

// --- פירוט ההסעות: מי באיזה אוטובוס, ומי מגיע ברכב פרטי ------------------

/**
 * טבלת האוטובוסים על אנשיהם, ואחריה מי מגיע ברכב פרטי.
 * הסינון לפי הרשאות נעשה בשרת: אופרטיבי רואה את כל החברה, מפקד רק את
 * האנשים שלו - ולכן אין כאן בדיקת הרשאות נוספת.
 */
function TransportRoster({ tripId }: { tripId: number }) {
  const { data, loading, error } = useApi<BusListResponse>(`/trips/${tripId}/buses`);

  if (loading) return <Loading />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  const cars = data.cars;
  const scopeNote = data.scope === 'my-people' ? ' · מוצגים רק האנשים שלך' : '';

  return (
    <>
      <div className="page-head" style={{ marginTop: '1.5rem' }}>
        <div>
          <h2>הסעות</h2>
          <p className="muted small">
            {data.locked
              ? `שיבוץ האוטובוסים פורסם${data.capacity ? ` · קיבולת ${data.capacity}` : ''}${scopeNote}`
              : `שיבוץ האוטובוסים עוד לא פורסם${scopeNote}`}
          </p>
        </div>
      </div>

      {!data.locked && (
        <Alert kind="info">
          שיבוץ האוטובוסים עוד לא נעול ופורסם על ידי האופרטיבי. בינתיים מוצגים רק מי שמגיעים ברכב פרטי.
        </Alert>
      )}

      {data.cycles.map((cycle) => {
        // שורה אחת לכל אדם, ממוינת לפי אוטובוס - כך רואים בבת אחת מי בכל אוטובוס.
        const rows = cycle.buses.flatMap((bus) => bus.members.map((member) => ({ bus: bus.number, member })));

        return (
          <Card
            key={cycle.cycleId}
            title={`${cycle.cycleName} · יציאה ${formatDate(cycle.exitDate)}`}
            actions={
              <>
                <Badge kind="info">{cycle.buses.length} אוטובוסים</Badge>
                <Badge>{rows.length} אנשים</Badge>
              </>
            }
          >
            {rows.length === 0 ? (
              <Empty>אין אנשים שלך בפעימה הזו.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>אוטובוס</th>
                      <th>שם</th>
                      <th>מספר אישי</th>
                      <th>מין</th>
                      <th>תזונה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ bus, member }) => (
                      <tr key={member.userId}>
                        <td data-label="אוטובוס">
                          <Badge kind="info">{bus}</Badge>
                        </td>
                        <td data-label="שם">{member.fullName}</td>
                        <td className="muted" data-label="מספר אישי">
                          {member.companyId}
                        </td>
                        <td data-label="מין">{GENDER_LABEL_SINGULAR[member.gender]}</td>
                        <td data-label="תזונה">{DIET_LABEL[member.diet]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      <CarsCard cars={cars} />
    </>
  );
}

// --- דיווח על ביטול משמרות (שבצ״ק) ----------------------------------------

/**
 * ר״צ מדווח כאן אם לו או לחייל ישיר שלו יש משמרת שצריך לבטל בגלל הגלישה.
 * המערכת אינה מכירה עדיין את לוח המשמרות בפועל, ולכן זהו דיווח ידני -
 * ראו lib/shifts.ts (בהערת התיעוד ב-schema.sql) בשרת.
 */
function ShiftReportsCard({ tripId }: { tripId: number }) {
  const { data, loading, error, reload } = useApi<ShiftReportsMineResponse>(`/trips/${tripId}/shift-reports/mine`);

  return (
    <Card title="דיווח על ביטול משמרות">
      <p className="muted small">
        המערכת עדיין לא מכירה את לוח המשמרות בפועל - יש לדווח ידנית אם לך או למישהו מהחיילים שלך יש
        משמרת שצריך לבטל בגלל הגלישה.
      </p>
      <Alert kind="error">{error}</Alert>
      {loading ? (
        <Loading />
      ) : !data || data.subjects.length === 0 ? (
        <Empty>אין לך חיילים ישירים לדווח עבורם.</Empty>
      ) : (
        <div className="stack">
          {data.subjects.map((subject) => (
            <ShiftReportRow key={subject.userId} tripId={tripId} subject={subject} onSaved={() => void reload()} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ShiftReportRow({
  tripId,
  subject,
  onSaved,
}: {
  tripId: number;
  subject: ShiftReportSubject;
  onSaved: () => void;
}) {
  const [hasShift, setHasShift] = useState(subject.hasShift);
  const [details, setDetails] = useState(subject.details ?? '');
  const [dutyType, setDutyType] = useState(subject.dutyType ?? '');
  const [dutyLocation, setDutyLocation] = useState(subject.dutyLocation ?? '');
  const [dutyDates, setDutyDates] = useState(subject.dutyDates ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const dirty =
    hasShift !== subject.hasShift ||
    details !== (subject.details ?? '') ||
    dutyType !== (subject.dutyType ?? '') ||
    dutyLocation !== (subject.dutyLocation ?? '') ||
    dutyDates !== (subject.dutyDates ?? '');

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      await api.put(`/trips/${tripId}/shift-reports/${subject.userId}`, {
        hasShift,
        details: hasShift ? details.trim() : null,
        dutyType: hasShift ? dutyType.trim() || null : null,
        dutyLocation: hasShift ? dutyLocation.trim() || null : null,
        dutyDates: hasShift ? dutyDates.trim() || null : null,
      });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught, 'שמירת הדיווח נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
      <Alert kind="error">{error}</Alert>
      <label className="checkbox">
        <input type="checkbox" checked={hasShift} onChange={(event) => setHasShift(event.target.checked)} />
        <span>
          <strong>{subject.fullName}</strong>
          {subject.isSelf ? ' (אני)' : ''} - יש משמרת שצריך לבטל
        </span>
      </label>

      {hasShift && (
        <>
          <Field label="פרטי המשמרת">
            <input
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="לדוגמה: משמרת שמירה ביום ג׳ בערב"
            />
          </Field>
          <div className="field-row">
            <Field label="סוג תורנות" hint="לא חובה">
              <input value={dutyType} onChange={(event) => setDutyType(event.target.value)} placeholder="לדוגמה: רס״ר" />
            </Field>
            <Field label="איפה מתקיימת" hint="לא חובה">
              <input value={dutyLocation} onChange={(event) => setDutyLocation(event.target.value)} placeholder="לדוגמה: גלילות" />
            </Field>
            <Field label="תאריכים" hint="לא חובה">
              <input value={dutyDates} onChange={(event) => setDutyDates(event.target.value)} placeholder="לדוגמה: 2.8-5.8" />
            </Field>
          </div>
        </>
      )}

      {dirty && (
        <div className="row">
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'שומר...' : 'שמירה'}
          </button>
        </div>
      )}

      {!dirty && subject.updatedAt && (
        <span className="muted small">עודכן לאחרונה {formatDateTime(subject.updatedAt)}</span>
      )}
    </div>
  );
}

/** לאופרטיבי - סיכום כל מי שדווח שיש לו משמרת לבטל, כדי לפנות ולתאם. */
function ShiftSummaryCard({ tripId }: { tripId: number }) {
  const { data, loading, error, reload } = useApi<ShiftReportsResponse>(`/trips/${tripId}/shift-reports`);

  return (
    <Card
      title="משמרות לביטול"
      actions={<Badge kind={(data?.reports.length ?? 0) > 0 ? 'warn' : 'ok'}>{data?.reports.length ?? 0}</Badge>}
    >
      <Alert kind="error">{error}</Alert>
      {loading ? (
        <Loading />
      ) : !data || data.reports.length === 0 ? (
        <Empty>לא דווחו משמרות לביטול.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>שם</th>
                <th>יחידה</th>
                <th>פרטי המשמרת</th>
                <th>סוג</th>
                <th>מיקום</th>
                <th>תאריכים</th>
                <th>סטאטוס טיפול</th>
                <th>דווח ע״י</th>
                <th>עודכן</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((report) => (
                <tr key={report.userId}>
                  <td data-label="שם">
                    {report.fullName}
                    <span className="muted small"> · {report.companyId}</span>
                  </td>
                  <td className="muted" data-label="יחידה">{report.unitPath}</td>
                  <td data-label="פרטי המשמרת">{report.details ?? '—'}</td>
                  <td className="muted" data-label="סוג">{report.dutyType ?? '—'}</td>
                  <td className="muted" data-label="מיקום">{report.dutyLocation ?? '—'}</td>
                  <td className="muted" data-label="תאריכים">{report.dutyDates ?? '—'}</td>
                  <td data-label="סטאטוס טיפול">
                    <HandlingStatusCell tripId={tripId} report={report} onSaved={() => void reload()} />
                  </td>
                  <td className="muted" data-label="דווח ע״י">{report.reportedByName}</td>
                  <td className="muted" data-label="עודכן">{formatDateTime(report.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * עריכה מקומית של סטאטוס הטיפול בתורנות - שדה שהאופרטיבי מנהל בעצמו, כדי
 * לתעד מול מי תואם הביטול. שומר רק ל-PATCH הייעודי (לא ל-PUT הרגיל של הדיווח),
 * ולכן לא משפיע על שאר פרטי הדיווח של הר״צ.
 */
function HandlingStatusCell({
  tripId,
  report,
  onSaved,
}: {
  tripId: number;
  report: ShiftReportSummaryEntry;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(report.handlingStatus ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = value !== (report.handlingStatus ?? '');

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/trips/${tripId}/shift-reports/${report.userId}/handling-status`, {
        handlingStatus: value.trim() || null,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="לדוגמה: תואם מול המדור"
        style={{ minWidth: '140px' }}
      />
      {dirty && (
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'שומר...' : 'שמירה'}
        </button>
      )}
    </div>
  );
}

// --- לא שובצתי -----------------------------------------------------------

/**
 * חייל אינו משבץ את עצמו לגלישה - המפקד שלו עושה זאת.
 * לכן במקום טופס הרשמה מוצג הסבר מי אחראי לשבץ אותו.
 */
function NotSignedUpView({ trip }: { trip: Trip }) {
  const user = useCurrentUser();

  return (
    <>
      <Alert kind="info">
        לא שובצת לגלישה הזאת. השיבוץ לגלישה נעשה על ידי המפקדים - חייל אינו משבץ את עצמו.
      </Alert>

      <Card title="מה עושים?">
        <div className="stack">
          <p className="small">
            {user.isManager
              ? 'המפקד שמעליך משבץ אותך. אם קיבלת את משימת השיבוץ בגלישה, אפשר לשבץ את עצמך ואת האנשים שלך במסך שיבוץ האנשים.'
              : `אם אתה צריך להשתתף בגלישה, יש לפנות ל${user.managerName ?? 'מפקד שלך'} כדי שישבץ אותך.`}
          </p>
          {user.managerName && !user.isManager && (
            <div className="stat-grid">
              <Stat value={user.managerName} label="המפקד שלך" />
              <Stat value={trip.cycles.length} label="פעימות יציאה בגלישה" />
            </div>
          )}
          {trip.signingAuthority && (
            <Link to={`/trips/${trip.id}/signing`} className="btn btn--primary">
              מעבר לשיבוץ האנשים שלי
            </Link>
          )}
        </div>
      </Card>

      <Card title="פעימות היציאה">
        <ul className="name-list">
          {trip.cycles.map((cycle) => (
            <li key={cycle.id}>
              <span>
                {cycle.name} · יציאה {formatDate(cycle.exitDate)}
              </span>
              <span className="muted small">{cycle.approvedCount} משובצים</span>
            </li>
          ))}
          {trip.cycles.length === 0 && <li className="muted">לא הוגדרו פעימות יציאה</li>}
        </ul>
      </Card>
    </>
  );
}

// --- שובצתי: השלמת פרטים + סיכום -----------------------------------------

function MyTripView({
  trip,
  summary,
  loading,
  onChanged,
}: {
  trip: Trip;
  summary: TripSummary | null;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const user = useCurrentUser();

  if (loading) return <Loading />;
  if (!summary?.signedUp) return <Alert kind="warn">לא נמצא שיבוץ.</Alert>;

  const signup = trip.mySignup!;
  const editable = trip.state === 'LAUNCHED' && !trip.busesLocked && !trip.dormsLocked;
  const needsCompletion = !signup.dietConfirmed;

  return (
    <>
      {needsCompletion && editable && (
        <Alert kind="warn">
          שובצת לגלישה. נותר להשלים את בחירת השותפים לחדר ואישור העדפת התזונה.
        </Alert>
      )}

      <Card title="סיכום הגלישה שלי">
        <div className="stat-grid">
          <Stat value={summary.cycle?.name ?? '—'} label="פעימת יציאה" />
          <Stat value={formatDate(summary.cycle?.exitDate)} label="תאריך יציאה" />
          <Stat value={DIET_LABEL[signup.diet] ?? '—'} label="תזונה" />
          <Stat value={<StatusBadge status={signup.status} labels={SIGNUP_STATUS_LABEL} />} label="מצב השיבוץ" />
        </div>

        {signup.decisionNote && <Alert kind="warn">הערת המפקד: {signup.decisionNote}</Alert>}
        {signup.status === 'pending' && (
          <Alert kind="warn">
            השיבוץ שלך ממתין לאישור המפקד. עד לאישור לא ייכנס לשיבוצי האוטובוסים והלינה.
          </Alert>
        )}
      </Card>

      {editable && <CompleteDetailsForm trip={trip} onChanged={onChanged} />}
      {editable &&
        (alwaysBringsOwnCar(user.role) ? (
          <OwnCarNotice carPlate={user.carPlate} />
        ) : (
          <CarChoiceCard trip={trip} signup={signup} onChanged={onChanged} />
        ))}

      <div className="grid">
        <Card title="אוטובוס">
          {summary.car && summary.car.status !== 'none' && (
            <Alert kind={summary.car.status === 'approved' ? 'info' : summary.car.status === 'pending' ? 'warn' : 'warn'}>
              {summary.car.status === 'approved' &&
                `מגיע/ה ברכב פרטי${summary.car.passengerName ? ` עם ${summary.car.passengerName}` : ''}.`}
              {summary.car.status === 'pending' && 'בקשת הרכב הפרטי ממתינה לאישור. עד לאישור השיבוץ הוא באוטובוס.'}
              {summary.car.status === 'rejected' &&
                `בקשת הרכב הפרטי נדחתה${summary.car.decisionNote ? `: ${summary.car.decisionNote}` : '.'} השיבוץ הוא באוטובוס.`}
            </Alert>
          )}

          {summary.car?.status === 'approved' ? (
            <p className="muted">אין צורך במקום באוטובוס.</p>
          ) : summary.bus?.published ? (
            summary.bus.number != null ? (
              <div className="center">
                <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>{summary.bus.number}</div>
                <p className="muted">מספר האוטובוס שלך</p>
              </div>
            ) : (
              <Alert kind="warn">לא נמצא שיבוץ לאוטובוס. יש לפנות למפקד.</Alert>
            )
          ) : (
            <p className="muted">שיבוץ האוטובוסים עוד לא פורסם.</p>
          )}
        </Card>

        <Card title="לינה">
          {summary.dorm?.published ? (
            summary.dorm.roomName ? (
              <>
                <p>
                  <strong>{summary.dorm.structureName}</strong> · חדר {summary.dorm.roomName}
                  <span className="muted small"> ({summary.dorm.beds} מיטות)</span>
                </p>
                <strong className="small">שותפים לחדר</strong>
                <ul className="name-list">
                  {(summary.dorm.roommates ?? []).map((mate) => (
                    <li key={mate.id}>{mate.fullName}</li>
                  ))}
                  {(summary.dorm.roommates ?? []).length === 0 && <li className="muted">אין שותפים בחדר</li>}
                </ul>
              </>
            ) : (
              <Alert kind="warn">לא נמצא שיבוץ לחדר. המפקד שלך קיבל התראה לטיפול.</Alert>
            )
          ) : (
            <p className="muted">שיבוץ הלינה עוד לא פורסם.</p>
          )}
        </Card>

        <Card title="העדפות השותפים שביקשתי">
          {(summary.preferences ?? []).length === 0 ? (
            <p className="muted">לא ביקשת שותפים מסוימים.</p>
          ) : (
            <ul className="pref-list">
              {(summary.preferences ?? []).map((preference) => (
                <li key={preference.id} className="pref-item">
                  <span>
                    <Badge>{preference.priority}</Badge> {preference.fullName}
                  </span>
                  {summary.dorm?.published ? (
                    preference.gotIt ? (
                      <Badge kind="ok">התקיים</Badge>
                    ) : (
                      <Badge kind="danger">לא התקיים</Badge>
                    )
                  ) : (
                    <Badge>ממתין לשיבוץ</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * השלמת הפרטים שהמשתמש עצמו אחראי עליהם: שותפים לחדר ואישור תזונה.
 * אין כאן אפשרות להסיר את עצמו מהגלישה - זו פעולה של המפקד.
 */
function CompleteDetailsForm({ trip, onChanged }: { trip: Trip; onChanged: () => Promise<void> }) {
  const user = useCurrentUser();
  const signup = trip.mySignup!;

  const [diet, setDiet] = useState<Diet>(signup.diet);
  const [dietConfirmed, setDietConfirmed] = useState(signup.dietConfirmed);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const mySignupData = useApi<{ signup: { preferences: Array<{ id: number }> } | null }>(
    `/trips/${trip.id}/my-signup`,
  );
  const candidates = useApi<{ candidates: RoommateCandidate[]; note?: string }>(
    `/trips/${trip.id}/roommate-candidates?cycleId=${signup.cycleId}`,
  );

  const [selected, setSelected] = useState<number[] | null>(null);
  const current = selected ?? (mySignupData.data?.signup?.preferences ?? []).map((entry) => entry.id);

  const byId = useMemo(
    () => new Map((candidates.data?.candidates ?? []).map((candidate) => [candidate.id, candidate])),
    [candidates.data],
  );

  const filtered = useMemo(() => {
    const list = candidates.data?.candidates ?? [];
    const term = search.trim();
    if (!term) return list;
    return list.filter((candidate) => candidate.fullName.includes(term) || candidate.unitPath.includes(term));
  }, [candidates.data, search]);

  const toggle = (id: number) => {
    const next = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : current.length >= MAX_PREFERENCES
        ? current
        : [...current, id];
    setSelected(next);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!dietConfirmed) {
      setError('חובה לאשר את העדפת התזונה');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/trips/${trip.id}/my-signup`, {
        diet,
        dietConfirmed: true,
        preferences: current,
      });
      setMessage('הפרטים נשמרו.');
      setSelected(null);
      await Promise.all([onChanged(), mySignupData.reload()]);
    } catch (caught) {
      setError(errorMessage(caught, 'השמירה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      <Card title="אישור העדפת תזונה">
        <div className="field-row">
          <Field label="העדפת התזונה שלי לגלישה">
            <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
              {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
                <option key={option} value={option}>
                  {DIET_LABEL[option]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={dietConfirmed}
            onChange={(event) => setDietConfirmed(event.target.checked)}
          />
          <span>
            אני מאשר שהעדפת התזונה שלי לגלישה היא <strong>{DIET_LABEL[diet]}</strong>. ההזמנה מהספק מבוססת על
            האישור הזה.
          </span>
        </label>
      </Card>

      <Card
        title={`בחירת שותפים לחדר (עד ${MAX_PREFERENCES})`}
        actions={
          <Badge kind={current.length > 0 ? 'ok' : 'default'}>
            {current.length}/{MAX_PREFERENCES}
          </Badge>
        }
      >
        <Alert kind="info">
          {user.rankGroup === 'soldier'
            ? 'ניתן לבחור חיילים מאותו מין בלבד.'
            : 'ניתן לבחור בני אותו דרג ניהולי בדיוק, מאותו מין - כל דרג ישן רק עם עצמו.'}
        </Alert>

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
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="שם או יחידה" />
        </Field>

        {candidates.loading && <Loading label="טוען מועמדים..." />}
        {candidates.data?.note && <Alert kind="warn">{candidates.data.note}</Alert>}
        {!candidates.loading && filtered.length === 0 && <p className="muted">לא נמצאו מועמדים מתאימים.</p>}

        <div className="table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th />
                <th>שם</th>
                <th>יחידה</th>
                <th>שובץ לגלישה</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((candidate) => (
                <tr key={candidate.id}>
                  <td data-label="בחירה">
                    <input
                      type="checkbox"
                      checked={current.includes(candidate.id)}
                      disabled={!current.includes(candidate.id) && current.length >= MAX_PREFERENCES}
                      onChange={() => toggle(candidate.id)}
                      aria-label={`בחר את ${candidate.fullName}`}
                    />
                  </td>
                  <td data-label="שם">{candidate.fullName}</td>
                  <td className="muted" data-label="יחידה">{candidate.unitPath}</td>
                  <td data-label="שובץ לגלישה">
                    {candidate.signedUpForCycle ? <Badge kind="ok">כן</Badge> : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? 'שומר...' : 'שמירת הפרטים'}
      </button>
    </form>
  );
}

/**
 * רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - אין כאן בקשה לכל גלישה, רק
 * תזכורת שאין צורך במקום באוטובוס, ועדכון מספר הרכב מפנה לפרופיל.
 */
function OwnCarNotice({ carPlate }: { carPlate: string | null }) {
  return (
    <Card title="אופן ההגעה">
      <p>
        מגיע/ה ברכב פרטי - אין צורך במקום באוטובוס.
        {carPlate ? ` מספר הרכב: ${carPlate}.` : ' מספר הרכב טרם עודכן.'}
      </p>
      <Link to="/profile" className="btn btn--sm">
        עדכון מספר הרכב בפרופיל
      </Link>
    </Card>
  );
}

/**
 * בחירת אופן ההגעה - אוטובוס או רכב פרטי.
 * ההעדפה היא שכמה שיותר אנשים יגיעו באוטובוס, ולכן בקשת רכב תמיד ממתינה
 * לאישור הרת״ח הקרוב בשרשרת הפיקוד (או האופרטיבי אם אין רת״ח מעליו). ברכב
 * יכול להצטרף נוסע אחד נוסף שגם הוא רשום לאותה פעימה. רת״ח ומפמ״ר לא רואים
 * את הכרטיס הזה כלל - ראו OwnCarNotice.
 */
function CarChoiceCard({
  trip,
  signup,
  onChanged,
}: {
  trip: Trip;
  signup: NonNullable<Trip['mySignup']>;
  onChanged: () => Promise<void>;
}) {
  const [wantsCar, setWantsCar] = useState(signup.carStatus !== 'none' && signup.carStatus !== 'rejected');
  const [passengerId, setPassengerId] = useState<number | null>(signup.carPassenger?.id ?? null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = useApi<{ candidates: CarPassengerCandidate[] }>(
    wantsCar ? `/trips/${trip.id}/car-passenger-candidates?cycleId=${signup.cycleId}` : null,
  );

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await api.patch<{ signup: Signup }>(`/trips/${trip.id}/my-signup`, {
        wantsCar,
        carPassengerId: wantsCar ? passengerId : null,
      });
      setMessage(!wantsCar ? 'עודכן לנסיעה באוטובוס.' : 'בקשת הרכב הפרטי נשלחה וממתינה לאישור.');
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, 'השמירה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="אופן ההגעה">
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      {signup.carStatus !== 'none' && (
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          <Badge kind={signup.carStatus === 'approved' ? 'ok' : signup.carStatus === 'pending' ? 'warn' : 'danger'}>
            {CAR_STATUS_LABEL[signup.carStatus]}
          </Badge>
          {signup.carPassenger && <span className="muted small">נוסע: {signup.carPassenger.fullName}</span>}
        </div>
      )}
      {signup.carDecisionNote && <Alert kind="warn">הערת המפקד: {signup.carDecisionNote}</Alert>}

      <form onSubmit={save}>
        <label className="checkbox">
          <input type="checkbox" checked={wantsCar} onChange={(event) => setWantsCar(event.target.checked)} />
          <span>אני מגיע/ה ברכב פרטי ולא באוטובוס (טעון אישור רת״ח)</span>
        </label>

        {wantsCar && (
          <Field label="נוסע נוסף ברכב (עד אחד, לא חובה)">
            <select
              value={passengerId ?? ''}
              onChange={(event) => setPassengerId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">ללא נוסע</option>
              {(candidates.data?.candidates ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.fullName} · {candidate.unitPath}
                </option>
              ))}
            </select>
          </Field>
        )}

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'שומר...' : 'שמירה'}
        </button>
      </form>
    </Card>
  );
}
