import { describe, expect, it } from 'vitest';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';
import { caveatSurface } from './caveat-surface';

const TIMEOUT =
  'The model that writes the answer was not reachable: the reasoning endpoint failed (APITimeoutError: Request timed out.).';
const IDENTITY =
  'This answer was produced as analyst@example.com and covers only the data that identity is granted. Unity Catalog row filters and column masks apply without reporting themselves.';
const COVERAGE = 'Only 19 of the 30 calendar days have records.';

describe('how loudly a Keep in mind bullet is drawn', () => {
  it('treats an endpoint timeout as a failure, not a quiet note', () => {
    expect(caveatSurface(TIMEOUT)).toBe('failure');
    expect(caveatSurface(`${DEGRADED_ANSWER_MARKER} the run stopped after 2 steps.`)).toBe('failure');
  });

  it('treats identity and grants as a secondary note', () => {
    expect(caveatSurface(IDENTITY)).toBe('note');
  });

  it('leaves an ordinary qualification as an ordinary bullet', () => {
    expect(caveatSurface(COVERAGE)).toBe('ordinary');
  });
});
