import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : systemTheme();
}

/**
 * מצב כהה/בהיר נבחר ידנית - עוקף את העדפת המערכת (ראו :root[data-theme] ב-styles.css).
 * הבחירה נשמרת ב-localStorage; טעינה ראשונה קוראת אותה מוקדם (ראו התסריט
 * המוטבע ב-index.html) כדי שלא יהבהב הצבע הלא נכון לפני שהרכיב עולה.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost topbar__icon-btn"
      onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
      aria-label={theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'}
      title={theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
    >
      <span aria-hidden>{theme === 'dark' ? '☀️' : '🌙'}</span>
    </button>
  );
}
