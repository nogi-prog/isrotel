import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ManagerOption, type ManagersResponse, type Role } from '../lib/api';
import { PARENT_ROLE, ROLE_LABEL, ROLE_LABEL_LONG, roleRank } from '../lib/he';
import { Alert } from './ui';

/** מצב טעינת המפקדים האפשריים - נדרש גם לרכיב וגם לבדיקת התקינות של הטופס. */
export interface EligibleManagers {
  managers: ManagerOption[];
  /** הדרגים שמותר לבחור מהם. יכולים להיות כמה, למשל רמ״ד ואופרטיבי לר״צ. */
  parentRoles: Role[];
  /** הרשמה בלי מפקד: ראש השרשרת, או שאין עוד מפקד מאושר מהדרג שמעל. */
  rootRegistration: boolean;
  /** ההסבר של השרת להרשמה בלי מפקד. */
  note: string;
  loading: boolean;
  error: string;
}

/**
 * טעינת המפקדים שמותר לבחור בהרשמה בתפקיד `role`.
 * הרשימה נטענת פעם אחת לכל תפקיד והחיפוש נעשה בצד הלקוח, כדי לשמור על
 * התחושה של בחירה מיידית בלי בקשה על כל הקלדה.
 *
 * עד שהתשובה חוזרת מסתמכים על PARENT_ROLE - המראה של כלל השרת - כדי שלא
 * יהבהב בוחר מפקדים למי שנרשם כמפמ״ר.
 */
export function useEligibleManagers(role: Role): EligibleManagers {
  const mirroredParents = PARENT_ROLE[role] ?? [];
  const [state, setState] = useState<Omit<EligibleManagers, 'loading' | 'error'>>({
    managers: [],
    parentRoles: mirroredParents,
    rootRegistration: mirroredParents.length === 0,
    note: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const parents = PARENT_ROLE[role] ?? [];
    setLoading(true);
    setError('');
    setState({ managers: [], parentRoles: parents, rootRegistration: parents.length === 0, note: '' });

    void (async () => {
      try {
        const response = await api.get<ManagersResponse>(`/auth/managers?role=${role}`);
        if (cancelled) return;
        setState({
          // מוצגים מפקדים מכמה דרגים ברשימה אחת, ולכן ממוינים לפי מקומם בשרשרת.
          managers: [...response.managers].sort(
            (a, b) => roleRank(a.role) - roleRank(b.role) || a.fullName.localeCompare(b.fullName, 'he'),
          ),
          // אם השדה חסר בתשובה נופלים למראה המקומי של כלל השרת, כדי שהמסך לא יישבר.
          parentRoles: response.parentRoles ?? parents,
          rootRegistration: response.rootRegistration ?? parents.length === 0,
          note: response.note ?? '',
        });
      } catch {
        if (!cancelled) setError('לא ניתן לטעון את רשימת המפקדים');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [role]);

  return { ...state, loading, error };
}

/**
 * בחירת מפקד עם חיפוש חופשי.
 * מוצגים רק מפקדים מהדרג שמעל התפקיד שנבחר (חייל -> ר״צ -> רמ״ד/אופרטיבי -> רת״ח -> מפמ״ר),
 * וכשאין למי להיכנס תחתיו (ראש השרשרת, או שטרם אושר מפקד מהדרג שמעל) מוצג הסבר במקום בחירה.
 */
export function ManagerPicker({
  role,
  options,
  value,
  onChange,
  label = 'מי המפקד שלך?',
}: {
  role: Role;
  options: EligibleManagers;
  value: number | null;
  onChange: (managerId: number | null) => void;
  /** הטקסט שלפני שם הדרג, למשל "מי המפקד שלך?" בהרשמה מול "מפקד" בעריכת אדם אחר. */
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // מדלג על האיפוס בעליית הרכיב, כדי שערך התחלתי (למשל המפקד הנוכחי בעריכה) לא יימחק מיד.
  const mounted = useRef(false);

  const { managers, parentRoles, rootRegistration, note, loading, error } = options;

  // שינוי תפקיד מאפס את הבחירה, כי הדרג שמעל השתנה.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onChange(null);
    setQuery('');
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // סגירה בלחיצה מחוץ לרכיב.
  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const selected = useMemo(() => managers.find((manager) => manager.id === value) ?? null, [managers, value]);

  const filtered = useMemo(() => {
    const term = query.trim();
    if (!term) return managers;
    return managers.filter(
      (manager) => manager.fullName.includes(term) || (manager.unitName ?? '').includes(term),
    );
  }, [managers, query]);

  /** "רמ״ד" או "רמ״ד או אופרטיבי" - לפי מספר הדרגים שמותר לבחור מהם. */
  const parentLabel = parentRoles.map((parent) => ROLE_LABEL[parent]).join(' או ');

  if (rootRegistration) {
    return (
      <Alert kind="info">
        {note ||
          `${ROLE_LABEL_LONG[role]} נרשם בלי מפקד - אין מעליו מפקד מאושר במערכת. הרישום יאושר על ידי האופרטיבי.`}
      </Alert>
    );
  }

  return (
    <div className="field" ref={containerRef}>
      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{label} ({parentLabel})</span>

      {selected ? (
        <div className="combo__selected">
          <span>
            <strong>{selected.fullName}</strong>
            <span className="muted"> · {ROLE_LABEL[selected.role]}</span>
            {selected.unitName ? <span className="muted"> · {selected.unitName}</span> : null}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              onChange(null);
              setQuery('');
              setOpen(true);
            }}
          >
            שינוי
          </button>
        </div>
      ) : (
        <div className="combo">
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // גם לחיצה נוספת על שדה שכבר במיקוד פותחת את הרשימה מחדש.
            onClick={() => setOpen(true)}
            placeholder={loading ? 'טוען...' : `חיפוש לפי שם או שם יחידה`}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="manager-options"
          />

          {open && !loading && (
            <ul className="combo__list" id="manager-options" role="listbox">
              {filtered.length === 0 ? (
                <li className="combo__empty">
                  {managers.length === 0 ? `אין ${parentLabel} מאושרים במערכת` : 'לא נמצאו תוצאות'}
                </li>
              ) : (
                filtered.map((manager) => (
                  <li key={manager.id}>
                    <button
                      type="button"
                      className="combo__option"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        onChange(manager.id);
                        setQuery('');
                        setOpen(false);
                      }}
                    >
                      <span>
                        {manager.fullName}
                        {/* התפקיד מוצג תמיד, כי ברשימה אחת יכולים להיות כמה דרגים */}
                        <span className="muted small"> · {ROLE_LABEL[manager.role]}</span>
                      </span>
                      {manager.unitName && <span className="muted small">{manager.unitName}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      <span className="field__hint">
        {error || `ניתן לבחור ${parentLabel} בלבד — הדרג שמעל ${ROLE_LABEL[role]}.`}
      </span>
    </div>
  );
}
