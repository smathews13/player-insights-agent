/**
 * The chart image download is off unless this deployment says otherwise.
 *
 * A separate file from `chart-read-only.test.ts` because the two guarantees are
 * separate and fail for separate reasons. That one says a figure cannot be typed
 * over; this one says a figure cannot be downloaded without the deployment having
 * permitted it. They meet at one object, and `toImage` moved out of that file's
 * keep-list into this one when the gate landed.
 *
 * ── WHY BOTH STATES ARE ASSERTED ──
 *
 * A gate that is always closed passes a test for the closed state and is not a
 * control, it is a deletion. The switch has to be able to come back on, because
 * an administrator who turns it on and sees no change would reasonably conclude
 * the whole panel is decorative.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { defaultEgressControls, egressPath } from '../../shared/egress-contract';

// 1.4 MB of browser code the config does not need. Same stub as the sibling file.
vi.mock('plotly.js-cartesian-dist-min', () => ({
  default: { react: vi.fn(), purge: vi.fn() },
  react: vi.fn(),
  purge: vi.fn(),
}));

const { FIGURE_CONFIG } = await import('./plotly-config');
const { adoptEgressControls, resetEgressPolicy } = await import('./egress-policy');

function removed(): string[] {
  return FIGURE_CONFIG.modeBarButtonsToRemove ?? [];
}

beforeEach(() => {
  resetEgressPolicy();
});

describe('the chart image download follows the deployment', () => {
  it('is gone before any answer has arrived from the server', () => {
    // The state during boot, and the one that matters most. A control that is
    // permissive until a fetch lands is a control a fast click walks through.
    expect(removed()).toContain('toImage');
  });

  it('is gone when the deployment does not permit it', () => {
    adoptEgressControls({ ...defaultEgressControls(), 'chart-image': false });
    expect(removed()).toContain('toImage');
  });

  it('comes back when the deployment permits it', () => {
    adoptEgressControls({ ...defaultEgressControls(), 'chart-image': true });
    expect(removed()).not.toContain('toImage');
  });

  it('defaults to off in the contract, so a deployment that stored nothing is closed', () => {
    // The default lives in one place and this is the assertion that the chart
    // honours THAT place rather than a second opinion written here.
    expect(egressPath('chart-image')?.allowedByDefault).toBe(false);
    expect(defaultEgressControls()['chart-image']).toBe(false);
  });
});

describe('gating the download did not take a reading control with it', () => {
  it('leaves zoom, pan, reset and both hover modes alone in either state', () => {
    const reading = ['zoom2d', 'pan2d', 'resetScale2d', 'zoomIn2d', 'zoomOut2d',
      'hoverClosestCartesian', 'hoverCompareCartesian'];
    for (const allowed of [true, false]) {
      adoptEgressControls({ ...defaultEgressControls(), 'chart-image': allowed });
      for (const button of reading) {
        expect(removed(), `chart-image allowed: ${allowed}`).not.toContain(button);
      }
    }
  });

  it('keeps removing the four buttons that were removed before the gate', () => {
    // The gate appends; it must not have become the whole list.
    adoptEgressControls({ ...defaultEgressControls(), 'chart-image': true });
    for (const button of ['lasso2d', 'select2d', 'toggleSpikelines', 'autoScale2d']) {
      expect(removed()).toContain(button);
    }
  });

  it('does not reopen the write paths the read-only work closed', () => {
    // Cheap, and it catches the specific accident of somebody rewriting this
    // object to add the gate and dropping a flag while they were in there.
    expect(FIGURE_CONFIG.editable).toBe(false);
    expect(FIGURE_CONFIG.showAxisRangeEntryBoxes).toBe(false);
    expect(FIGURE_CONFIG.showEditInChartStudio).toBe(false);
    expect(FIGURE_CONFIG.showSendToCloud).toBe(false);
  });
});

describe('what removing the button does and does not claim', () => {
  it('is recorded in the contract as an affordance and not as enforcement', () => {
    // The honesty rule, asserted rather than commented. The browser already has
    // the figure. Removing the button removes the button; it does not stop a
    // screenshot, and the panel must not imply that it does. If somebody promotes
    // this path to `enforced`, they have to come here and say why.
    const path = egressPath('chart-image');
    expect(path?.enforcement).toBe('enforced');
    expect(egressPath('screen-capture')?.enforcement).toBe('uncontrollable');
  });
});
