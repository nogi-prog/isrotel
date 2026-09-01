import { useParams } from 'react-router-dom';
import type { FoodReport } from '../lib/api';
import { useApi } from '../lib/useApi';
import { DIET_LABEL, formatDate } from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Loading, Stat } from '../components/ui';

/**
 * דוח הזמנת מזון לאופרטיבי: כמה מנות להזמין מכל סוג, לפי פעימה ובסך הכל.
 * כל פעימה היא יציאה של יום אחד, ולכן המנות הן מספר המשתתפים המאושרים × 3 ארוחות.
 */
export function FoodPage() {
  const { tripId } = useParams();
  const { data, loading, error } = useApi<FoodReport>(tripId ? `/trips/${tripId}/food` : null);

  if (loading) return <Loading />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>הזמנת מזון</h1>
          <p>
            {data.tripName} · {data.mealsPerDay} ארוחות לכל משתתף בפעימה
          </p>
        </div>
        <div className="row">
          {tripId && <BackToTrip tripId={tripId} />}
          <button type="button" className="btn btn--sm" onClick={() => window.print()}>
            הדפסה
          </button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <Stat value={data.grandTotalParticipants} label="סה״כ משתתפים" />
        <Stat value={data.grandTotalPortions} label="סה״כ מנות להזמנה" />
        {data.totals.map((total) => (
          <Stat key={total.diet} value={total.portions} label={`מנות ${DIET_LABEL[total.diet]}`} />
        ))}
      </div>

      <Alert kind="info">
        כל פעימה היא יציאה של יום אחד, ולכן מספר המנות הוא מספר המשתתפים המאושרים × {data.mealsPerDay} ארוחות.
        רק נרשמים שאושרו על ידי מפקד נכנסים לחישוב.
      </Alert>

      {data.cycles.length === 0 && <Empty>לא הוגדרו פעימות יציאה.</Empty>}

      {data.cycles.map((cycle) => (
        <Card
          key={cycle.cycleId}
          title={`${cycle.cycleName} · ${formatDate(cycle.exitDate)}`}
          actions={<Badge kind="ok">{cycle.participants} משתתפים</Badge>}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>סוג תזונה</th>
                  <th>משתתפים</th>
                  <th>ארוחות למשתתף</th>
                  <th>מנות להזמנה</th>
                </tr>
              </thead>
              <tbody>
                {cycle.diets.map((entry) => (
                  <tr key={entry.diet}>
                    <td data-label="סוג תזונה">
                      {entry.diet === 'all' ? (
                        DIET_LABEL.all
                      ) : (
                        <Badge kind="warn">{DIET_LABEL[entry.diet]}</Badge>
                      )}
                    </td>
                    <td data-label="משתתפים">{entry.participants}</td>
                    <td className="muted" data-label="ארוחות למשתתף">{cycle.mealsPerDay}</td>
                    <td data-label="מנות להזמנה">
                      <strong>{entry.portions}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td data-label="סוג תזונה">סה״כ</td>
                  <td data-label="משתתפים">{cycle.participants}</td>
                  <td data-label="ארוחות למשתתף" />
                  <td data-label="מנות להזמנה">{cycle.totalPortions}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ))}

      <Card title="סיכום להזמנה מהספק">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>סוג תזונה</th>
                <th>משתתפים (כל הפעימות)</th>
                <th>סה״כ מנות</th>
              </tr>
            </thead>
            <tbody>
              {data.totals.map((total) => (
                <tr key={total.diet}>
                  <td data-label="סוג תזונה">{DIET_LABEL[total.diet]}</td>
                  <td data-label="משתתפים (כל הפעימות)">{total.participants}</td>
                  <td data-label="סה״כ מנות">
                    <strong>{total.portions}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="סוג תזונה">סה״כ</td>
                <td data-label="משתתפים (כל הפעימות)">{data.grandTotalParticipants}</td>
                <td data-label="סה״כ מנות">{data.grandTotalPortions}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </>
  );
}
