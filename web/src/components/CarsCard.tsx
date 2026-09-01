import type { CarTravelers } from '../lib/api';
import { formatDate } from '../lib/he';
import { Badge, Card, Empty } from './ui';

/**
 * טבלת כל הרכבים הפרטיים בגלישה - נהג, מספר רכב ונוסע, לכל פעימה. משותפת
 * לעמוד הגלישה (TripPage) ולעמוד האוטובוסים (BusesPage), ששניהם מקבלים
 * את אותו `cars` מ-GET /trips/:id/buses.
 */
export function CarsCard({ cars }: { cars: CarTravelers | undefined }) {
  const rows = cars?.cycles.flatMap((cycle) => cycle.cars.map((car) => ({ cycle, car }))) ?? [];

  return (
    <Card
      title="מגיעים ברכב פרטי"
      actions={<Badge kind={(cars?.totalPeople ?? 0) > 0 ? 'warn' : 'ok'}>{cars?.totalPeople ?? 0}</Badge>}
    >
      {rows.length === 0 ? (
        <Empty>אף אחד לא מגיע ברכב פרטי.</Empty>
      ) : (
        <>
          <p className="small">
            <strong>{cars!.totalPeople}</strong> אנשים מגיעים ברכב פרטי ב־<strong>{cars!.totalCars}</strong> רכבים,
            ולכן אינם תופסים מקום באוטובוס.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>פעימה</th>
                  <th>נהג</th>
                  <th>מספר רכב</th>
                  <th>נוסע</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cycle, car }) => (
                  <tr key={car.driver.userId}>
                    <td data-label="פעימה">
                      {cycle.cycleName} · {formatDate(cycle.exitDate)}
                    </td>
                    <td data-label="נהג">
                      {car.driver.fullName}
                      <span className="muted small"> · {car.driver.companyId}</span>
                    </td>
                    <td className="muted" data-label="מספר רכב">
                      {car.driver.carPlate ?? 'לא הוזן'}
                    </td>
                    <td data-label="נוסע">
                      {car.passenger ? (
                        <>
                          {car.passenger.fullName}
                          <span className="muted small"> · {car.passenger.companyId}</span>
                        </>
                      ) : (
                        <span className="muted">אין</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
