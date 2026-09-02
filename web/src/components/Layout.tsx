import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api, type Notification } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/he';
import { NOTIFICATIONS_READ_EVENT } from '../lib/notifications';
import { ThemeToggle } from './ThemeToggle';
import { ContactDropdown } from './ContactDropdown';

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'navlink navlink--active' : 'navlink';
}

/** תמיד true/false בלי קשר לחישוב ההתאמה של NavLink - ראו השימוש למטה. */
function forcedNavClass(active: boolean): string {
  return active ? 'navlink navlink--active' : 'navlink';
}

/** ראשי התיבות של שם מלא, לתצוגה בבועת הפרופיל בסרגל - עד שתי אותיות. */
function initials(fullName: string): string {
  const letters = fullName
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean);
  return letters.slice(0, 2).join('');
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const [unread, setUnread] = useState(0);
  const location = useLocation();
  // מסכי גלישה בודד (/trips/:id וכל תת-הנתיבים שלו) שייכים ללשונית "הגלישות
  // שלי" (או "ניהול גלישות" לאופרטיבי) - היא צריכה להישאר מודגשת גם שם,
  // לא רק בנתיב הבית עצמו.
  const onTripPage = location.pathname.startsWith('/trips/');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.get<{ unread: number; notifications: Notification[] }>('/notifications');
        if (!cancelled) setUnread(response.unread);
      } catch {
        // התראות אינן קריטיות לתפקוד המסך.
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    // מסך ההתראות מסמן הכל כנקרא ברגע שהמשתמש רואה אותן - עדכון מיידי של
    // הספרה בסרגל, בלי לחכות לפולינג הבא.
    window.addEventListener(NOTIFICATIONS_READ_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_READ_EVENT, load);
    };
  }, []);

  if (!user) return null;

  return (
    <div className="app">
      <header className="topbar">
        <Link to={user.isTripOrganizer ? '/manage' : '/'} className="topbar__brand">
          <span aria-hidden>🏨</span>
          ישרוטל
        </Link>

        <nav className="topbar__nav">
          {/* לאופרטיבי יש כבר "ניהול גלישות" למטה - אין צורך בשתי לשוניות גלישות. */}
          {!user.isTripOrganizer && (
            <NavLink to="/" className={() => forcedNavClass(location.pathname === '/' || onTripPage)} end>
              הגלישות שלי
            </NavLink>
          )}
          {user.isManager && (
            <NavLink to="/approvals" className={navClass}>
              אישורים
            </NavLink>
          )}
          {user.isManager && (
            <NavLink to="/my-team" className={navClass}>
              חיילים
            </NavLink>
          )}
          {user.isTripOrganizer && (
            <NavLink
              to="/manage"
              className={() => forcedNavClass(location.pathname.startsWith('/manage') || onTripPage)}
            >
              ניהול גלישות
            </NavLink>
          )}
          {user.isTripOrganizer && (
            <NavLink to="/password-resets" className={navClass}>
              איפוס סיסמאות
            </NavLink>
          )}
        </nav>

        <div className="topbar__icons">
          <Link
            to="/notifications"
            className="btn btn--sm btn--ghost topbar__icon-btn"
            aria-label={unread > 0 ? `התראות - ${unread} שלא נקראו` : 'התראות'}
            title="התראות"
          >
            <span aria-hidden>🔔</span>
            {unread > 0 && (
              <span className="topbar__icon-badge" aria-hidden>
                {unread}
              </span>
            )}
          </Link>
          <ThemeToggle />
          <ContactDropdown />
        </div>

        <div className="topbar__user">
          <Link
            to="/profile"
            className="topbar__avatar"
            aria-label="פרופיל"
            title={`${user.fullName} · ${ROLE_LABEL[user.role]}${
              user.unitName ? ` · ${user.unitName}` : user.teamName ? ` · ${user.teamName}` : ''
            }`}
          >
            {initials(user.fullName)}
          </Link>
          <button type="button" className="btn btn--sm" onClick={signOut}>
            יציאה
          </button>
        </div>
      </header>

      <main className="content">{children}</main>
    </div>
  );
}
