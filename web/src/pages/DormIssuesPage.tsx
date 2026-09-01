import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type DormIssue } from '../lib/api';
import { errorMessage, useApi } from '../lib/useApi';
import { ISSUE_KIND_LABEL } from '../lib/he';
import { Alert, BackToTrip, Badge, Card, Empty, Loading } from '../components/ui';

/**
 * בעיות שיבוץ לינה שדורשות טיפול מפקד:
 * מי שלא קיבל אף אחת מהעדפות השותפים שלו, ומי שלא נמצאה עבורו מיטה.
 * לכל בעיה מוצגות הצעות שיבוץ חלופיות עם אנשים מאותו מדור.
 */
export function DormIssuesPage() {
  const { tripId } = useParams();
  const { data, loading, error, reload } = useApi<{ issues: DormIssue[] }>(
    tripId ? `/trips/${tripId}/dorm-issues` : null,
  );
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  const resolve = async (issueId: number) => {
    setActionError('');
    setBusyId(issueId);
    try {
      await api.post(`/trips/${tripId}/dorm-issues/${issueId}/resolve`);
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Loading />;

  const issues = data?.issues ?? [];
  const open = issues.filter((issue) => !issue.resolved);
  const resolved = issues.filter((issue) => issue.resolved);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>בעיות שיבוץ לינה</h1>
          <p>אנשים שדורשים סידור חלופי מול המפקד שלהם</p>
        </div>
        <div className="row">
          {tripId && <BackToTrip tripId={tripId} />}
          <Badge kind={open.length > 0 ? 'danger' : 'ok'}>{open.length} פתוחות</Badge>
        </div>
      </div>

      <Alert kind="error">{error || actionError}</Alert>

      {issues.length === 0 && <Empty>אין בעיות שיבוץ. כל האנשים קיבלו חדר ולפחות אחת מההעדפות שלהם.</Empty>}

      {open.map((issue) => (
        <IssueCard key={issue.id} issue={issue} busy={busyId === issue.id} onResolve={() => void resolve(issue.id)} />
      ))}

      {resolved.length > 0 && (
        <Card title={`בעיות שטופלו (${resolved.length})`}>
          <ul className="name-list">
            {resolved.map((issue) => (
              <li key={issue.id}>
                <span>
                  {issue.user.fullName} · {ISSUE_KIND_LABEL[issue.kind]}
                </span>
                <Badge kind="ok">טופל</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function IssueCard({
  issue,
  busy,
  onResolve,
}: {
  issue: DormIssue;
  busy: boolean;
  onResolve: () => void;
}) {
  return (
    <Card
      title={
        <div>
          <h3>{issue.user.fullName}</h3>
          <div className="row small muted">
            <span>מספר אישי {issue.user.companyId}</span>
            <span>·</span>
            <span>{issue.cycleName}</span>
          </div>
        </div>
      }
      actions={
        <>
          <Badge kind={issue.kind === 'unassigned' ? 'danger' : 'warn'}>{ISSUE_KIND_LABEL[issue.kind]}</Badge>
          <button type="button" className="btn btn--sm btn--primary" onClick={onResolve} disabled={busy}>
            סמן כטופל
          </button>
        </>
      }
    >
      <Alert kind={issue.kind === 'unassigned' ? 'error' : 'warn'}>{issue.message}</Alert>

      <strong className="small">סידורים אפשריים עם אנשים מאותו מדור</strong>
      {issue.suggestions.length === 0 ? (
        <p className="muted small">לא נמצאו חלופות אוטומטיות. נדרש סידור ידני מול האופרטיבי.</p>
      ) : (
        <div className="stack" style={{ marginTop: '0.5rem' }}>
          {issue.suggestions.map((suggestion) => (
            <div key={suggestion.roomId} className="suggestion">
              <div className="row row--between">
                <strong>{suggestion.roomLabel}</strong>
                {suggestion.kind === 'free_bed' ? (
                  <Badge kind="ok">{suggestion.freeBeds} מיטות פנויות - אפשר להעביר</Badge>
                ) : (
                  <Badge kind="warn">חדר מלא - נדרשת החלפה</Badge>
                )}
              </div>
              <div className="muted">
                מאותו מדור בחדר:{' '}
                {suggestion.companions
                  .map((companion) => `${companion.name}${companion.teamName ? ` (${companion.teamName})` : ''}`)
                  .join(', ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
