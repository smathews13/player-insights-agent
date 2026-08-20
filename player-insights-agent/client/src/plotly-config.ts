import type { PlotConfig } from 'plotly.js-cartesian-dist-min';
import { egressPathAllowed } from './egress-policy';

export const FIGURE_CONFIG: PlotConfig = {
  displaylogo: false,
  displayModeBar: 'hover',
  responsive: true,
  scrollZoom: false,
  doubleClick: 'reset',
  editable: false,
  showAxisRangeEntryBoxes: false,
  showEditInChartStudio: false,
  showSendToCloud: false,
  get modeBarButtonsToRemove(): string[] {
    const reading = ['lasso2d', 'select2d', 'toggleSpikelines', 'autoScale2d'];
    return egressPathAllowed('chart-image') ? reading : [...reading, 'toImage'];
  },
};
