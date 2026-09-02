import { useRef } from 'react';
import { Field } from './ui';

/** yyyy-mm-dd (ערך ה-input) -> dd/mm/yyyy לתצוגה, בלי תלות בלוקאל של הדפדפן. */
function toDisplay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

const supportsShowPicker =
  typeof window !== 'undefined' && typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

/**
 * שדה תאריך שמציג תמיד dd/mm/yyyy, בלי קשר לאזור/שפת הדפדפן - קלט
 * type="date" רגיל מציג את הפורמט לפי הגדרות המערכת של המשתמש, שיכולות
 * להיות mm/dd/yyyy. הפתרון: input טקסט לתצוגה בפורמט הקבוע שלנו, מעליו
 * input[type=date] מוסתר (אך פעיל) שנפתח דרך showPicker() - כך מקבלים גם
 * את לוח השנה המובנה של הדפדפן וגם תצוגה עקבית.
 * בדפדפן שאינו תומך ב-showPicker (נדיר כיום) נופלים חזרה לקלט תאריך רגיל.
 */
export function DateField({
  value,
  onChange,
  label,
  hint,
  required,
  invalid,
  min,
}: {
  value: string;
  onChange: (iso: string) => void;
  label: string;
  hint?: string;
  required?: boolean;
  invalid?: boolean;
  min?: string;
}) {
  const nativeRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = nativeRef.current;
    if (!el) return;
    if (supportsShowPicker) {
      try {
        el.showPicker();
        return;
      } catch {
        // נופל לפוקוס רגיל למטה
      }
    }
    el.focus();
  };

  if (!supportsShowPicker) {
    return (
      <Field label={label} hint={hint} invalid={invalid}>
        <input type="date" value={value} onChange={(event) => onChange(event.target.value)} required={required} min={min} />
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint} invalid={invalid}>
      <div className="date-field">
        <input
          type="text"
          className="date-field__display"
          value={toDisplay(value)}
          placeholder="dd/mm/yyyy"
          readOnly
          onClick={openPicker}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPicker();
            }
          }}
        />
        <button type="button" className="date-field__btn" onClick={openPicker} aria-label="בחירת תאריך מלוח שנה" tabIndex={-1}>
          <span aria-hidden>📅</span>
        </button>
        <input
          ref={nativeRef}
          type="date"
          className="date-field__native"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          min={min}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
    </Field>
  );
}
