import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ACCESS_GUIDE_DOWNLOAD_PATH, ACCESS_GUIDE_FILENAME, loadAccessGuideAvailability } from './access-guide-api';

export function AccessGuideDownloadRow({ available }: { available: boolean }) {
  if (!available) return null;
  return (
    <div className="access-guide-download-row">
      <div>
        <p className="access-guide-download-title">Access points and operating guide</p>
        <p className="access-guide-download-description">
          Reference for access points, roles, sessions, and operating controls.
        </p>
      </div>
      <a className="access-guide-download-button" href={ACCESS_GUIDE_DOWNLOAD_PATH} download={ACCESS_GUIDE_FILENAME}>
        <Download aria-hidden="true" />
        Download PDF
      </a>
    </div>
  );
}

export function AccessGuideDownload() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let current = true;
    void loadAccessGuideAvailability().then((next) => {
      if (current) setAvailable(next);
    });
    return () => {
      current = false;
    };
  }, []);

  return <AccessGuideDownloadRow available={available} />;
}
