import { Link } from 'react-router-dom';
import { api, type Notification } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatDateTime } from '../lib/he';
import { Alert, Card, Empty, Loading } from '../components/ui';

export function NotificationsPage() {
  const { data, loading, error, reload } = useApi<{ unread: number; notifications: Notification[] }>(
    '/notifications',
  );

  const markAll = async () => {
    await api.post('/notifications/read-all');
    await reload();
  };

  if (loading) return <Loading />;

  const notifications = data?.notifications ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>התראות</h1>
          <p>{data?.unread ? `${data.unread} התראות שלא נקראו` : 'הכל נקרא'}</p>
        </div>
        {(data?.unread ?? 0) > 0 && (
          <button type="button" className="btn btn--sm" onClick={() => void markAll()}>
            סמן הכל כנקרא
          </button>
        )}
      </div>

      <Alert kind="error">{error}</Alert>

      {notifications.length === 0 ? (
        <Empty>אין התראות.</Empty>
      ) : (
        <Card>
          <div className="stack">
            {notifications.map((notification) => (
              <div
                key={notification.id}
                className={`notification${notification.read ? '' : ' notification--unread'}`}
              >
                <div className="row row--between">
                  <span className="notification__title">{notification.title}</span>
                  <span className="muted small">{formatDateTime(notification.createdAt)}</span>
                </div>
                {notification.body && <div className="small">{notification.body}</div>}
                {notification.link && (
                  <Link to={notification.link} className="small">
                    מעבר לעמוד
                  </Link>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
