import { Link, Navigate } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { useCurrentUser } from '../lib/auth';
import type { Trip } from '../lib/api';
import { formatDate, SIGNUP_STATUS_LABEL, TRIP_STATE_LABEL } from '../lib/he';
import { Alert, Badge, Card, Empty, Loading, StatusBadge } from '../components/ui';

export function HomePage() {
  const user = useCurrentUser();
  const { data, loading, error } = useApi<{ trips: Trip[] }>('/trips');

  // לאופרטיבי יש כבר "ניהול גלישות" - לא צריך שתי לשוניות גלישות נפרדות.
  if (user.isTripOrganizer) return <Navigate to="/manage" replace />;

  if (loading) return <Loading />;

  const trips = data?.trips ?? [];
  const openTrips = trips;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>שלום {user.firstName}</h1>
          <p>
            {[user.divisionName, user.sectorName, user.teamName].filter(Boolean).join(' / ') ||
              'לא נמצא שיוך ארגוני'}
          </p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {openTrips.length === 0 && <Empty>אין כרגע גלישות פתוחות להרשמה.</Empty>}

      <div className="grid grid--wide">
        {openTrips.map((trip) => {
          const signup = trip.mySignup;
          return (
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
                  <strong className="small">פעימות יציאה</strong>
                  <ul className="name-list">
                    {trip.cycles.map((cycle) => (
                      <li key={cycle.id}>
                        <span>
                          {cycle.name} · {formatDate(cycle.exitDate)}
                        </span>
                        {signup?.cycleId === cycle.id && <Badge kind="ok">שובצת</Badge>}
                      </li>
                    ))}
                  </ul>
                </div>

                {signup ? (
                  <div className="row row--between">
                    <span className="small">
                      מצב השיבוץ: <StatusBadge status={signup.status} labels={SIGNUP_STATUS_LABEL} />
                      {!signup.dietConfirmed && <Badge kind="warn">נדרשת השלמת פרטים</Badge>}
                    </span>
                    <Link to={`/trips/${trip.id}`} className="btn btn--sm">
                      סיכום הגלישה
                    </Link>
                  </div>
                ) : (
                  <div className="stack">
                    <span className="small muted">
                      לא שובצת לגלישה. השיבוץ נעשה על ידי המפקדים.
                    </span>
                    <div className="row">
                      <Link to={`/trips/${trip.id}`} className="btn btn--sm">
                        צפייה בפרטים
                      </Link>
                      {trip.signingAuthority && (
                        <Link to={`/trips/${trip.id}/signing`} className="btn btn--sm btn--primary">
                          שיבוץ האנשים שלי
                        </Link>
                      )}
                    </div>
                  </div>
                )}

                {(trip.busesLocked || trip.dormsLocked) && (
                  <div className="row small">
                    {trip.busesLocked && <Badge kind="info">אוטובוסים פורסמו</Badge>}
                    {trip.dormsLocked && <Badge kind="info">לינה פורסמה</Badge>}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
