import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * טעינת נתונים מה־API עם מצבי טעינה ושגיאה.
 * `path` מחרוזת ריקה או null משביתה את הטעינה.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path != null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setData(await api.get<T>(path));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'שגיאה בטעינת הנתונים');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}

/** ממיר שגיאה שנתפסה להודעה בעברית. */
export function errorMessage(caught: unknown, fallback = 'הפעולה נכשלה'): string {
  return caught instanceof ApiError ? caught.message : fallback;
}
