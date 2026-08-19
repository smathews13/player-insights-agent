/**
 * What an administrator may turn off, and what the catalog says about the
 * tables behind it.
 *
 * Two cards on the Settings page, behind the experimental toggle, and mounted
 * only for an administrator. The server refuses the admin routes whatever is
 * drawn here, so hiding the panel is about not offering dead controls rather than
 * about the permission itself.
 *
 * Paths the app cannot stop (selection, screenshots, figures already on screen)
 * are not listed here. Listing them as status rows read as a monitoring surface
 * without adding a control; they remain in the shared registry so the contract
 * stays honest about what the build cannot enforce.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Switch } from './ui';
import {
  controllablePaths,
  egressAllowed,
  type EgressChannel,
  type EgressClassificationPayload,
  type EgressControls,
  type EgressControlsPayload,
  type EgressPath,
} from '../../shared/egress-contract';
import { adoptEgressControls, egressControlsSnapshot } from './egress-policy';
import {
  classificationFacts,
  classificationPill,
  CLASSIFICATION_CAPTION,
  controlAccessibleName,
  CONTROL_WRITE_FAILED,
  enforcementPill,
  pathMeta,
  type Pill,
} from './egress-panel';

/** The separator, written once. The design allows this one and no em dash. */
function Facts({ facts }: { facts: readonly string[] }) {
  if (facts.length === 0) return null;
  return <p className="egress-facts">{facts.join(' · ')}</p>;
}

function PillChip({ pill }: { pill: Pill }) {
  return <span className={`ast-pill ast-pill--${pill.tone}`}>{pill.label}</span>;
}

/* ── Controls ──────────────────────────────────────────────────────────────── */

function ControlRow({
  path,
  allowed,
  failed,
  onChange,
}: {
  path: EgressPath;
  allowed: boolean;
  failed: boolean;
  onChange: (allowed: boolean) => void;
}) {
  return (<div className="settings-row egress-row">
      <div className="egress-row-body">
        <p className="settings-row-label">
          {path.label} <PillChip pill={enforcementPill(path)} />
          {failed ? <span className="ast-pill ast-pill--neg">{CONTROL_WRITE_FAILED}</span> : null}
        </p>
        <Facts facts={pathMeta(path)} />
      </div>
      <Switch
        checked={allowed}
        onCheckedChange={onChange}
        aria-label={controlAccessibleName(path)}
      />
    </div>
  );
}

/* ── The panel ─────────────────────────────────────────────────────────────── */

export function EgressPanel() {
  const [controls, setControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [stored, setStored] = useState(false);
  const [failed, setFailed] = useState<EgressChannel | null>(null);
  const [classification, setClassification] = useState<EgressClassificationPayload | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/controls', { headers: { Accept: 'application/json' } });
        if (!response.ok || !live) return;
        const payload = (await response.json()) as EgressControlsPayload;
        if (!live || !payload?.controls) return;
        setControls(payload.controls);
        setStored(Boolean(payload.stored));
        adoptEgressControls(payload.controls);
      } catch {
        // The snapshot the panel opened with stands. It is the build's defaults,
        // and `stored` stays false, which is what the card says.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/admin/classification', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || !live) return;
        const payload = (await response.json()) as EgressClassificationPayload;
        if (live) setClassification(payload);
      } catch {
        // Left null. The card renders nothing rather than claiming the catalog is
        // silent, which is the distinction the whole classification design turns on.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const move = useCallback(async (channel: EgressChannel, allowed: boolean) => {
    // Moved on screen first. A switch that waits for a round trip before it moves
    // reads as an unresponsive control, and the failure is reported beside it.
    const optimistic = { ...controls, [channel]: allowed };
    setControls(optimistic);
    setFailed(null);
    try {
      const response = await fetch('/api/egress/admin/controls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, allowed }),
      });
      if (!response.ok) {
        setControls(controls);
        setFailed(channel);
        return;
      }
      const payload = (await response.json()) as EgressControlsPayload;
      if (payload?.controls) {
        setControls(payload.controls);
        setStored(Boolean(payload.stored));
        adoptEgressControls(payload.controls);
      }
    } catch {
      setControls(controls);
      setFailed(channel);
    }
  }, [controls]);

  const paths = controllablePaths();

  return (<>
      <Card>
        <CardHeader>
          <CardTitle>What may leave</CardTitle>
          <CardDescription>
            {stored ? 'This deployment' : 'Build defaults'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {paths.map((path) => (
            <ControlRow
              key={path.channel}
              path={path}
              allowed={egressAllowed(controls, path.channel)}
              failed={failed === path.channel}
              onChange={(allowed) => void move(path.channel, allowed)}
            />
          ))}
        </CardContent>
      </Card>

      {classification ? (
        <Card>
          <CardHeader>
            <CardTitle>What the catalog says</CardTitle>
            <CardDescription>{CLASSIFICATION_CAPTION}</CardDescription>
          </CardHeader>
          <CardContent>
            {classification.blocked ? (
              <p className="egress-facts">{classification.blocked}</p>
            ) : (
              classification.tables.map((table) => (
                <div key={table.table} className="settings-row egress-row">
                  <div className="egress-row-body">
                    <p className="settings-row-label">
                      <span className="ast-mono">{table.table}</span>{' '}
                      <PillChip pill={classificationPill(table)} />
                    </p>
                    <Facts facts={classificationFacts(table)} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
