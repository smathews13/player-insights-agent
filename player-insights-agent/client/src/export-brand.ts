/**
 * The ONE place an export file names the product.
 *
 * Every other module in the export stack (serializers, HTML toolkit, actions,
 * the PDF writer) is deliberately brand-free so it can be the SAME FILE in
 * Player Insights and in ADAPT. The two apps ship identical export behaviour;
 * the only thing that legitimately differs is the name stamped on a file and
 * the slug a download falls back to. Those differences live here and nowhere
 * else, so "make the export identical on both" stays a one-file diff rather
 * than a hunt through the serializers for a hardcoded string.
 *
 * When porting the export stack between the two apps, copy every export-*.ts
 * verbatim EXCEPT this file, and edit only the four values below.
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
