/**
 * The slice of Plotly.js this app actually calls.
 *
 * `plotly.js-cartesian-dist-min` ships a prebuilt bundle with no type declarations, and
 * `@types/plotly.js` describes the *full* library, several thousand lines covering
 * traces this bundle does not contain, which would type-check charts that cannot render.
 * Declaring the three functions used here keeps the compiler honest about the surface
 * that exists.
 *
 * `Data` and `Layout` are deliberately open records. They arrive from the agent as
 * validated-but-opaque Plotly payloads and are handed straight to Plotly, which is the
 * only thing that knows the full schema.
 */
declare module 'plotly.js-cartesian-dist-min' {
  export type PlotData = Record<string, unknown>;
  export type PlotLayout = Record<string, unknown>;

  export interface PlotConfig {
    displaylogo?: boolean;
    displayModeBar?: boolean | 'hover';
    modeBarButtonsToRemove?: string[];
    responsive?: boolean;
    scrollZoom?: boolean;
    doubleClick?: 'reset' | 'autosize' | 'reset+autosize' | false;
    toImageButtonOptions?: Record<string, unknown>;
  }

  export function react(element: HTMLElement,
    data: PlotData[],
    layout?: PlotLayout,
    config?: PlotConfig
  ): Promise<unknown>;
  export function purge(element: HTMLElement): void;
  export function Plots(): void;

  const Plotly: {
    react: typeof react;
    purge: typeof purge;
  };
  export default Plotly;
}
