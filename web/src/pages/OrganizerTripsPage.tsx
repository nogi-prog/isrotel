import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DeleteTripResponse, type Trip } from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import { formatDate, plural, ROLE_LABEL, TRIP_STATE_LABEL, TRIP_SUBMISSION_LABEL } from '../lib/he';
import { Alert, Badge, Card, Empty, Loading } from '../components/ui';

/** מסך הבית של האופרטיבי: כל הגלישות. יצירת גלישה חדשה היא במסך נפרד. */
export function OrganizerTripsPage() {
  const { data, loading, error, reload } = useApi<{ trips: Trip[] }>('/trips');
  const [message, setMessage] = useState('');

  if (loading) return <Loading />;

  const trips = data?.trips ?? [];

  const afterDelete = async (text: string) => {
    setMessage(text);
    await reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ניהול גלישות</h1>
          <p>פרסום גלישות, פעימות יציאה, מבני לינה ושיבוצים</p>
        </div>
        <Link to="/manage/new" className="btn btn--primary">
          גלישה חדשה
        </Link>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{message}</Alert>

      {trips.length === 0 && <Empty>לא נוצרו גלישות.</Empty>}

      <div className="grid grid--wide">
        {trips.map((trip) => (
          <Card
            key={trip.id}
            defaultCollapsed
            className="card--trip"
            title={
              <div>
                <h2>{trip.name}</h2>
                <div className="row small muted">
                  <span>פורסם {formatDate(trip.launchDate)}</span>
                  <Badge kind={trip.state === 'LAUNCHED' ? 'ok' : 'default'}>
                    {TRIP_STATE_LABEL[trip.state] ?? trip.state}
                  </Badge>
                </div>
              </div>
            }
          >
            <div className="stack">
              <div>
                <strong className="small">מפקדים שקיבלו את משימת השיבוץ ({trip.leaders.length})</strong>
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
                      {leader.hasDelegated && <Badge kind="info">האציל לר״צים</Badge>}
                    </li>
                  ))}
                  {trip.leaders.length === 0 && <li className="muted">לא הוגדרו מפקדים</li>}
                </ul>
              </div>

              <div>
                <strong className="small">פעימות יציאה</strong>
                <ul className="name-list">
                  {trip.cycles.map((cycle) => (
                    <li key={cycle.id}>
                      <span>
                        {cycle.name} · {formatDate(cycle.exitDate)}
                      </span>
                      <span className="muted small">
                        {cycle.approvedCount} שובצו
                        {cycle.pendingCount > 0 ? ` · ${cycle.pendingCount} ממתינים` : ''}
                      </span>
                    </li>
                  ))}
                  {trip.cycles.length === 0 && <li className="muted">לא הוגדרו פעימות יציאה</li>}
                </ul>
              </div>

              <div className="row">
                {trip.leadersNotified ? (
                  <Badge kind="ok">הודעה נשלחה למפקדים</Badge>
                ) : (
                  <Badge kind="warn">טרם נשלחה הודעה</Badge>
                )}
                {trip.submitted ? (
                  <Badge kind="ok">{TRIP_SUBMISSION_LABEL.submitted}</Badge>
                ) : (
                  <Badge kind="warn">{TRIP_SUBMISSION_LABEL.open}</Badge>
                )}
                {trip.busesLocked ? <Badge kind="ok">אוטובוסים נעולים</Badge> : <Badge>אוטובוסים פתוחים</Badge>}
                {trip.dormsLocked ? <Badge kind="ok">לינה נעולה</Badge> : <Badge>לינה פתוחה</Badge>}
              </div>

              <Link to={`/manage/${trip.id}`} className="btn btn--primary btn--block">
                ניהול הגלישה
              </Link>

              <DeleteTripControl trip={trip} onDeleted={afterDelete} />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

/**
 * מחיקת גלישה - פעולה הרסנית ובלתי הפיכה, ולכן היא בשני שלבים: לחיצה על "מחיקה"
 * פותחת אישור שמפרט מה יימחק (משובצים ופעימות), ורק הלחיצה השנייה מוחקת.
 */
function DeleteTripControl({
  trip,
  onDeleted,
}: {
  trip: Trip;
  onDeleted: (message: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // סך המשובצים בגלישה: המאושרים והממתינים בכל הפעימות.
  const signedUp = trip.cycles.reduce((sum, cycle) => sum + cycle.approvedCount + cycle.pendingCount, 0);

  const remove = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await api.delete<DeleteTripResponse>(`/trips/${trip.id}`);
      const { signups, cycles, structures, notifications } = result.deleted;
      await onDeleted(
        `${trip.name} נמחקה לצמיתות: ${plural(signups, 'שיבוץ', 'שיבוצים')}, ` +
          `${plural(cycles, 'פעימה', 'פעימות', 'female')}, ${plural(structures, 'מבנה לינה', 'מבני לינה')} ו־` +
          `${plural(notifications, 'התראה', 'התראות', 'female')}.`,
      );
    } catch (caught) {
      setError(errorMessage(caught, 'מחיקת הגלישה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <>
        <Alert kind="error">{error}</Alert>
        <div className="row">
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirming(true)}>
            מחיקה
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <div className="stack">
        <span className="small">
          לאישור: מחיקת {trip.name} · {plural(signedUp, 'משובץ', 'משובצים')} ·{' '}
          {plural(trip.cycles.length, 'פעימה', 'פעימות', 'female')}
          <span className="muted"> — הפעולה אינה הפיכה.</span>
        </span>
        <div className="row">
          <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'מוחק...' : 'מחיקה לצמיתות'}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setError('');
            }}
          >
            ביטול
          </button>
        </div>
      </div>
    </>
  );
}
