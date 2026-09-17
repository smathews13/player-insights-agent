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

  /**
   * The pieces of a figure Plotly will let a reader type over, each one its own
   * switch under `edits`. `editable` is the master: every switch here defaults to
   * whatever `editable` is, so `editable: false` closes all of them at once, and
   * naming them individually only matters if one is ever wanted on its own.
   */
  export type PlotEdit =
    | 'annotationPosition'
    | 'annotationTail'
    | 'annotationText'
    | 'axisTitleText'
    | 'colorbarPosition'
    | 'colorbarTitleText'
    | 'legendPosition'
    | 'legendText'
    | 'shapePosition'
    | 'titleText';

  export interface PlotConfig {
    displaylogo?: boolean;
    displayModeBar?: boolean | 'hover';
    modeBarButtonsToRemove?: string[];
    responsive?: boolean;
    scrollZoom?: boolean;
    doubleClick?: 'reset' | 'autosize' | 'reset+autosize' | false;
    toImageButtonOptions?: Record<string, unknown>;
    /** Master switch for typing over the figure. Plotly defaults it to `false`. */
    editable?: boolean;
    edits?: Partial<Record<PlotEdit, boolean>>;
    /**
     * Declared because it is the one write affordance `editable: false` does NOT
     * cover: Plotly defaults it to `true` and reads it straight off the context,
     * so a figure with editing off still hands out a text box on the axis ends.
     */
    showAxisRangeEntryBoxes?: boolean;
    /** The handles that pan and zoom an axis by dragging. A reading affordance. */
    showAxisDragHandles?: boolean;
    /** Mode bar buttons that hand the figure to an editor elsewhere. */
    showEditInChartStudio?: boolean;
    showSendToCloud?: boolean;
  }

  export function react(
    element: HTMLElement,
    data: PlotData[],
    layout?: PlotLayout,
    config?: PlotConfig
  ): Promise<unknown>;
  export function purge(element: HTMLElement): void;
  export function Plots(): void;

  /**
   * What `toImage` is asked to draw. A figure object rather than a live graph div:
   * the export path renders a chart to a picture without mounting it, so nothing
   * has to be on screen for a download to carry it.
   */
  export interface ToImageFigure {
    data: PlotData[];
    layout?: PlotLayout;
  }

  /**
   * The static render options this app uses. `format` and the pixel box only --
   * `scale` sharpens the raster for a document, and the rest of Plotly's option
   * surface is not called here.
   */
  export interface ToImageOptions {
    format: 'png' | 'jpeg' | 'webp' | 'svg';
    width?: number;
    height?: number;
    scale?: number;
  }

  /** Resolves to a data URL string, e.g. `data:image/png;base64,...`. */
  export function toImage(figure: ToImageFigure | HTMLElement, options: ToImageOptions): Promise<string>;

  const Plotly: {
    react: typeof react;
    purge: typeof purge;
    toImage: typeof toImage;
  };
  export default Plotly;
}
