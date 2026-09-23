/**
 * The ONE place an export file names the product.
 *
 * Every other module in the export stack (serializers, HTML toolkit, actions,
 * the PDF writer) is deliberately brand-free. The only product-specific values
 * are the name stamped on a file and the slug a download falls back to. Those
 * differences live here and nowhere else.
 */
export interface ExportBrand {
  /** Human name used in titles and the document footer, e.g. "Player Insights". */
  readonly appName: string;
  /** Footer line printed at the foot of an exported HTML document. */
  readonly htmlFooter: string;
  /** Filename stem used when a question/title reduces to nothing after sanitising. */
  readonly filenameFallback: string;
  /** Prefix on the `schema_version` string stamped into JSON exports. */
  readonly jsonSchemaPrefix: string;
}

export const EXPORT_BRAND: ExportBrand = {
  appName: 'Player Insights',
  htmlFooter: 'Exported from Player Insights.',
  filenameFallback: 'player-insights-export',
  jsonSchemaPrefix: 'pia',
};
