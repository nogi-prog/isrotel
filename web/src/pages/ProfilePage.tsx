import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Diet,
  type Gender,
  type HierarchyMember,
  type ProfileEditRequest,
  type Role,
  type RoommateOption,
  type TeamMember,
  type UserSearchResult,
  type WorkerType,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage, useApi } from '../lib/useApi';
import {
  DIET_LABEL,
  GENDER_LABEL_SINGULAR,
  ROLE_LABEL,
  ROLE_LABEL_LONG,
  unitWordForRole,
  USER_STATUS_LABEL,
  WORKER_TYPE_LABEL,
} from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading, Stat, StatusBadge } from '../components/ui';
import { ManagerPicker, useEligibleManagers } from '../components/ManagerPicker';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

const EDIT_COLUMN_COUNT = 9;

/** מפמ״ר הוא ראש השרשרת ולאופרטיבי עמדה קבועה - אף אחד מהם אינו ניתן להעברה. */
function isMovableRole(role: Role): boolean {
  return role !== 'to' && role !== 'ceo';
}

/** רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם - ראו lib/cars.ts בשרת. */
function alwaysBringsOwnCar(role: string): boolean {
  return role === 'division_leader' || role === 'ceo';
}

/**
 * מסך "פרופיל": כרטיס אחד לפרטים האישיים, בתצוגה או בעריכה - לא שני כרטיסים
 * נפרדים לצפייה ולעריכה. עריכה ממתינה לאישור המפקד, כמו בהרשמה.
 */
export function ProfilePage() {
  const { user, refresh } = useAuth();
  const { data, loading, error, reload } = useApi<{ pending: ProfileEditRequest | null }>('/users/me/profile-edit');
  const hierarchy = useApi<{ chain: HierarchyMember[] }>('/users/me/hierarchy');
  const team = useApi<{ team: TeamMember[] }>(user?.isManager ? '/users/my-team' : null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const canAddExWorkers = user?.role === 'team_leader';

  const pending = data?.pending ?? null;
  const isManager = user ? user.role !== 'employee' : false;
  const ownsCar = user ? alwaysBringsOwnCar(user.role) : false;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [diet, setDiet] = useState<Diet>('all');
  const [unitName, setUnitName] = useState('');
  const [carPlate, setCarPlate] = useState('');

  // הטופס מוצג עם ערכי הבקשה הממתינה אם יש, אחרת עם הערכים הנוכחיים.
  useEffect(() => {
    if (!user) return;
    const source = pending?.proposed ?? {
      firstName: user.firstName,
      lastName: user.lastName,
      gender: user.gender,
      diet: user.diet,
      unitName: user.unitName,
    };
    setFirstName(source.firstName);
    setLastName(source.lastName);
    setGender(source.gender);
    setDiet(source.diet);
    setUnitName(source.unitName ?? '');
    setCarPlate(user.carPlate ?? '');
  }, [user, pending]);

  const childrenByManager = useMemo(() => buildChildrenMap(team.data?.team ?? []), [team.data]);

  const teamList = team.data?.team ?? [];
  const teamFiltered = useMemo(() => {
    const term = teamSearch.trim();
    if (!term) return teamList;
    return teamList.filter(
      (member) =>
        member.fullName.includes(term) || member.companyId.includes(term) || member.unitPath.includes(term),
    );
  }, [teamList, teamSearch]);

  // עובדים-לשעבר (מושאלים ומילואים) מוצגים בסעיפים נפרדים מעובדים רגילים.
  const teamRegular = useMemo(() => teamFiltered.filter((member) => member.workerType === 'regular'), [teamFiltered]);
  const teamBorrowed = useMemo(
    () => teamFiltered.filter((member) => member.workerType === 'borrowed'),
    [teamFiltered],
  );
  const teamReserve = useMemo(() => teamFiltered.filter((member) => member.workerType === 'reserve'), [teamFiltered]);

  const teamStats = useMemo(
    () => ({
      total: teamList.length,
      pending: teamList.filter((member) => member.status === 'pending').length,
      male: teamList.filter((member) => member.gender === 'male').length,
      female: teamList.filter((member) => member.gender === 'female').length,
      special: teamList.filter((member) => member.diet !== 'all').length,
    }),
    [teamList],
  );

  const onTeamSaved = () => {
    setEditingMemberId(null);
    void team.reload();
  };

  if (!user) return null;
  if (loading) return <Loading />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    setSuccess('');
    setBusy(true);
    try {
      // מספר הרכב מתעדכן מיד בלי אישור - זה פרט מנהלי, לא שינוי בזהות
      // או בשיוך הארגוני, ולכן הוא נשלח בנפרד משאר הפרטים.
      if (carPlate.trim() !== (user.carPlate ?? '')) {
        await api.put('/users/me/car-plate', { carPlate: carPlate.trim() || null });
        await refresh();
      }

      const response = await api.post<{ pending: ProfileEditRequest | null }>('/users/me/profile-edit', {
        firstName,
        lastName,
        gender,
        diet,
        ...(isManager ? { unitName } : {}),
      });
      setSuccess(response.pending ? 'הבקשה נשלחה לאישור המפקד.' : 'הפרטים נשמרו.');
      setEditing(false);
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught, 'שליחת הבקשה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setFormError('');
    setSuccess('');
    setWithdrawing(true);
    try {
      await api.delete('/users/me/profile-edit');
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught, 'ביטול הבקשה נכשל'));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>פרופיל</h1>
          <p>הפרטים האישיים שלך - כל שינוי ממתין לאישור המפקד, בדיוק כמו בהרשמה</p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {pending && (
        <Alert kind="warn">
          <div className="stack" style={{ gap: '0.4rem' }}>
            <strong>יש לך בקשת עדכון ממתינה לאישור המפקד</strong>
            <span className="small">
              {pending.proposed.firstName} {pending.proposed.lastName} ·{' '}
              {GENDER_LABEL_SINGULAR[pending.proposed.gender]} · {DIET_LABEL[pending.proposed.diet]}
              {pending.proposed.unitName ? ` · ${pending.proposed.unitName}` : ''}
            </span>
            <div>
              <button type="button" className="btn btn--sm" disabled={withdrawing} onClick={() => void withdraw()}>
                {withdrawing ? 'מבטל...' : 'בטל בקשה'}
              </button>
            </div>
          </div>
        </Alert>
      )}

      <Card
        title="הפרטים שלי"
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setFormError('');
              setSuccess('');
              setEditing((value) => !value);
            }}
          >
            {editing ? 'ביטול' : 'עריכה'}
          </button>
        }
      >
        <Alert kind="error">{formError}</Alert>
        <Alert kind="success">{success}</Alert>

        {editing ? (
          <form onSubmit={submit}>
            <div className="field-row">
              <Field label="שם פרטי">
                <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
              </Field>
              <Field label="שם משפחה">
                <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
              </Field>
            </div>

            <div className="field-row">
              <Field label="מין" hint="קובע את שיוך מבנה הלינה">
                <select value={gender} onChange={(event) => setGender(event.target.value as Gender)} required>
                  <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
                  <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
                </select>
              </Field>

              <Field label="העדפת תזונה">
                <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
                  {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
                    <option key={option} value={option}>
                      {DIET_LABEL[option]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {isManager && (
              <Field label="שם היחידה שבפיקודך" hint="לדוגמה: צוות אלון / מדור תוכנה / תחום פיתוח">
                <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
              </Field>
            )}

            <Field
              label="מספר רכב (7-8 ספרות)"
              hint={
                ownsCar
                  ? 'מתעדכן מיד - רת״ח ומפמ״ר תמיד מגיעים ברכב הפרטי שלהם, בלי צורך באישור'
                  : 'מתעדכן מיד. משמש בבקשת הגעה ברכב פרטי לגלישה - עדיין טעון בקשה ואישור רת״ח בכל גלישה'
              }
            >
              <input
                value={carPlate}
                onChange={(event) => setCarPlate(event.target.value)}
                placeholder="1234567"
                inputMode="numeric"
                maxLength={8}
              />
            </Field>

            <div className="row">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {busy ? 'שומר...' : 'שמירה'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
                ביטול
              </button>
            </div>
          </form>
        ) : (
          <div className="stack">
            <InfoRow label="מספר אישי" value={user.companyId} />
            <InfoRow label="שם" value={user.fullName} />
            <InfoRow label="תפקיד" value={ROLE_LABEL_LONG[user.role] ?? user.role} />
            <InfoRow label="מפקד" value={user.managerName ?? '—'} />
            <InfoRow label="מין" value={GENDER_LABEL_SINGULAR[user.gender] ?? user.gender} />
            <InfoRow label="העדפת תזונה" value={DIET_LABEL[user.diet] ?? user.diet} />
            {user.unitName && <InfoRow label="יחידה" value={user.unitName} />}
            <InfoRow label="מספר רכב" value={user.carPlate ?? 'לא הוזן'} />
            <p className="muted small" style={{ marginTop: '0.25rem' }}>
              מספר אישי, תפקיד ומפקד אינם ניתנים לעריכה - כל שינוי אחר ממתין לאישור המפקד, חוץ ממספר הרכב
              שמתעדכן מיד.
            </p>
          </div>
        )}
      </Card>

      <Card title="שרשרת הפיקוד שלי">
        {hierarchy.loading && <Loading />}
        <Alert kind="error">{hierarchy.error}</Alert>
        {hierarchy.data && (
          <HierarchyChain chain={hierarchy.data.chain} selfId={user.id} childrenByManager={childrenByManager} />
        )}
      </Card>

      <RoommatePreferencesCard />

      {user.isManager && (
        <>
          <div className="stat-grid" style={{ marginBottom: '1rem' }}>
            <Stat value={teamStats.total} label={user.isTripOrganizer ? 'סה״כ אנשים בחברה' : 'סה״כ אנשים'} />
            <Stat value={teamStats.pending} label="ממתינים לאישור רישום" />
            <Stat value={teamStats.male} label="בנים" />
            <Stat value={teamStats.female} label="בנות" />
            <Stat value={teamStats.special} label="תזונה מיוחדת" />
          </div>

          <Card title={user.isTripOrganizer ? 'כל אנשי החברה' : 'העובדים שלי'}>
            <Alert kind="error">{team.error}</Alert>
            {team.loading ? (
              <Loading />
            ) : (
              <>
                <Field label="חיפוש">
                  <input
                    value={teamSearch}
                    onChange={(event) => setTeamSearch(event.target.value)}
                    placeholder="שם, מספר אישי או יחידה"
                  />
                </Field>

                {teamFiltered.length === 0 ? (
                  <Empty>{teamList.length === 0 ? 'אין כפיפים במערכת.' : 'לא נמצאו תוצאות.'}</Empty>
                ) : (
                  <TeamTable
                    members={teamRegular}
                    editingId={editingMemberId}
                    setEditingId={setEditingMemberId}
                    onSaved={onTeamSaved}
                  />
                )}
              </>
            )}
          </Card>

          {(canAddExWorkers || teamBorrowed.length > 0) && (
            <Card
              title="עובדים מושאלים (הצ״ח)"
              actions={
                canAddExWorkers ? (
                  <AddExWorkerToggle workerType="borrowed" onAdded={() => void team.reload()} />
                ) : undefined
              }
            >
              {teamBorrowed.length === 0 ? (
                <Empty>אין עובדים מושאלים כרגע.</Empty>
              ) : (
                <TeamTable
                  members={teamBorrowed}
                  editingId={editingMemberId}
                  setEditingId={setEditingMemberId}
                  onSaved={onTeamSaved}
                />
              )}
            </Card>
          )}

          {(canAddExWorkers || teamReserve.length > 0) && (
            <Card
              title="אנשי מילואים"
              actions={
                canAddExWorkers ? (
                  <AddExWorkerToggle workerType="reserve" onAdded={() => void team.reload()} />
                ) : undefined
              }
            >
              {teamReserve.length === 0 ? (
                <Empty>אין אנשי מילואים כרגע.</Empty>
              ) : (
                <TeamTable
                  members={teamReserve}
                  editingId={editingMemberId}
                  setEditingId={setEditingMemberId}
                  onSaved={onTeamSaved}
                />
              )}
            </Card>
          )}
        </>
      )}

      <PasswordCard hasPassword={user.hasPassword} />
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row row--between">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** החלפת סיסמה עצמית. חשבון בלי סיסמה מוגדרת (מלפני הוספת האימות) יכול להגדיר אחת בלי סיסמה נוכחית. */
function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [success, setSuccess] = useState('');

  return (
    <Card title="סיסמה">
      <Alert kind="success">{success}</Alert>
      <ChangePasswordForm
        requireCurrent={hasPassword}
        onSuccess={() => setSuccess('הסיסמה עודכנה בהצלחה.')}
      />
    </Card>
  );
}

/**
 * העדפות השותפים הקבועות: "עם מי הייתי רוצה לישון" באופן כללי, ולא לגלישה
 * מסוים. נשאלות (לא חובה) בהרשמה, ונערכות כאן. הן משמשות כברירת מחדל בכל
 * גלישה שבו המשתמש לא בחר שותפים ספציפיים.
 *
 * האילוצים הקשיחים (אותו מין, ואותו דרג ניהולי בדיוק) נאכפים בשרת, ולכן
 * רשימת המועמדים כבר מגיעה מסוננת.
 */
function RoommatePreferencesCard() {
  const { data, loading, error, reload } = useApi<{
    max: number;
    preferences: RoommateOption[];
    candidates: RoommateOption[];
  }>('/users/me/roommate-preferences');

  const [selected, setSelected] = useState<number[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');

  const max = data?.max ?? 3;
  const current = selected ?? (data?.preferences ?? []).map((entry) => entry.id);
  const dirty = selected != null;

  const byId = useMemo(
    () => new Map((data?.candidates ?? []).map((candidate) => [candidate.id, candidate])),
    [data],
  );

  const filtered = useMemo(() => {
    const list = data?.candidates ?? [];
    const term = search.trim();
    if (!term) return list;
    return list.filter(
      (candidate) =>
        candidate.fullName.includes(term) ||
        candidate.companyId.includes(term) ||
        candidate.unitPath.includes(term),
    );
  }, [data, search]);

  const toggle = (id: number) => {
    setSuccess('');
    setSelected(
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : current.length >= max
          ? current
          : [...current, id],
    );
  };

  const save = async () => {
    setSaveError('');
    setSuccess('');
    setBusy(true);
    try {
      await api.put('/users/me/roommate-preferences', { preferences: current });
      setSelected(null);
      setSuccess('העדפות השותפים נשמרו.');
      await reload();
    } catch (caught) {
      setSaveError(errorMessage(caught, 'שמירת ההעדפות נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="העדפות שותפים לחדר"
      actions={<Badge kind={current.length > 0 ? 'ok' : 'default'}>{current.length}/{max}</Badge>}
    >
      <Alert kind="error">{error}</Alert>
      <Alert kind="error">{saveError}</Alert>
      <Alert kind="success">{success}</Alert>

      {loading ? (
        <Loading />
      ) : (
        <>
          <p className="muted small">
            הבחירה אינה חובה. היא משמשת כברירת מחדל בכל גלישה שבה לא בחרת שותפים ספציפיים - ואפשר תמיד לשנות
            אותה לגלישה מסוימת במסך הגלישה. השיבוץ מנסה לכבד את הבקשה, אבל אינו מתחייב.
          </p>

          {(data?.candidates ?? []).length === 0 ? (
            <Empty>אין כרגע מועמדים מתאימים. אפשר לבחור רק אנשים מאותו מין ומאותו דרג ניהולי בדיוק.</Empty>
          ) : (
            <>
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
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="שם, מספר אישי או יחידה"
                />
              </Field>

              {filtered.length === 0 ? (
                <p className="muted">לא נמצאו מועמדים תואמים.</p>
              ) : (
                <div className="table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th />
                        <th>שם</th>
                        <th>יחידה</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((candidate) => (
                        <tr key={candidate.id}>
                          <td data-label="בחירה">
                            <input
                              type="checkbox"
                              checked={current.includes(candidate.id)}
                              disabled={!current.includes(candidate.id) && current.length >= max}
                              onChange={() => toggle(candidate.id)}
                              aria-label={`בחר את ${candidate.fullName}`}
                            />
                          </td>
                          <td data-label="שם">{candidate.fullName}</td>
                          <td className="muted" data-label="יחידה">
                            {candidate.unitPath}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="row" style={{ marginTop: '0.75rem' }}>
                <button type="button" className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? 'שומר...' : 'שמירת ההעדפות'}
                </button>
                {dirty && (
                  <button type="button" className="btn" disabled={busy} onClick={() => setSelected(null)}>
                    ביטול
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** ראשי התיבות של שם מלא, לתצוגה בתוך הבועה - עד שתי אותיות. */
function initials(fullNameValue: string): string {
  const letters = fullNameValue
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean);
  return letters.slice(0, 2).join('');
}

/** ממפה כל מפקד למי שכפוף לו ישירות מתוך רשימת כפיפים שטוחה. */
function buildChildrenMap(team: TeamMember[]): Map<number, TeamMember[]> {
  const map = new Map<number, TeamMember[]>();
  for (const member of team) {
    const key = member.managerId ?? -1;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(member);
  }
  return map;
}

/** כמה אנשים כפופים למישהו בכל העומקים (לא כולל אותו עצמו). */
function subtreeSize(id: number, childrenByManager: Map<number, TeamMember[]>): number {
  const children = childrenByManager.get(id) ?? [];
  return children.reduce((sum, child) => sum + 1 + subtreeSize(child.id, childrenByManager), 0);
}

/**
 * שרשרת הפיקוד כשרשרת בועות אנכית - מהמשתמש עצמו (למטה) ועד ראש השרשרת
 * (למעלה), עם קו מחבר בין כל שתי בועות סמוכות. מתחת לבועת המשתמש מתחיל
 * עץ משפחה הניתן להרחבה: לחיצה על כפיף חושפת את הכפיפים שלו, וכן הלאה.
 */
function HierarchyChain({
  chain,
  selfId,
  childrenByManager,
}: {
  chain: HierarchyMember[];
  selfId: number;
  childrenByManager: Map<number, TeamMember[]>;
}) {
  if (chain.length === 0) return null;
  const topDown = [...chain].reverse();
  const directReports = childrenByManager.get(selfId) ?? [];

  return (
    <div className="org-bubbles">
      {topDown.map((member, index) => {
        const isSelf = member.id === selfId;
        return (
          <div className="org-bubbles__item" key={member.id}>
            {index > 0 && <div className="org-bubbles__connector" aria-hidden />}
            <div className={`org-bubble${isSelf ? ' org-bubble--self' : ''}`}>{initials(member.fullName)}</div>
            <div className="org-bubbles__label">
              <span className="org-bubbles__name">
                {member.fullName}
                {isSelf ? ' (אתה)' : ''}
              </span>
              <span className="org-bubbles__role">
                {ROLE_LABEL_LONG[member.role] ?? member.role}
                {member.unitName ? ` · ${member.unitName}` : ''}
              </span>
            </div>
          </div>
        );
      })}

      {directReports.length > 0 && (
        <>
          <div className="org-bubbles__connector" aria-hidden />
          <div className="org-fam__children">
            {directReports.map((report) => (
              <div className="org-fam__branch" key={report.id}>
                <FamilyNode member={report} childrenByManager={childrenByManager} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * צומת בעץ המשפחה: בועה עם שם ותפקיד, וחץ לחיצה אם יש לו כפיפים משלו -
 * לחיצה חושפת אותם עם אותו רכיב באופן רקורסיבי, ובכך "מרחיבה" את העץ.
 */
function FamilyNode({
  member,
  childrenByManager,
}: {
  member: TeamMember;
  childrenByManager: Map<number, TeamMember[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = childrenByManager.get(member.id) ?? [];
  const hasChildren = children.length > 0;
  const teamSize = hasChildren ? subtreeSize(member.id, childrenByManager) : 0;

  const toggle = () => {
    if (hasChildren) setExpanded((value) => !value);
  };

  return (
    <div className="org-fam__node">
      <div
        className={`org-fam__item${hasChildren ? ' org-fam__item--clickable' : ''}`}
        role={hasChildren ? 'button' : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (hasChildren && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <div className={`org-bubble org-bubble--sm${hasChildren ? ' org-bubble--expandable' : ''}`}>
          {initials(member.fullName)}
        </div>
        <div className="org-bubbles__label">
          <span className="org-bubbles__name">{member.fullName}</span>
          <span className="org-bubbles__role">
            {ROLE_LABEL_LONG[member.role] ?? member.role}
            {teamSize > 0 ? ` · ${teamSize} ב${unitWordForRole(member.role)}` : ''}
          </span>
        </div>
        {hasChildren && (
          <span className="org-fam__caret" aria-hidden>
            {expanded ? '▴' : '▾'}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <div className="org-fam__children">
          {children.map((child) => (
            <div className="org-fam__branch" key={child.id}>
              <FamilyNode member={child} childrenByManager={childrenByManager} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** טבלת חברי צוות משותפת לשלושת הסעיפים (רגילים / מושאלים / מילואים). */
function TeamTable({
  members,
  editingId,
  setEditingId,
  onSaved,
}: {
  members: TeamMember[];
  editingId: number | null;
  setEditingId: (id: number | null) => void;
  onSaved: () => void;
}) {
  if (members.length === 0) return <Empty>לא נמצאו תוצאות.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>שם</th>
            <th>מספר אישי</th>
            <th>תפקיד</th>
            <th>יחידה</th>
            <th>מין</th>
            <th>תזונה</th>
            <th>מפקד ישיר</th>
            <th>מצב</th>
            <th>פעולות</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <Fragment key={member.id}>
              <tr>
                <td data-label="שם">
                  {member.fullName}
                  {member.workerType !== 'regular' && (
                    <>
                      {' '}
                      <Badge kind="info">{WORKER_TYPE_LABEL[member.workerType]}</Badge>
                    </>
                  )}
                  {member.workerType === 'borrowed' && member.borrowedFrom && (
                    <span className="muted small"> · מ{member.borrowedFrom}</span>
                  )}
                  {member.workerType === 'borrowed' && member.borrowedMission && (
                    <span className="muted small"> · {member.borrowedMission}</span>
                  )}
                </td>
                <td data-label="מספר אישי">{member.companyId}</td>
                <td data-label="תפקיד">{ROLE_LABEL[member.role]}</td>
                <td className="muted" data-label="יחידה">{member.unitPath || '—'}</td>
                <td data-label="מין">{GENDER_LABEL_SINGULAR[member.gender]}</td>
                <td data-label="תזונה">{DIET_LABEL[member.diet]}</td>
                <td className="muted" data-label="מפקד ישיר">{member.managerName ?? '—'}</td>
                <td data-label="מצב">
                  <StatusBadge status={member.status} labels={USER_STATUS_LABEL} />
                </td>
                <td data-label="פעולות">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setEditingId(editingId === member.id ? null : member.id)}
                  >
                    {editingId === member.id ? 'סגירה' : 'עריכה'}
                  </button>
                </td>
              </tr>
              {editingId === member.id && (
                <tr>
                  <td colSpan={EDIT_COLUMN_COUNT} className="edit-row">
                    <EditMemberForm member={member} onClose={() => setEditingId(null)} onSaved={onSaved} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** כפתור שפותח וסוגר את טופס הוספת עובד-לשעבר, בלי להזדקק ל-state בעמוד עצמו. */
function AddExWorkerToggle({ workerType, onAdded }: { workerType: WorkerType; onAdded: () => void }) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div style={{ minWidth: '280px' }}>
        <AddExWorkerForm
          workerType={workerType}
          onClose={() => setOpen(false)}
          onAdded={() => {
            setOpen(false);
            onAdded();
          }}
        />
      </div>
    );
  }

  return (
    <button type="button" className="btn btn--sm btn--primary" onClick={() => setOpen(true)}>
      {workerType === 'borrowed' ? 'הוספת עובד מושאל' : 'הוספת איש מילואים'}
    </button>
  );
}

/**
 * הוספת עובד-לשעבר (מושאל או מילואים) ישירות לצוות - ראו POST
 * /users/ex-workers בשרת. זמין רק לר״צ, ולכן העמוד מציג אותו רק לו.
 * בניגוד להרשמה רגילה הוא מצטרף מאושר מיד, בלי אישור נוסף.
 */
function AddExWorkerForm({
  workerType,
  onClose,
  onAdded,
}: {
  workerType: WorkerType;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [companyId, setCompanyId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [diet, setDiet] = useState<Diet>('all');
  const [borrowedFrom, setBorrowedFrom] = useState('');
  const [borrowedMission, setBorrowedMission] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/users/ex-workers', {
        companyId,
        firstName,
        lastName,
        gender,
        diet,
        workerType,
        ...(workerType === 'borrowed' ? { borrowedFrom, borrowedMission } : {}),
      });
      onAdded();
    } catch (caught) {
      setError(errorMessage(caught, 'הוספת העובד נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack" style={{ marginTop: '0.5rem' }}>
      <Alert kind="error">{error}</Alert>

      <div className="field-row">
        <Field label="מספר אישי (7 ספרות)">
          <input
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            inputMode="numeric"
            maxLength={7}
            required
            autoFocus
          />
        </Field>
        <Field label="שם פרטי">
          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
        </Field>
        <Field label="שם משפחה">
          <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
        </Field>
      </div>

      <div className="field-row">
        <Field label="מין">
          <select value={gender} onChange={(event) => setGender(event.target.value as Gender)} required>
            <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
            <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
          </select>
        </Field>
        <Field label="העדפת תזונה">
          <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
            {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
              <option key={option} value={option}>
                {DIET_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>
        {workerType === 'borrowed' && (
          <Field label="מאיפה הושאל" hint="לדוגמה: מדור תוכנה / חברה חיצונית">
            <input value={borrowedFrom} onChange={(event) => setBorrowedFrom(event.target.value)} required />
          </Field>
        )}
      </div>

      {workerType === 'borrowed' && (
        <Field label="המשימה שבשבילה מבקשים את ההשאלה">
          <input
            value={borrowedMission}
            onChange={(event) => setBorrowedMission(event.target.value)}
            placeholder="לדוגמה: תגבור לפרויקט X עד סוף החודש"
            required
          />
        </Field>
      )}

      <div className="row">
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>
          {busy ? 'מוסיף...' : 'הוספה'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          ביטול
        </button>
      </div>
    </form>
  );
}

/**
 * עריכת פרטי כפיף, כולל שיוך למפקד אחר. שינוי שם/מין/תזונה/יחידה חל מיד -
 * המפקד שעורך כבר מחזיק בסמכות. שינוי מפקד עובר דרך אותה בדיקה שמניעה
 * העברה עצמאית: אם המפקד היעד מחוץ לשרשרת הפיקוד של העורך, ההעברה ממתינה
 * לאישורו; אחרת היא חלה מיד. מי שיש לו כפיפים משלו דורש ממלא מקום.
 */
function EditMemberForm({
  member,
  onClose,
  onSaved,
}: {
  member: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(member.firstName);
  const [lastName, setLastName] = useState(member.lastName);
  const [gender, setGender] = useState<Gender>(member.gender);
  const [diet, setDiet] = useState<Diet>(member.diet);
  const [unitName, setUnitName] = useState(member.unitName ?? '');
  const [toManagerId, setToManagerId] = useState<number | null>(member.managerId);
  const [successorQuery, setSuccessorQuery] = useState('');
  const [successorResults, setSuccessorResults] = useState<UserSearchResult[]>([]);
  const [successor, setSuccessor] = useState<UserSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isManager = member.role !== 'employee';
  const canMove = isMovableRole(member.role);
  const eligible = useEligibleManagers(member.role);

  // מעבר לעריכת אדם אחר מאפס את הטופס לערכים שלו.
  useEffect(() => {
    setFirstName(member.firstName);
    setLastName(member.lastName);
    setGender(member.gender);
    setDiet(member.diet);
    setUnitName(member.unitName ?? '');
    setToManagerId(member.managerId);
    setSuccessor(null);
    setSuccessorQuery('');
    setError('');
    setSuccess('');
  }, [member]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = successorQuery.trim();
    if (!term) {
      setSuccessorResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void api
        .get<{ results: UserSearchResult[] }>(`/users/search?q=${encodeURIComponent(term)}`)
        .then((response) => setSuccessorResults(response.results))
        .catch(() => setSuccessorResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [successorQuery]);

  const managerChanged = canMove && toManagerId != null && toManagerId !== member.managerId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (managerChanged && member.hasDirectReports && !successor) {
      setError('יש למנות ממלא מקום שיירש את היחידה לפני שינוי המפקד');
      return;
    }

    setBusy(true);
    try {
      await api.patch(`/users/${member.id}/profile`, {
        firstName,
        lastName,
        gender,
        diet,
        ...(isManager ? { unitName } : {}),
      });

      if (managerChanged && toManagerId != null) {
        const moveResponse = await api.post<{ applied: boolean }>(`/users/${member.id}/move`, {
          toManagerId,
          ...(successor ? { successorId: successor.id } : {}),
        });
        if (moveResponse.applied) {
          onSaved();
        } else {
          setSuccess('הפרטים עודכנו. בקשת ההעברה למפקד החדש ממתינה לאישורו.');
        }
        return;
      }

      onSaved();
    } catch (caught) {
      setError(errorMessage(caught, 'העדכון נכשל'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{success}</Alert>

      <div className="field-row">
        <Field label="שם פרטי">
          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
        </Field>
        <Field label="שם משפחה">
          <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
        </Field>
      </div>

      <div className="field-row">
        <Field label="מין">
          <select value={gender} onChange={(event) => setGender(event.target.value as Gender)} required>
            <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
            <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
          </select>
        </Field>

        <Field label="העדפת תזונה">
          <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
            {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
              <option key={option} value={option}>
                {DIET_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {isManager && (
        <Field label="שם היחידה שבפיקודו">
          <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
        </Field>
      )}

      {canMove && (
        <>
          <ManagerPicker
            role={member.role}
            options={eligible}
            value={toManagerId}
            onChange={setToManagerId}
            label="מפקד"
          />

          {managerChanged && member.hasDirectReports && (
            <div className="field">
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>ממלא מקום ביחידה הישנה</span>
              {successor ? (
                <div className="combo__selected">
                  <span>
                    <strong>{successor.fullName}</strong>
                    <span className="muted"> · {successor.companyId}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => {
                      setSuccessor(null);
                      setSuccessorQuery('');
                    }}
                  >
                    שינוי
                  </button>
                </div>
              ) : (
                <div className="combo">
                  <input
                    value={successorQuery}
                    onChange={(event) => setSuccessorQuery(event.target.value)}
                    placeholder="חיפוש לפי שם או מספר אישי"
                    autoComplete="off"
                  />
                  {successorQuery.trim() && (
                    <ul className="combo__list" role="listbox">
                      {searching ? (
                        <li className="combo__empty">מחפש...</li>
                      ) : successorResults.length === 0 ? (
                        <li className="combo__empty">לא נמצאו תוצאות</li>
                      ) : (
                        successorResults.map((candidate) => (
                          <li key={candidate.id}>
                            <button
                              type="button"
                              className="combo__option"
                              role="option"
                              aria-selected={false}
                              disabled={candidate.id === member.id || candidate.hasDirectReports}
                              onClick={() => {
                                setSuccessor(candidate);
                                setSuccessorQuery('');
                                setSuccessorResults([]);
                              }}
                            >
                              <span>
                                {candidate.fullName}
                                <span className="muted small"> · {ROLE_LABEL[candidate.role]}</span>
                              </span>
                              <span className="muted small">
                                {candidate.id === member.id
                                  ? 'זהו האדם שמועבר'
                                  : candidate.hasDirectReports
                                    ? 'כבר מפקד על יחידה משלו'
                                    : candidate.unitPath}
                              </span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              )}
              <span className="field__hint">
                {member.fullName} מפקד על יחידה - יש לבחור מי יורש את הכפיפים שלו לפני שהמעבר יחול.
              </span>
            </div>
          )}
        </>
      )}

      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy || (canMove && eligible.loading)}>
          {busy ? 'שומר...' : 'שמירה'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          ביטול
        </button>
      </div>
    </form>
  );
}
