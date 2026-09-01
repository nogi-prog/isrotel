import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type CurrentUser } from './api';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (token: string, user: CurrentUser) => void;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const response = await api.get<{ user: CurrentUser }>('/auth/me');
      setUser(response.user);
    } catch {
      // טוקן פג תוקף או לא תקין - מנקים אותו ומחזירים למסך ההתחברות.
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn: (token, nextUser) => {
        setToken(token);
        setUser(nextUser);
        setLoading(false);
      },
      signOut: () => {
        setToken(null);
        setUser(null);
      },
      refresh,
    }),
    [user, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/** המשתמש המחובר, כשידוע שהוא קיים (בתוך מסכים מוגנים). */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error('אין משתמש מחובר');
  return user;
}
