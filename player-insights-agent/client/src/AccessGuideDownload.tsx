import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { ACCESS_GUIDE_DOWNLOAD_PATH, ACCESS_GUIDE_FILENAME, loadAccessGuideAvailability } from './access-guide-api';
import { ACCESS_GUIDE_SETTINGS_TARGET } from './settings-deep-link';

export function AccessGuideDownloadRow({ available, targeted = false }: { available: boolean; targeted?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!available || !targeted) return;
    row.current?.scrollIntoView({ block: 'nearest' });
    link.current?.focus({ preventScroll: true });
  }, [available, targeted]);

  if (!available) return null;
  return (
    <div
      ref={row}
      id={ACCESS_GUIDE_SETTINGS_TARGET}
      className="access-guide-download-row"
      data-settings-target={ACCESS_GUIDE_SETTINGS_TARGET}
    >
      <div>
        <p className="access-guide-download-title">Access points and operating guide</p>
        <p className="access-guide-download-description">
          Reference for access points, roles, sessions, and operating controls.
        </p>
      </div>
      <a
        ref={link}
        className="access-guide-download-button"
        href={ACCESS_GUIDE_DOWNLOAD_PATH}
        download={ACCESS_GUIDE_FILENAME}
      >
        <Download aria-hidden="true" />
        Download PDF
      </a>
    </div>
  );
}

export function AccessGuideDownload({
  focusTarget,
  initialAvailable,
}: {
  focusTarget?: string | null;
  initialAvailable?: boolean;
}) {
  const [available, setAvailable] = useState(initialAvailable ?? false);

  useEffect(() => {
    if (initialAvailable !== undefined) return;
    let current = true;
    void loadAccessGuideAvailability().then((next) => {
      if (current) setAvailable(next);
    });
    return () => {
      current = false;
    };
  }, [initialAvailable]);

  return <AccessGuideDownloadRow available={available} targeted={focusTarget === ACCESS_GUIDE_SETTINGS_TARGET} />;
}
