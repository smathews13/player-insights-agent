/**
 * A complete backend-authored dashboard rendered as an isolated document.
 *
 * The HTML is opaque and untrusted. It never enters the app DOM and receives no
 * sandbox permissions; the exact same bytes are offered for download.
 */
import './styles/dashboard.css';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui';
import { PiaAvatar } from './PiaMark';
import { DashboardExportButton } from './ExportMenu';
import type { Dashboard } from '../../shared/dashboard-contract';

export function DashboardCard({ dashboard }: { dashboard: Dashboard }) {
  const caveats = [
    ...(dashboard.truncated ? ['This dashboard was truncated and may be incomplete.'] : []),
    ...(dashboard.caveats ?? []),
  ];
  const caveatOccurrences = new Map<string, number>();
  const caveatRows = caveats.map((caveat) => {
    const occurrence = caveatOccurrences.get(caveat) ?? 0;
    caveatOccurrences.set(caveat, occurrence + 1);
    return { caveat, key: `${caveat}:${occurrence}` };
  });

  return (
    <Card className="answer-card dashboard-card">
      <CardHeader>
        <div className="dashboard-card-head">
          <div className="agent-avatar">
            <PiaAvatar size={32} />
          </div>
          <div className="space-y-1">
            <Badge variant="outline" className="provenance-chip" data-tone="live">
              Dashboard
            </Badge>
            <CardTitle>{dashboard.title}</CardTitle>
            {dashboard.generatedAt ? <CardDescription>Generated {dashboard.generatedAt}</CardDescription> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="dashboard-card-content">
        {caveats.length ? (
          <div className="dashboard-caveats" role="note" aria-label="Dashboard caveats">
            <strong>Keep in mind</strong>
            <ul>
              {caveatRows.map(({ caveat, key }) => (
                <li key={key}>{caveat}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="dashboard-frame-shell">
          <iframe
            className="dashboard-frame"
            title={dashboard.title}
            sandbox=""
            srcDoc={dashboard.html}
            referrerPolicy="no-referrer"
          />
        </div>
        <div className="dashboard-actions">
          <DashboardExportButton dashboard={dashboard} />
        </div>
      </CardContent>
    </Card>
  );
}
