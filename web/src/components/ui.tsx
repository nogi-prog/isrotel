import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** קישור חזרה למסך הגלישה הכללי - לכל תת-מסך של גלישה (אוטובוסים, לינה, אישורים וכו'). */
export function BackToTrip({ tripId }: { tripId: string | number }) {
  return (
    <Link to={`/trips/${tripId}`} className="btn btn--sm">
      חזרה לגלישה
    </Link>
  );
}

export function Loading({ label = 'טוען...' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'error' | 'success' | 'warn' | 'info';
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

/**
 * כל כרטיס ניתן לקיפול כברירת מחדל - כפתור הסתרה קטן בכותרת, שימושי במסכים
 * עם הרבה כרטיסים זה מתחת לזה (למשל מסך הגלישה של האופרטיבי), כשקשה לעבוד
 * כשהכול פתוח בבת אחת. `collapsible={false}` מבטל את זה לכרטיס ספציפי.
 * הקיפול מוסתר ב-CSS בלבד (לא מפורק מה-DOM) כדי לא לאבד מצב פנימי של
 * טפסים/רכיבים בתוך הכרטיס כשמרחיבים אותו בחזרה.
 */
export function Card({
  title,
  actions,
  children,
  className = '',
  collapsible = true,
  defaultCollapsed = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);

  return (
    <section className={`card ${className}`}>
      {(title || actions || collapsible) && (
        <div className="card__head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {(actions || collapsible) && (
            <div className="row">
              {actions}
              {collapsible && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed((value) => !value)}
                >
                  {collapsed ? 'הצגה' : 'הסתרה'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div style={collapsed ? { display: 'none' } : undefined} aria-hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Badge({
  kind = 'default',
  children,
}: {
  kind?: 'default' | 'ok' | 'warn' | 'danger' | 'info';
  children: ReactNode;
}) {
  const suffix = kind === 'default' ? '' : ` badge--${kind}`;
  return <span className={`badge${suffix}`}>{children}</span>;
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

/** מציג תגית מצב לפי מפתח מילון. */
export function StatusBadge({ status, labels }: { status: string; labels: Record<string, string> }) {
  const kind =
    status === 'approved' || status === 'open'
      ? 'ok'
      : status === 'pending' || status === 'draft'
        ? 'warn'
        : status === 'rejected' || status === 'cancelled'
          ? 'danger'
          : 'default';
  return <Badge kind={kind}>{labels[status] ?? status}</Badge>;
}
