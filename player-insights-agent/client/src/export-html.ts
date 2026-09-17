/**
 * The HTML toolkit both the answer export and the report export are built from.
 *
 * One module so there is ONE renderer for the safe answer AST, one table shape, one
 * theme, and one document shell -- an answer exported to HTML and a report exported
 * to HTML are the same primitives arranged differently, and a second copy of any of
 * this is a second place a `<script>` could be let through or a colour could drift.
 *
 * NO RAW HTML CROSSES THIS BOUNDARY. Every string that comes from the model -- prose,
 * a cell, a heading, a link target -- goes through `escapeHtml` or `safeHref` before
 * it is written into markup. The block renderer walks the parsed AST, whose inline
 * shapes carry no markup, so a `<script>` in the source has nowhere to land but a
 * text run, which is escaped. This mirrors answer-markdown.ts's reasoning for the
 * on-screen renderer: raw HTML is not sanitised here, it is unrepresentable.
 */
import type { Block, Inline, TableRow } from './answer-markdown';

/** The two document palettes. `presentation` is for pasting onto a dark deck; `page` is a white sheet. */
export type ExportHtmlTheme = 'page' | 'presentation';

/** Escapes text and attribute values. Covers the five characters that break out of either context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A link target safe to write into an exported file, or null to drop the anchor.
 *
 * The href comes from model-authored Markdown that crossed a serving endpoint, so
 * `javascript:` and other active schemes are refused rather than trusted. http(s),
 * mailto and ordinary relative paths pass; anything with a foreign scheme becomes
 * plain text, matching how the in-app renderer refuses to make markup out of it.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[/#?.]/.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}

export function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return escapeHtml(node.runs.map((run) => run.text).join(''));
      if (node.kind === 'code') return `<code>${escapeHtml(node.runs.map((run) => run.text).join(''))}</code>`;
      if (node.kind === 'strong') return `<strong>${inlineHtml(node.children)}</strong>`;
      if (node.kind === 'link') {
        const href = safeHref(node.href);
        return href ? `<a href="${escapeHtml(href)}">${inlineHtml(node.children)}</a>` : inlineHtml(node.children);
      }
      return '<br />';
    })
    .join('');
}

type ColumnAlign = 'left' | 'right' | 'center';

function alignStyle(align: ColumnAlign | undefined): string {
  return align === 'right' || align === 'center' ? ` style="text-align:${align}"` : '';
}

function tableBlockHtml(block: Extract<Block, { kind: 'table' }>): string {
  const head = block.header
    ? `<thead><tr>${block.header.cells
        .map((cell, index) => `<th${alignStyle(block.align[index])}>${inlineHtml(cell.children)}</th>`)
        .join('')}</tr></thead>`
    : '';
  const body = `<tbody>${block.rows
    .map(
      (row) =>
        `<tr>${row.cells
          .map((cell, index) => `<td${alignStyle(block.align[index])}>${inlineHtml(cell.children)}</td>`)
          .join('')}</tr>`
    )
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function listHtml(block: Extract<Block, { kind: 'list' }>): string {
  const tag = block.ordered ? 'ol' : 'ul';
  const parts: string[] = [];
  let depth = 0;
  for (const item of block.items) {
    while (depth < item.depth) {
      parts.push(`<${tag}>`);
      depth += 1;
    }
    while (depth > item.depth) {
      parts.push(`</${tag}>`);
      depth -= 1;
    }
    parts.push(`<li>${inlineHtml(item.children)}</li>`);
  }
  while (depth > 0) {
    parts.push(`</${tag}>`);
    depth -= 1;
  }
  return `<${tag}>${parts.join('')}</${tag}>`;
}

/** The safe answer AST as HTML. Mirrors serializeBlocksMarkdown; raw HTML never enters, since the tree carries none. */
export function serializeBlocksHtml(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
          return `<p>${inlineHtml(block.children)}</p>`;
        case 'heading': {
          const level = Math.min(6, Math.max(1, block.level));
          return `<h${level}>${inlineHtml(block.children)}</h${level}>`;
        }
        case 'list':
          return listHtml(block);
        case 'rule':
          return '<hr />';
        case 'code':
          return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case 'table':
          return tableBlockHtml(block);
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * A table from plain-text columns and rows, for a report whose data never was Markdown.
 *
 * Every value is escaped; `caption` becomes a source line under the table. A row with
 * fewer cells than the header is padded so the columns still line up.
 */
export function structuredTableHtml(input: {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  align?: readonly ColumnAlign[];
  caption?: string;
}): string {
  const width = Math.max(input.columns.length, ...input.rows.map((row) => row.length), 1);
  const align = (index: number) => alignStyle(input.align?.[index]);
  const head = input.columns.length
    ? `<thead><tr>${Array.from({ length: width }, (_, index) => `<th${align(index)}>${escapeHtml(input.columns[index] ?? '')}</th>`).join('')}</tr></thead>`
    : '';
  const body = `<tbody>${input.rows
    .map(
      (row) =>
        `<tr>${Array.from({ length: width }, (_, index) => `<td${align(index)}>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`
    )
    .join('')}</tbody>`;
  const caption = input.caption ? `<figcaption>${escapeHtml(input.caption)}</figcaption>` : '';
  return `<figure class="table-figure">${caption}<table>${head}${body}</table></figure>`;
}

/** A row of KPI cards. `value` is a pre-formatted display string; `caption` is the small line under it. */
export function kpiGridHtml(items: readonly { label: string; value: string; caption?: string }[]): string {
  if (items.length === 0) return '';
  const cards = items
    .map(
      (item) =>
        `<li class="kpi"><div class="label">${escapeHtml(item.label)}</div>` +
        `<div class="value">${escapeHtml(item.value)}</div>` +
        (item.caption ? `<div class="comparison">${escapeHtml(item.caption)}</div>` : '') +
        `</li>`
    )
    .join('');
  return `<ul class="figures">${cards}</ul>`;
}

/** A chart as an inlined PNG. `image` is a data URL rendered by chart-image.ts; a missing one yields ''. */
export function chartFigureHtml(title: string, image: string | undefined): string {
  if (!image) return '';
  const name = title.trim() || 'Chart';
  return `<figure class="chart"><figcaption>${escapeHtml(name)}</figcaption><img alt="${escapeHtml(name)}" src="${escapeHtml(image)}" /></figure>`;
}

export function sourcesListHtml(sources: readonly { name: string; freshness?: string }[]): string {
  if (sources.length === 0) return '';
  const items = sources
    .map(
      (source) =>
        `<li><code>${escapeHtml(source.name)}</code>${source.freshness ? ` — ${escapeHtml(source.freshness)}` : ''}</li>`
    )
    .join('');
  return `<ul>${items}</ul>`;
}

export function bulletListHtml(items: readonly string[]): string {
  if (items.length === 0) return '';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

/**
 * The stylesheet inlined into every exported document.
 *
 * `presentation` renders on true black with light ink for pasting onto a slide;
 * `page` is an ordinary white sheet. Both read the same handful of slots, so the two
 * documents are one layout in two palettes rather than two stylesheets that drift.
 */
export function documentCss(theme: ExportHtmlTheme): string {
  const dark = theme === 'presentation';
  const ink = dark ? '#f5f7fa' : '#161616';
  const muted = dark ? '#9fb0c3' : '#5a6472';
  const background = dark ? '#000000' : '#ffffff';
  const panel = dark ? '#0e1116' : '#f6f8fb';
  const border = dark ? '#243043' : '#d9dee6';
  const accent = dark ? '#4aa3ff' : '#2272b4';
  return [
    `:root{color-scheme:${dark ? 'dark' : 'light'};}`,
    `*{box-sizing:border-box;}`,
    `body{margin:0;background:${background};color:${ink};font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}`,
    `.export-doc{max-width:900px;margin:0 auto;padding:40px 44px;}`,
    `.export-doc>header{margin-bottom:8px;}`,
    `h1,h2,h3{line-height:1.25;color:${ink};}`,
    `h1{font-size:26px;margin:0 0 4px;}`,
    `.subtitle{color:${muted};font-size:15px;margin:0 0 4px;}`,
    `h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:${muted};margin:28px 0 10px;}`,
    `h3{font-size:16px;margin:18px 0 6px;color:${ink};}`,
    `.export-doc p{margin:0 0 12px;}`,
    `.headline{font-size:19px;font-weight:600;color:${ink};}`,
    `a{color:${accent};}`,
    `code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:${panel};padding:1px 5px;border-radius:4px;}`,
    `pre{background:${panel};border:1px solid ${border};border-radius:8px;padding:12px 14px;overflow:auto;}`,
    `pre code{background:none;padding:0;}`,
    `table{border-collapse:collapse;width:100%;margin:8px 0 6px;font-size:14px;}`,
    `th,td{border:1px solid ${border};padding:7px 10px;text-align:left;}`,
    `th{background:${panel};font-weight:600;color:${ink};}`,
    `figure{margin:0 0 18px;}`,
    `figure.chart img{max-width:100%;height:auto;display:block;border:1px solid ${border};border-radius:8px;background:${dark ? '#0b0e13' : '#ffffff'};}`,
    `figcaption{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${muted};margin-bottom:6px;}`,
    `.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;padding:0;margin:0 0 16px;list-style:none;}`,
    `.figures .kpi{border:1px solid ${border};border-radius:10px;padding:12px 14px;background:${panel};}`,
    `.figures .kpi .label{font-size:12px;color:${muted};}`,
    `.figures .kpi .value{font-size:24px;font-weight:600;color:${ink};}`,
    `.figures .kpi .comparison{font-size:12px;color:${muted};}`,
    `section.report-section{margin-bottom:10px;}`,
    `.sources ul,.caveats ul{margin:0;padding-left:18px;color:${muted};font-size:13px;}`,
    `.doc-footer{margin-top:28px;border-top:1px solid ${border};padding-top:10px;color:${muted};font-size:12px;}`,
  ].join('');
}

/** Wraps a rendered body in a self-contained HTML document with the theme's CSS inlined. */
export function htmlDocument(input: { title: string; theme: ExportHtmlTheme; body: string; footer?: string }): string {
  const footer = input.footer ? `<div class="doc-footer">${escapeHtml(input.footer)}</div>` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${documentCss(input.theme)}</style>`,
    '</head>',
    '<body>',
    `<main class="export-doc">${input.body}${footer}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Plain text of one parsed table row, whitespace-collapsed. Shared by TSV, JSON and structured HTML. */
export function tableRowText(row: TableRow, inline: (nodes: readonly Inline[]) => string): string[] {
  return row.cells.map((cell) => inline(cell.children).replace(/\s+/g, ' ').trim());
}
