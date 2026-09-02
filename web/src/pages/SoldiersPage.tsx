import { Fragment, useMemo, useRef, useState, useEffect } from 'react';
import {
  api,
  type Diet,
  type Gender,
  type Role,
  type TeamMember,
  type UserSearchResult,
  type WorkerType,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage, useApi } from '../lib/useApi';
import {
  DIET_LABEL,
  GENDER_LABEL_SINGULAR,
  NO_ALLERGIES,
  ROLE_LABEL,
  ROLE_ORDER,
  USER_STATUS_LABEL,
  WORKER_TYPE_LABEL,
} from '../lib/he';
import { Alert, Badge, Card, Empty, Field, Loading, Stat, StatusBadge } from '../components/ui';
import { ManagerPicker, useEligibleManagers } from '../components/ManagerPicker';

const EDIT_COLUMN_COUNT = 9;

/** אותה בדיקה כמו בשרת (lib/phone.ts) - כדי לתת משוב מיידי בלי סיבוב לשרת. */
const PHONE_PATTERN = /^0\d{8,9}$/;
function isPhoneValid(value: string): boolean {
  return PHONE_PATTERN.test(value.trim().replace(/[\s-]/g, ''));
}

/** מפמ״ר הוא ראש השרשרת ולאופרטיבי עמדה קבועה - אף אחד מהם אינו ניתן להעברה. */
function isMovableRole(role: Role): boolean {
  return role !== 'to' && role !== 'ceo';
}

/**
 * מסך "חיילים": רשימת הכפיפים של המשתמש (לאופרטיבי - כל חיילי החברה), עם
 * חיפוש ועריכה. הוצא ממסך הפרופיל לעמוד נפרד, כדי שהפרופיל יישאר על הפרטים
 * האישיים בלבד.
 */
export function SoldiersPage() {
  const { user } = useAuth();
  const team = useApi<{ team: TeamMember[] }>(user?.isManager ? '/users/my-team' : null);
  const [teamSearch, setTeamSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [genderFilter, setGenderFilter] = useState<Gender | 'all'>('all');
  const [dietFilter, setDietFilter] = useState<Diet | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [unitFilter, setUnitFilter] = useState<string>('all');
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const canAddExWorkers = user?.role === 'team_leader';

  const teamList = team.data?.team ?? [];

  // רק תפקידים שבאמת מופיעים ברשימה - אין טעם להציע לסנן לפי תפקיד שאין בו אף אחד.
  const availableRoles = useMemo(
    () => ROLE_ORDER.filter((role) => teamList.some((member) => member.role === role)),
    [teamList],
  );

  // אותו ערך יחידה בדיוק כמו שהוא מוצג בעמודת "יחידה" בטבלה, כדי שהסינון יתאים למה שרואים.
  const NO_UNIT = 'ללא יחידה';
  const availableUnits = useMemo(() => {
    const set = new Set(teamList.map((member) => member.unitPath || NO_UNIT));
    return [...set].sort((a, b) => a.localeCompare(b, 'he'));
  }, [teamList]);

  const filtersActive =
    teamSearch.trim() !== '' ||
    roleFilter !== 'all' ||
    genderFilter !== 'all' ||
    dietFilter !== 'all' ||
    statusFilter !== 'all' ||
    unitFilter !== 'all';

  const resetFilters = () => {
    setTeamSearch('');
    setRoleFilter('all');
    setGenderFilter('all');
    setDietFilter('all');
    setStatusFilter('all');
    setUnitFilter('all');
  };

  const teamFiltered = useMemo(() => {
    const term = teamSearch.trim();
    return teamList.filter((member) => {
      if (roleFilter !== 'all' && member.role !== roleFilter) return false;
      if (genderFilter !== 'all' && member.gender !== genderFilter) return false;
      if (dietFilter !== 'all' && member.diet !== dietFilter) return false;
      if (statusFilter !== 'all' && member.status !== statusFilter) return false;
      if (unitFilter !== 'all' && (member.unitPath || NO_UNIT) !== unitFilter) return false;
      if (
        term &&
        !(member.fullName.includes(term) || member.companyId.includes(term) || member.unitPath.includes(term))
      ) {
        return false;
      }
      return true;
    });
  }, [teamList, teamSearch, roleFilter, genderFilter, dietFilter, statusFilter, unitFilter]);

  // חיילים-לשעבר (מושאלים ומילואים) מוצגים בסעיפים נפרדים מחיילים רגילים.
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>חיילים</h1>
          <p>{user.isTripOrganizer ? 'חיילים' : 'החיילים שלך'}</p>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <Stat value={teamStats.total} label={user.isTripOrganizer ? 'סה״כ אנשים בחברה' : 'סה״כ אנשים'} />
        <Stat value={teamStats.pending} label="ממתינים לאישור רישום" />
        <Stat value={teamStats.male} label="בנים" />
        <Stat value={teamStats.female} label="בנות" />
        <Stat value={teamStats.special} label="תזונה מיוחדת" />
      </div>

      <Card title="חיילים">
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

            <div className="field-row">
              {availableRoles.length > 1 && (
                <Field label="תפקיד">
                  <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as Role | 'all')}>
                    <option value="all">הכל</option>
                    {availableRoles.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <Field label="מין">
                <select value={genderFilter} onChange={(event) => setGenderFilter(event.target.value as Gender | 'all')}>
                  <option value="all">הכל</option>
                  <option value="male">{GENDER_LABEL_SINGULAR.male}</option>
                  <option value="female">{GENDER_LABEL_SINGULAR.female}</option>
                </select>
              </Field>

              <Field label="תזונה">
                <select value={dietFilter} onChange={(event) => setDietFilter(event.target.value as Diet | 'all')}>
                  <option value="all">הכל</option>
                  {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
                    <option key={option} value={option}>
                      {DIET_LABEL[option]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="מצב">
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as 'all' | 'pending' | 'approved' | 'rejected')}
                >
                  <option value="all">הכל</option>
                  <option value="approved">{USER_STATUS_LABEL.approved}</option>
                  <option value="pending">{USER_STATUS_LABEL.pending}</option>
                  <option value="rejected">{USER_STATUS_LABEL.rejected}</option>
                </select>
              </Field>

              {availableUnits.length > 1 && (
                <Field label="יחידה">
                  <select value={unitFilter} onChange={(event) => setUnitFilter(event.target.value)}>
                    <option value="all">הכל</option>
                    {availableUnits.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>

            {filtersActive && (
              <div className="row" style={{ marginBottom: '0.75rem' }}>
                <Badge kind="info">{teamFiltered.length} מתוך {teamList.length}</Badge>
                <button type="button" className="btn btn--sm btn--ghost" onClick={resetFilters}>
                  נקה סינון
                </button>
              </div>
            )}

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
          title="חיילים מושאלים (הצ״ח)"
          actions={
            canAddExWorkers ? <AddExWorkerToggle workerType="borrowed" onAdded={() => void team.reload()} /> : undefined
          }
        >
          {teamBorrowed.length === 0 ? (
            <Empty>{filtersActive ? 'לא נמצאו תוצאות.' : 'אין חיילים מושאלים כרגע.'}</Empty>
          ) : (
            <TeamTable members={teamBorrowed} editingId={editingMemberId} setEditingId={setEditingMemberId} onSaved={onTeamSaved} />
          )}
        </Card>
      )}

      {(canAddExWorkers || teamReserve.length > 0) && (
        <Card
          title="אנשי מילואים"
          actions={
            canAddExWorkers ? <AddExWorkerToggle workerType="reserve" onAdded={() => void team.reload()} /> : undefined
          }
        >
          {teamReserve.length === 0 ? (
            <Empty>{filtersActive ? 'לא נמצאו תוצאות.' : 'אין אנשי מילואים כרגע.'}</Empty>
          ) : (
            <TeamTable members={teamReserve} editingId={editingMemberId} setEditingId={setEditingMemberId} onSaved={onTeamSaved} />
          )}
        </Card>
      )}
    </>
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

/** כפתור שפותח וסוגר את טופס הוספת חייל-לשעבר, בלי להזדקק ל-state בעמוד עצמו. */
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
      {workerType === 'borrowed' ? 'הוספת חייל מושאל' : 'הוספת איש מילואים'}
    </button>
  );
}

/**
 * הוספת חייל-לשעבר (מושאל או מילואים) ישירות לצוות - ראו POST
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
      setError(errorMessage(caught, 'הוספת החייל נכשלה'));
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
  const [phone, setPhone] = useState(member.phone ?? '');
  const [allergies, setAllergies] = useState(member.allergies === NO_ALLERGIES ? '' : member.allergies);
  const [workerType, setWorkerType] = useState<WorkerType>(member.workerType);
  const [borrowedFrom, setBorrowedFrom] = useState(member.borrowedFrom ?? '');
  const [borrowedMission, setBorrowedMission] = useState(member.borrowedMission ?? '');
  const [toManagerId, setToManagerId] = useState<number | null>(member.managerId);
  const [successorQuery, setSuccessorQuery] = useState('');
  const [successorResults, setSuccessorResults] = useState<UserSearchResult[]>([]);
  const [successor, setSuccessor] = useState<UserSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // מסומן אחרי ניסיון שמירה - מציג שדות חובה ריקים באדום (ראו Field).
  const [attempted, setAttempted] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isManager = member.role !== 'employee';
  const isEmployee = member.role === 'employee';
  const isBorrowed = isEmployee && workerType === 'borrowed';
  const canMove = isMovableRole(member.role);
  const eligible = useEligibleManagers(member.role);

  const firstNameInvalid = attempted && firstName.trim().length < 2;
  const lastNameInvalid = attempted && lastName.trim().length < 2;
  const phoneInvalid = attempted && !isPhoneValid(phone);
  const unitNameInvalid = attempted && isManager && !unitName.trim();
  const borrowedFromInvalid = attempted && isBorrowed && !borrowedFrom.trim();
  const borrowedMissionInvalid = attempted && isBorrowed && !borrowedMission.trim();

  // מעבר לעריכת אדם אחר מאפס את הטופס לערכים שלו.
  useEffect(() => {
    setFirstName(member.firstName);
    setLastName(member.lastName);
    setGender(member.gender);
    setDiet(member.diet);
    setUnitName(member.unitName ?? '');
    setPhone(member.phone ?? '');
    setAllergies(member.allergies === NO_ALLERGIES ? '' : member.allergies);
    setWorkerType(member.workerType);
    setBorrowedFrom(member.borrowedFrom ?? '');
    setBorrowedMission(member.borrowedMission ?? '');
    setToManagerId(member.managerId);
    setSuccessor(null);
    setSuccessorQuery('');
    setError('');
    setSuccess('');
    setAttempted(false);
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
    setAttempted(true);

    if (firstNameInvalid || lastNameInvalid || phoneInvalid || unitNameInvalid) {
      setError('יש למלא את כל השדות המסומנים באדום');
      return;
    }
    if (isBorrowed && (borrowedFromInvalid || borrowedMissionInvalid)) {
      setError('לחייל מושאל (הצ״ח) חובה למלא מאיפה הושאל ומהי המשימה');
      return;
    }
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
        phone,
        allergies: allergies.trim() || NO_ALLERGIES,
        ...(isManager ? { unitName } : {}),
        ...(isEmployee ? { workerType } : {}),
        ...(isBorrowed ? { borrowedFrom, borrowedMission } : {}),
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
        <Field label="שם פרטי" invalid={firstNameInvalid}>
          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required autoFocus />
        </Field>
        <Field label="שם משפחה" invalid={lastNameInvalid}>
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

        <Field label="טלפון" hint="לדוגמה 0501234567" invalid={phoneInvalid}>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            autoComplete="tel"
            placeholder="0501234567"
            required
          />
        </Field>
      </div>

      <div className="field-row">
        <Field label="העדפת תזונה">
          <select value={diet} onChange={(event) => setDiet(event.target.value as Diet)}>
            {(['all', 'vegetarian', 'vegan'] as Diet[]).map((option) => (
              <option key={option} value={option}>
                {DIET_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="אלרגיות" hint={`לא חובה - ברירת המחדל היא "${NO_ALLERGIES}"`}>
          <input value={allergies} onChange={(event) => setAllergies(event.target.value)} placeholder={NO_ALLERGIES} />
        </Field>
      </div>

      {isManager && (
        <Field label="שם היחידה שבפיקודו" invalid={unitNameInvalid}>
          <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
        </Field>
      )}

      {isEmployee && (
        <>
          <Field label="סוג חייל">
            <select value={workerType} onChange={(event) => setWorkerType(event.target.value as WorkerType)}>
              {(['regular', 'borrowed', 'reserve'] as WorkerType[]).map((option) => (
                <option key={option} value={option}>
                  {WORKER_TYPE_LABEL[option]}
                </option>
              ))}
            </select>
          </Field>

          {workerType === 'borrowed' && (
            <div className="field-row">
              <Field label="מאיפה הושאל" invalid={borrowedFromInvalid}>
                <input value={borrowedFrom} onChange={(event) => setBorrowedFrom(event.target.value)} required />
              </Field>
              <Field label="המשימה שבשבילה מבקשים את ההשאלה" invalid={borrowedMissionInvalid}>
                <input value={borrowedMission} onChange={(event) => setBorrowedMission(event.target.value)} required />
              </Field>
            </div>
          )}
        </>
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
