import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  type ApprovalRow,
  type CarRequest,
  type MoveRequest,
  type PendingRegistration,
  type ProfileEditRequest,
  type Trip,
} from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import {
  DIET_LABEL,
  formatDate,
  GENDER_LABEL_SINGULAR,
  ROLE_LABEL,
  SIGNUP_STATUS_LABEL,
} from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Loading, StatusBadge } from '../components/ui';

/**
 * מסך האישורים של המפקד: בקשות רישום למערכת ובקשות הרשמה לגלישות.
 * כשמגיעים דרך גלישה מסוים מוצגות רק הבקשות של אותו גלישה.
 */
export function ApprovalsPage() {
  const { tripId } = useParams();
  const { user } = useAuth();
  const registrations = useApi<{ pending: PendingRegistration[] }>('/users/pending');
  const profileEdits = useApi<{ pending: ProfileEditRequest[] }>('/users/profile-edits/pending');
  const moves = useApi<{ pending: MoveRequest[] }>('/users/moves/pending');
  const trips = useApi<{ trips: Trip[] }>(tripId ? null : '/trips');
  const singleTrip = useApi<{ trip: Trip }>(tripId ? `/trips/${tripId}` : null);

  const tripList = tripId
    ? singleTrip.data
      ? [singleTrip.data.trip]
      : []
    : (trips.data?.trips ?? []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>אישורים</h1>
          <p>בקשות שממתינות לאישורך</p>
        </div>
        {tripId && <BackToTrip tripId={tripId} />}
      </div>

      <Alert kind="error">{registrations.error}</Alert>

      <Card
        title="בקשות רישום למערכת"
        actions={<Badge kind={(registrations.data?.pending.length ?? 0) > 0 ? 'warn' : 'ok'}>
          {registrations.data?.pending.length ?? 0}
        </Badge>}
      >
        {registrations.loading ? (
          <Loading />
        ) : (registrations.data?.pending.length ?? 0) === 0 ? (
          <Empty>אין בקשות רישום שממתינות לאישור.</Empty>
        ) : (
          <RegistrationTable
            rows={registrations.data!.pending}
            onChanged={() => void registrations.reload()}
            showIndirectBadge={!user?.isTripOrganizer}
          />
        )}
      </Card>

      <Alert kind="error">{profileEdits.error}</Alert>

      <Card
        title="בקשות עדכון פרופיל"
        actions={
          <Badge kind={(profileEdits.data?.pending.length ?? 0) > 0 ? 'warn' : 'ok'}>
            {profileEdits.data?.pending.length ?? 0}
          </Badge>
        }
      >
        {profileEdits.loading ? (
          <Loading />
        ) : (profileEdits.data?.pending.length ?? 0) === 0 ? (
          <Empty>אין בקשות עדכון פרופיל שממתינות לאישור.</Empty>
        ) : (
          <ProfileEditTable rows={profileEdits.data!.pending} onChanged={() => void profileEdits.reload()} />
        )}
      </Card>

      <Alert kind="error">{moves.error}</Alert>

      <Card
        title="בקשות העברה"
        actions={
          <Badge kind={(moves.data?.pending.length ?? 0) > 0 ? 'warn' : 'ok'}>
            {moves.data?.pending.length ?? 0}
          </Badge>
        }
      >
        {moves.loading ? (
          <Loading />
        ) : (moves.data?.pending.length ?? 0) === 0 ? (
          <Empty>אין בקשות העברה שממתינות לאישור.</Empty>
        ) : (
          <MoveRequestTable rows={moves.data!.pending} onChanged={() => void moves.reload()} />
        )}
      </Card>

      {(tripId ? singleTrip.loading : trips.loading) ? (
        <Loading />
      ) : (
        tripList.map((trip) => (
          <div key={trip.id} className="stack">
            <TripApprovals trip={trip} />
            <TripCarRequests trip={trip} />
          </div>
        ))
      )}

      {tripList.length === 0 && !trips.loading && !singleTrip.loading && (
        <Empty>אין גלישות פעילות.</Empty>
      )}
    </>
  );
}

function RegistrationTable({
  rows,
  onChanged,
  showIndirectBadge,
}: {
  rows: PendingRegistration[];
  onChanged: () => void;
  showIndirectBadge: boolean;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const decide = async (userId: number, decision: 'approve' | 'reject') => {
    setError('');
    setBusyId(userId);
    try {
      const note =
        decision === 'reject' ? (window.prompt('סיבת הדחייה (לא חובה):') ?? undefined) : undefined;
      await api.post(`/users/${userId}/${decision}`, note ? { note } : {});
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>שם</th>
              <th>מספר אישי</th>
              <th>תפקיד</th>
              <th>מין</th>
              <th>תזונה</th>
              <th>מפקד</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="שם">
                  {row.fullName}
                  {showIndirectBadge && !row.isDirectReport && (
                    <span className="muted small"> (כפיף עקיף)</span>
                  )}
                </td>
                <td data-label="מספר אישי">{row.companyId}</td>
                <td data-label="תפקיד">
                  {ROLE_LABEL[row.role]}
                  {row.unitName ? ` · ${row.unitName}` : ''}
                </td>
                <td data-label="מין">{GENDER_LABEL_SINGULAR[row.gender]}</td>
                <td data-label="תזונה">{DIET_LABEL[row.diet]}</td>
                <td className="muted" data-label="מפקד">{row.managerName ?? '—'}</td>
                <td data-label="פעולות">
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'approve')}
                    >
                      אישור
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'reject')}
                    >
                      דחייה
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** מציג רק את השדות שהשתנו בין הערכים הנוכחיים למוצעים, כדי שהמפקד יראה את השינוי בלבד. */
function ProfileEditDiff({ row }: { row: ProfileEditRequest }) {
  const fields: Array<{ label: string; current: string; proposed: string }> = [
    {
      label: 'שם',
      current: `${row.current.firstName} ${row.current.lastName}`,
      proposed: `${row.proposed.firstName} ${row.proposed.lastName}`,
    },
    {
      label: 'מין',
      current: GENDER_LABEL_SINGULAR[row.current.gender] ?? row.current.gender,
      proposed: GENDER_LABEL_SINGULAR[row.proposed.gender] ?? row.proposed.gender,
    },
    {
      label: 'תזונה',
      current: DIET_LABEL[row.current.diet] ?? row.current.diet,
      proposed: DIET_LABEL[row.proposed.diet] ?? row.proposed.diet,
    },
    { label: 'יחידה', current: row.current.unitName ?? '—', proposed: row.proposed.unitName ?? '—' },
  ].filter((field) => field.current !== field.proposed);

  if (fields.length === 0) return <span className="muted">—</span>;

  return (
    <div className="stack" style={{ gap: '0.15rem' }}>
      {fields.map((field) => (
        <div key={field.label} className="small">
          <span className="muted">{field.label}: </span>
          <span>{field.current}</span> <span className="muted">→</span> <strong>{field.proposed}</strong>
        </div>
      ))}
    </div>
  );
}

function ProfileEditTable({ rows, onChanged }: { rows: ProfileEditRequest[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const decide = async (editId: number, decision: 'approve' | 'reject') => {
    setError('');
    setBusyId(editId);
    try {
      const note = decision === 'reject' ? (window.prompt('סיבת הדחייה (לא חובה):') ?? undefined) : undefined;
      await api.post(`/users/profile-edits/${editId}/${decision}`, note ? { note } : {});
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>שם</th>
              <th>מספר אישי</th>
              <th>שינוי מבוקש</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="שם">{row.userFullName}</td>
                <td data-label="מספר אישי">{row.companyId}</td>
                <td data-label="שינוי מבוקש">
                  <ProfileEditDiff row={row} />
                </td>
                <td data-label="פעולות">
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'approve')}
                    >
                      אישור
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'reject')}
                    >
                      דחייה
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MoveRequestTable({ rows, onChanged }: { rows: MoveRequest[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const decide = async (moveId: number, decision: 'approve' | 'reject') => {
    setError('');
    setBusyId(moveId);
    try {
      const note = decision === 'reject' ? (window.prompt('סיבת הדחייה (לא חובה):') ?? undefined) : undefined;
      await api.post(`/users/moves/${moveId}/${decision}`, note ? { note } : {});
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>מי מועבר</th>
              <th>מפקד יעד</th>
              <th>ממלא מקום</th>
              <th>ביקש</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="מי מועבר">
                  {row.user.fullName}
                  <span className="muted small"> · {row.user.companyId}</span>
                </td>
                <td data-label="מפקד יעד">
                  {row.toManager.fullName}
                  {row.toManager.unitName ? <span className="muted small"> · {row.toManager.unitName}</span> : null}
                </td>
                <td data-label="ממלא מקום">
                  {row.successor ? (
                    <>
                      {row.successor.fullName}
                      <span className="muted small"> · {row.successor.companyId}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted" data-label="ביקש">{row.requestedBy.fullName}</td>
                <td data-label="פעולות">
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'approve')}
                    >
                      אישור
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row.id, 'reject')}
                    >
                      דחייה
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TripApprovals({ trip }: { trip: Trip }) {
  const { data, loading, error, reload } = useApi<{ signups: ApprovalRow[] }>(`/trips/${trip.id}/approvals`);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  const decide = async (signupId: number, decision: 'approve' | 'reject') => {
    setActionError('');
    setBusyId(signupId);
    try {
      const note =
        decision === 'reject' ? (window.prompt('סיבת הדחייה (לא חובה):') ?? undefined) : undefined;
      await api.post(`/trips/${trip.id}/signups/${signupId}/${decision}`, note ? { note } : {});
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const rows = data?.signups ?? [];
  const pending = rows.filter((row) => row.status === 'pending');
  const locked = trip.busesLocked || trip.dormsLocked;

  const approveAll = async () => {
    setActionError('');
    for (const row of pending) {
      try {
        await api.post(`/trips/${trip.id}/signups/${row.id}/approve`, {});
      } catch (caught) {
        setActionError(errorMessage(caught));
        break;
      }
    }
    await reload();
  };

  return (
    <Card
      title={`בקשות הרשמה · ${trip.name}`}
      actions={
        <>
          <Badge kind={pending.length > 0 ? 'warn' : 'ok'}>{pending.length} ממתינות</Badge>
          {pending.length > 0 && !locked && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void approveAll()}>
              אישור הכל
            </button>
          )}
        </>
      }
    >
      <Alert kind="error">{error || actionError}</Alert>
      {locked && <Alert kind="warn">השיבוצים של הגלישה נעולים - אי אפשר לשנות אישורים.</Alert>}

      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>אין בקשות הרשמה מהאנשים שלך לגלישה הזאת.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>שם</th>
                <th>יחידה</th>
                <th>פעימה</th>
                <th>תזונה</th>
                <th>שותפים שביקש</th>
                <th>מצב</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="שם">
                    {row.user.fullName}
                    <span className="muted small"> · {row.user.companyId}</span>
                  </td>
                  <td className="muted" data-label="יחידה">{row.user.unitPath}</td>
                  <td data-label="פעימה">
                    {row.cycle.name}
                    <span className="muted small"> · {formatDate(row.cycle.exitDate)}</span>
                  </td>
                  <td data-label="תזונה">{DIET_LABEL[row.diet]}</td>
                  <td data-label="שותפים שביקש">
                    {row.preferences.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      row.preferences.map((preference) => preference.fullName).join(', ')
                    )}
                  </td>
                  <td data-label="מצב">
                    <StatusBadge status={row.status} labels={SIGNUP_STATUS_LABEL} />
                  </td>
                  <td data-label="פעולות">
                    {row.status === 'pending' && !locked ? (
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={busyId === row.id}
                          onClick={() => void decide(row.id, 'approve')}
                        >
                          אישור
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busyId === row.id}
                          onClick={() => void decide(row.id, 'reject')}
                        >
                          דחייה
                        </button>
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
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
 * בקשות רכב פרטי שממתינות לאישור המשתמש המחובר בגלישה הזאת - רת״ח בשרשרת
 * הפיקוד של המבקש, או האופרטיבי לכל הבקשות.
 */
function TripCarRequests({ trip }: { trip: Trip }) {
  const { data, loading, error, reload } = useApi<{ requests: CarRequest[] }>(`/trips/${trip.id}/car-requests`);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  const decide = async (signupId: number, decision: 'approve' | 'reject') => {
    setActionError('');
    setBusyId(signupId);
    try {
      const note = decision === 'reject' ? (window.prompt('סיבת הדחייה (לא חובה):') ?? undefined) : undefined;
      await api.post(`/trips/${trip.id}/car-requests/${signupId}/${decision}`, note ? { note } : {});
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const rows = data?.requests ?? [];
  if (!loading && rows.length === 0 && !error) return null;

  return (
    <Card
      title={`בקשות רכב פרטי · ${trip.name}`}
      actions={<Badge kind={rows.length > 0 ? 'warn' : 'ok'}>{rows.length} ממתינות</Badge>}
    >
      <Alert kind="error">{error || actionError}</Alert>

      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>אין בקשות רכב פרטי שממתינות לאישור.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>שם</th>
                <th>יחידה</th>
                <th>פעימה</th>
                <th>מספר רכב</th>
                <th>נוסע</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="שם">
                    {row.user.fullName}
                    <span className="muted small"> · {row.user.companyId}</span>
                  </td>
                  <td className="muted" data-label="יחידה">{row.user.unitPath}</td>
                  <td data-label="פעימה">
                    {row.cycle.name}
                    <span className="muted small"> · {formatDate(row.cycle.exitDate)}</span>
                  </td>
                  <td data-label="מספר רכב">{row.user.carPlate ?? <span className="muted">לא הוזן</span>}</td>
                  <td data-label="נוסע">{row.carPassenger ? row.carPassenger.fullName : <span className="muted">—</span>}</td>
                  <td data-label="פעולות">
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={busyId === row.id}
                        onClick={() => void decide(row.id, 'approve')}
                      >
                        אישור
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={busyId === row.id}
                        onClick={() => void decide(row.id, 'reject')}
                      >
                        דחייה
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
  );
}
