import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type SigningLeaderOption, type Trip } from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import { cycleName, ROLE_LABEL } from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading } from '../components/ui';

/** שורת פעימה בטופס. תאריך יציאה בלבד - השם נגזר מסדר היציאה. */
interface CycleDraft {
  key: number;
  exitDate: string;
}

let nextKey = 1;
const emptyCycle = (): CycleDraft => ({ key: nextKey++, exitDate: '' });

/**
 * מסך יצירת גלישה. עומד בנפרד מרשימת הגלישות כדי שהמסך יעסוק רק בגלישה החדש.
 * שם הגלישה (לא חובה - "גלישה #N" אם נשאר ריק), המפקדים שאחראים לשבץ, ופעימות
 * היציאה. שמות הפעימות נוצרים אוטומטית, ותאריך הפרסום הוא רגע הלחיצה על הכפתור.
 */
export function CreateTripPage() {
  const navigate = useNavigate();
  const options = useApi<{ leaders: SigningLeaderOption[] }>('/trips/signing-leaders');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [cycles, setCycles] = useState<CycleDraft[]>([emptyCycle()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const leaders = options.data?.leaders ?? [];
  const filtered = useMemo(() => {
    const term = search.trim();
    if (!term) return leaders;
    return leaders.filter((leader) => leader.fullName.includes(term) || (leader.unitName ?? '').includes(term));
  }, [leaders, search]);

  const toggle = (id: number) =>
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  /**
   * הפעימות מסודרות לפי תאריך היציאה, כי מזה נגזרים השמות בשרת: מי שיוצא
   * ראשון הוא החלוץ. שורות בלי תאריך נשארות בסוף עד שימולאו.
   */
  const ordered = useMemo(() => {
    const withDate = cycles.filter((cycle) => cycle.exitDate);
    const withoutDate = cycles.filter((cycle) => !cycle.exitDate);
    withDate.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    return [...withDate, ...withoutDate].map((cycle, index) => ({
      ...cycle,
      // השם מוצג רק לשורות שיש להן תאריך - אחרת מקומן בסדר עוד לא ידוע.
      name: cycle.exitDate ? cycleName(index) : null,
    }));
  }, [cycles]);

  const updateCycle = (key: number, patch: Partial<CycleDraft>) =>
    setCycles((current) => current.map((cycle) => (cycle.key === key ? { ...cycle, ...patch } : cycle)));

  const removeCycle = (key: number) => setCycles((current) => current.filter((cycle) => cycle.key !== key));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (selected.length === 0) {
      setError('יש לבחור לפחות מפקד אחד שישבץ אנשים');
      return;
    }
    const filled = cycles.filter((cycle) => cycle.exitDate);
    if (filled.length === 0) {
      setError('יש להגדיר לפחות פעימה אחת - החלוץ');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ trip: Trip }>('/trips', {
        ...(name.trim() ? { name: name.trim() } : {}),
        leaderIds: selected,
        cycles: filled.map((cycle) => ({ exitDate: cycle.exitDate })),
      });
      navigate(`/manage/${result.trip.id}`);
    } catch (caught) {
      setError(errorMessage(caught, 'יצירת הגלישה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>גלישה חדשה</h1>
          <p>המפקדים שאחראים לשבץ את האנשים שלהם, ופעימות היציאה</p>
        </div>
        <Link to="/manage" className="btn">
          חזרה לגלישות
        </Link>
      </div>

      <form onSubmit={submit}>
        <Alert kind="error">{error}</Alert>
        <Alert kind="info">
          שמות הפעימות נגזרים מסדר היציאה: הפעימה שיוצאת ראשונה היא החלוץ, ואחריה פעימה 1, פעימה 2 וכן הלאה.
        </Alert>

        <Card title="שם הגלישה">
          <Field label="שם הגלישה" hint={`לא חובה - אם נשאר ריק, השם יהיה "גלישה #N" אוטומטית`}>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="לדוגמה: גלישת גיבוש קיץ" />
          </Field>
        </Card>

        <Card
          title={`פעימות יציאה (${cycles.filter((cycle) => cycle.exitDate).length})`}
          actions={
            <button type="button" className="btn btn--sm" onClick={() => setCycles((current) => [...current, emptyCycle()])}>
              הוספת פעימה
            </button>
          }
        >
          <div className="stack">
            {ordered.map((cycle) => (
              <div key={cycle.key} className="field-row field-row--end">
                <Field label="פעימה">
                  {cycle.name ? (
                    <Badge kind={cycle.name === 'חלוץ' ? 'info' : 'default'}>{cycle.name}</Badge>
                  ) : (
                    <span className="muted small">נקבע לפי תאריך היציאה</span>
                  )}
                </Field>
                <Field label="תאריך יציאה">
                  <input
                    type="date"
                    value={cycle.exitDate}
                    onChange={(event) => updateCycle(cycle.key, { exitDate: event.target.value })}
                  />
                </Field>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => removeCycle(cycle.key)}
                  disabled={cycles.length === 1}
                  title={cycles.length === 1 ? 'חייבת להיות לפחות פעימה אחת' : undefined}
                >
                  הסרה
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card title={`מפקדים שישבצו את האנשים שלהם (${selected.length} נבחרו)`}>
          <div className="field-row">
            <Field label="חיפוש מפקד">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="שם או יחידה" />
            </Field>
          </div>

          {options.loading ? (
            <Loading label="טוען מפקדים..." />
          ) : leaders.length === 0 ? (
            <Empty>לא נמצאו מפקדים מאושרים שאפשר להטיל עליהם את משימת השיבוץ.</Empty>
          ) : (
            <>
              <div className="row" style={{ marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setSelected(filtered.map((leader) => leader.id))}
                >
                  בחר הכל ({filtered.length})
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelected([])}>
                  נקה בחירה
                </button>
              </div>

              <div className="stack">
                {filtered.map((leader) => (
                  <label key={leader.id} className="checkbox">
                    <input type="checkbox" checked={selected.includes(leader.id)} onChange={() => toggle(leader.id)} />
                    <span>
                      <strong>{leader.fullName}</strong>
                      <span className="muted"> · {ROLE_LABEL[leader.role]}</span>
                      {leader.unitName && <span className="muted"> · {leader.unitName}</span>}
                      <br />
                      <span className="small muted">{leader.directReports} כפיפים ישירים</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </Card>

        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={busy || selected.length === 0}>
            {busy ? 'מפרסם...' : 'פרסום הגלישה'}
          </button>
          <span className="small muted">{cycles.filter((cycle) => cycle.exitDate).length} פעימות</span>
        </div>
      </form>
    </>
  );
}
