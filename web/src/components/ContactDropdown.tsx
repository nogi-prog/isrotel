import { useEffect, useRef, useState } from 'react';

/** "צרו קשר" בסרגל הניווט - תפריט נפתח קטן, לא מסך נפרד. */
export function ContactDropdown() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className="combo topbar__contact" ref={containerRef}>
      <button
        type="button"
        className="btn btn--sm btn--ghost topbar__icon-btn"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="צרו קשר"
        title="צרו קשר"
      >
        <span aria-hidden>☎️</span>
      </button>

      {open && (
        <div className="combo__list topbar__contact-panel" role="menu">
          <div className="profile-facts__item">
            <span className="profile-facts__label">איש קשר</span>
            <span className="profile-facts__value">נעם גלעד</span>
          </div>
          <div className="profile-facts__item">
            <span className="profile-facts__label">טלפון</span>
            <a className="profile-facts__value" href="tel:0549924243">
              054-9924243
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
