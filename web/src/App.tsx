import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';
import { Layout } from './components/Layout';
import { DebugBar } from './components/DebugBar';
import { LoginPage } from './pages/LoginPage';
import { PendingApprovalPage } from './pages/PendingApprovalPage';
import { ChangePasswordRequiredPage } from './pages/ChangePasswordRequiredPage';
import { PasswordResetsPage } from './pages/PasswordResetsPage';
import { HomePage } from './pages/HomePage';
import { TripPage } from './pages/TripPage';
import { TripSigningPage } from './pages/TripSigningPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { ProfilePage } from './pages/ProfilePage';
import { BusesPage } from './pages/BusesPage';
import { DormsPage } from './pages/DormsPage';
import { DormIssuesPage } from './pages/DormIssuesPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrganizerTripsPage } from './pages/OrganizerTripsPage';
import { CreateTripPage } from './pages/CreateTripPage';
import { OrganizerTripPage } from './pages/OrganizerTripPage';
import { FoodPage } from './pages/FoodPage';

export function App() {
  return (
    <>
      {/* פאנל הפיתוח מוצג מעל כל מצב - גם לפני התחברות */}
      {import.meta.env.DEV && <DebugBar />}
      <AppRoutes />
    </>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <Loading label="טוען את המערכת..." />;
  if (!user) return <LoginPage />;

  // אחרי איפוס סיסמה על ידי האופרטיבי - חובה להחליף לפני המשך השימוש.
  if (user.mustChangePassword) return <ChangePasswordRequiredPage />;

  // עד שהמפקד מאשר את הרישום, אין גישה לשאר המערכת.
  if (user.status !== 'approved') return <PendingApprovalPage />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/trips/:tripId" element={<TripPage />} />
        <Route path="/trips/:tripId/signing" element={<TripSigningPage />} />
        <Route path="/trips/:tripId/approvals" element={<ApprovalsPage />} />
        <Route path="/trips/:tripId/buses" element={<BusesPage />} />
        <Route path="/trips/:tripId/dorms" element={<DormsPage />} />
        <Route path="/trips/:tripId/dorm-issues" element={<DormIssuesPage />} />
        <Route path="/trips/:tripId/food" element={<FoodPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        {/* "האנשים שלי" מוזג לתוך הפרופיל - הנתיב נשאר כהפניה כי התראות ישנות מצביעות אליו. */}
        <Route path="/my-team" element={<Navigate to="/profile" replace />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        {user.isTripOrganizer && (
          <>
            <Route path="/manage" element={<OrganizerTripsPage />} />
            {/* חייב להיות לפני /manage/:tripId כדי ש"new" לא ייחשב למזהה גלישה */}
            <Route path="/manage/new" element={<CreateTripPage />} />
            <Route path="/manage/:tripId" element={<OrganizerTripPage />} />
            <Route path="/password-resets" element={<PasswordResetsPage />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
