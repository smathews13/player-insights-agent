import { describe, expect, it, vi } from 'vitest';

import { normalizeReport, REPORT_SCHEMA_VERSION } from './report-contract';

describe('report contract versioning', () => {
  const report = {
    title: 'Player report',
    sections: [{ heading: 'Reach', body: 'Grounded result.' }],
  };

  it('accepts legacy unversioned reports as version one', () => {
    expect(normalizeReport(report)?.schema_version).toBe(REPORT_SCHEMA_VERSION);
  });

  it('rejects an unknown version instead of reshaping it as version one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeReport({ ...report, schema_version: 'pia.report/2' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[report] Unsupported report schema version.',
      expect.objectContaining({ expected: REPORT_SCHEMA_VERSION, received: 'pia.report/2' })
    );
    warn.mockRestore();
  });
});
