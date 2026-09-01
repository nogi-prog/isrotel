import { useParams } from 'react-router-dom';
import type { BusListResponse } from '../lib/api';
import { useApi } from '../lib/useApi';
import { DIET_LABEL, formatDate, GENDER_LABEL_SINGULAR } from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Loading, Stat } from '../components/ui';
import { CarsCard } from '../components/CarsCard';

/**
 * רשימת שיבוץ האוטובוסים.
 * אופרטיבי רואה את הרשימה המלאה, מפקד רק את האנשים שלו - הסינון נעשה בשרת.
 */
export function BusesPage() {
  const { tripId } = useParams();
  const { data, loading, error } = useApi<BusListResponse>(tripId ? `/trips/${tripId}/buses` : null);

  if (loading) return <Loading />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  if (!data.locked) {
    return (
      <>
        <div className="page-head">
          <h1>שיבוץ אוטובוסים</h1>
          {tripId && <BackToTrip tripId={tripId} />}
        </div>
        <Alert kind="warn">שיבוץ האוטובוסים עוד לא נעול ופורסם על ידי האופרטיבי.</Alert>
        <CarsCard cars={data.cars} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>שיבוץ אוטובוסים</h1>
          <p>
            קיבולת אוטובוס: {data.capacity} · פורסם ב־{formatDate(data.lockedAt)}
            {data.scope === 'my-people' && ' · מוצגים רק האנשים שלך'}
          </p>
        </div>
        <div className="row">
          {tripId && <BackToTrip tripId={tripId} />}
          <button type="button" className="btn btn--sm" onClick={() => window.print()}>
            הדפסה
          </button>
        </div>
      </div>

      {data.cycles.length === 0 && <Empty>אין שיבוצים להצגה.</Empty>}

      {data.cycles.map((cycle) => {
        const shown = cycle.buses.reduce((sum, bus) => sum + bus.count, 0);
        return (
          <Card
            key={cycle.cycleId}
            title={`${cycle.cycleName} · יציאה ${formatDate(cycle.exitDate)}`}
            actions={
              <>
                <Badge kind="info">{cycle.buses.length} אוטובוסים</Badge>
                <Badge>{cycle.totalParticipants} באוטובוס</Badge>
                {cycle.carCount > 0 && <Badge kind="ok">{cycle.carCount} ברכב פרטי</Badge>}
              </>
            }
          >
            {data.scope === 'my-people' && (
              <div className="stat-grid" style={{ marginBottom: '1rem' }}>
                <Stat value={shown} label="אנשים שלך באוטובוס" />
                <Stat value={cycle.buses.length} label="אוטובוסים שבהם הם משובצים" />
                <Stat value={cycle.carCount} label="אנשים שלך ברכב פרטי" />
              </div>
            )}

            <div className="grid">
              {cycle.buses.map((bus) => (
                <div key={bus.number} className="bus-card">
                  <div className="bus-card__head">
                    <span className="bus-card__title">אוטובוס {bus.number}</span>
                    <Badge kind={data.capacity && bus.count > data.capacity ? 'danger' : 'ok'}>
                      {bus.count}
                      {data.scope === 'all' && data.capacity ? ` / ${data.capacity}` : ''}
                    </Badge>
                  </div>
                  <ul className="name-list">
                    {bus.members.map((member) => (
                      <li key={member.userId}>
                        <span>{member.fullName}</span>
                        <span className="muted small">
                          {GENDER_LABEL_SINGULAR[member.gender]}
                          {member.diet !== 'all' ? ` · ${DIET_LABEL[member.diet]}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {cycle.buses.length === 0 && <Empty>אין אנשים שלך בפעימה הזו.</Empty>}
          </Card>
        );
      })}

      <CarsCard cars={data.cars} />
    </>
  );
}
