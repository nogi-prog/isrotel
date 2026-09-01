import { Link, useParams } from 'react-router-dom';
import type { DormListResponse } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatDate, GENDER_LABEL, ROLE_LABEL } from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Loading, Stat } from '../components/ui';

/**
 * רשימת שיבוץ הלינה.
 * אופרטיבי רואה את כל החדרים, מפקד רק חדרים שיש בהם אנשים שלו.
 */
export function DormsPage() {
  const { tripId } = useParams();
  const { data, loading, error } = useApi<DormListResponse>(tripId ? `/trips/${tripId}/dorms` : null);

  if (loading) return <Loading />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  if (!data.locked) {
    return (
      <>
        <div className="page-head">
          <h1>שיבוץ לינה</h1>
          {tripId && <BackToTrip tripId={tripId} />}
        </div>
        <Alert kind="warn">שיבוץ הלינה עוד לא נעול ופורסם על ידי האופרטיבי.</Alert>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>שיבוץ לינה</h1>
          <p>
            פורסם ב־{formatDate(data.lockedAt)}
            {data.scope === 'my-people' && ' · מוצגים רק חדרים עם אנשים שלך'}
          </p>
        </div>
        <div className="row">
          {tripId && <BackToTrip tripId={tripId} />}
          <Link to={`/trips/${tripId}/dorm-issues`} className="btn btn--sm">
            בעיות שיבוץ
          </Link>
          <button type="button" className="btn btn--sm" onClick={() => window.print()}>
            הדפסה
          </button>
        </div>
      </div>

      {data.cycles.length === 0 && <Empty>אין שיבוצים להצגה.</Empty>}

      {data.cycles.map((cycle) => {
        const totalBeds = cycle.rooms.reduce((sum, room) => sum + room.beds, 0);
        const occupied = cycle.rooms.reduce((sum, room) => sum + room.totalOccupancy, 0);

        return (
          <Card key={cycle.cycleId} title={`${cycle.cycleName} · יציאה ${formatDate(cycle.exitDate)}`}>
            <div className="stat-grid" style={{ marginBottom: '1rem' }}>
              <Stat value={cycle.rooms.length} label="חדרים" />
              <Stat value={occupied} label="מיטות מאוכלסות" />
              <Stat value={totalBeds - occupied} label="מיטות פנויות" />
            </div>

            <div className="grid">
              {cycle.rooms.map((room) => (
                <div key={room.roomId} className="room-card">
                  <div className="room-card__head">
                    <span className="room-card__title">
                      {room.structureName} · חדר {room.roomName}
                    </span>
                    <div className="row">
                      <Badge kind={room.gender === 'male' ? 'info' : 'warn'}>{GENDER_LABEL[room.gender]}</Badge>
                      <Badge kind={room.freeBeds === 0 ? 'ok' : 'default'}>
                        {room.totalOccupancy}/{room.beds}
                      </Badge>
                    </div>
                  </div>
                  <ul className="name-list">
                    {room.members.map((member) => (
                      <li key={member.userId}>
                        <span>{member.fullName}</span>
                        <span className="muted small">{ROLE_LABEL[member.role]}</span>
                      </li>
                    ))}
                  </ul>
                  {room.members.length < room.totalOccupancy && (
                    <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                      + {room.totalOccupancy - room.members.length} שוכנים שאינם באחריותך
                    </p>
                  )}
                </div>
              ))}
            </div>

            {cycle.rooms.length === 0 && <Empty>אין חדרים עם אנשים שלך בפעימה הזו.</Empty>}
          </Card>
        );
      })}
    </>
  );
}
