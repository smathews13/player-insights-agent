import { linkifyEntities, type ProseSegment } from './data-entities';

/**
 * The Markdown the agent writes, as a tree the answer card can render.
 *
 * The orchestrator has always written Markdown. It was authored against a
 * notebook, where `## DATA PACKAGE` is a heading and `- **Interpretation:**` is
 * a bulleted lead-in, and the app rendered both as the literal characters the
 * agent typed. Worse than ugly: `white-space` is not `pre-wrap` on the
 * narrative, so newlines collapsed too and a heading landed mid-sentence.
 *
 * WHY A PARSER HERE RATHER THAN A LIBRARY. Two reasons, and the second is the
 * one that decided it.
 *
 * 1. This output is untrusted. It is written by a model, crosses a serving
 *    endpoint, and lands in a customer's browser. The usual pipeline renders
 *    Markdown to an HTML string and then sanitises it, which is safe only for
 *    as long as the sanitiser's denylist keeps pace. There is no HTML string
 *    anywhere in this module. The tree below has five inline shapes and three
 *    block shapes, none of which carries markup, so a `<script>` in the source
 *    has nowhere to go but a text run, and React escapes text runs. Raw HTML is
 *    not sanitised here, it is unrepresentable.
 *
 * 2. Entity linking has to survive. `linkifyEntities` used to run over one flat
 *    string; over a tree it has to run over the text inside the tree, or a
 *    table named in a heading or in bold silently stops linking. A library
 *    hands back rendered output, and reaching into it to re-segment its text
 *    nodes is more code than parsing the eight constructs we support, with the
 *    library's whole surface still shipping to the customer.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED. Underscore emphasis, above all: every
 * table this app links has underscores in it, and `_`-delimited emphasis would
 * eat `gold_title_daily_summary` and hand back a half-italic fragment that no
 * longer matches anything. Also absent: tables, block quotes, fenced code
 * blocks, thematic breaks, images and backslash escapes. Anything unsupported
 * survives as the characters the agent wrote, which is what the app did with
 * all of it before this module existed.
 */

/** A run of prose, or a code span, already cut into linkable segments. */
export interface InlineText {
  kind: 'text' | 'code';
  start: number;
  runs: ProseSegment[];
}

export type Inline =
  | InlineText
  | { kind: 'strong'; start: number; children: Inline[] }
  | { kind: 'link'; start: number; href: string; children: Inline[] }
  | { kind: 'break'; start: number };

export interface ListItem {
  start: number;
  children: Inline[];
}

export type Block =
  | { kind: 'paragraph'; start: number; children: Inline[] }
  | { kind: 'heading'; start: number; level: 2 | 3; children: Inline[] }
  | { kind: 'list'; start: number; ordered: boolean; items: ListItem[] };

/**
 * Line shapes that open a block.
 *
 * Each matches only its marker and the whitespace after it, so the content is
 * the rest of the line and its offset is the length of the match. Requiring
 * that whitespace is what keeps `**Interpretation**` at the start of a line
 * from reading as a bullet whose marker is its first asterisk.
 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+/;
const BULLET = /^ {0,3}[-*+][ \t]+/;
const NUMBERED = /^ {0,3}\d{1,9}[.)][ \t]+/;

/** The schemes a link in agent prose may carry. */
const ALLOWED_SCHEME = /^(?:https?|mailto):/i;

/**
 * The href to render, or `''` when the answer proposed one we will not follow.
 *
 * Whitespace and control characters come out before the scheme is read, because
 * that is what a browser does when it resolves a URL: `java&#9;script:alert(1)`
 * is a working `javascript:` URL once the tab is discarded, and a check that
 * reads the raw string sees a scheme it does not recognise and shrugs.
 *
 * An absolute URL must name an allowed scheme. A relative one is kept: it can
 * only ever address this app. A scheme-relative `//host/path` is rejected,
 * because it is off-site while looking like a path.
 */
export function safeHref(raw: string): string {
  // Written as a scan rather than as a character class, because a class of
  // control characters is a lint error in this repo and suppressing the rule
  // here would read as though the control characters were an oversight. They
  // are the attack.
  let href = '';
  for (const character of raw) if (character.charCodeAt(0) > 0x20) href += character;
  if (!href || href.startsWith('//')) return '';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return ALLOWED_SCHEME.test(href) ? href : '';
  return href;
}

function textNode(kind: 'text' | 'code', text: string, start: number): InlineText {
  return { kind, start, runs: text ? [{ text, start }] : [] };
}

/** What one delimiter consumed: the nodes it produced and how far it reached. */
interface Taken {
  nodes: Inline[];
  length: number;
}

/**
 * A code span, from a run of backticks to the next run of the same length.
 *
 * Content is literal, so nothing inside is parsed further. That is the whole
 * point of the construct and it is also why a stray backtick in prose is safe:
 * with no closing fence this returns nothing and the backtick stays a backtick.
 */
function takeCode(source: string, at: number, base: number): Taken | undefined {
  const fence = /^`+/.exec(source.slice(at))?.[0];
  if (!fence) return undefined;
  const closeAt = source.indexOf(fence, at + fence.length);
  if (closeAt === -1 || closeAt === at + fence.length) return undefined;
  const inner = source.slice(at + fence.length, closeAt);
  return {
    nodes: [textNode('code', inner, base + at + fence.length)],
    length: closeAt + fence.length - at,
  };
}

function takeStrong(source: string, at: number, base: number): Taken | undefined {
  const closeAt = source.indexOf('**', at + 2);
  if (closeAt === -1 || closeAt === at + 2) return undefined;
  return {
    nodes: [{ kind: 'strong', start: base + at, children: parseInline(source.slice(at + 2, closeAt), base + at + 2) }],
    length: closeAt + 2 - at,
  };
}

/**
 * Where a link destination ends, counting nested parentheses.
 *
 * Not the next `)`. Real URLs carry parentheses, and stopping at the first one
 * truncates the destination and spills the rest of it into the prose as text.
 * That is cosmetic for a Wikipedia link and not cosmetic at all for
 * `javascript:alert(1)`, where the truncated half is refused and the `)` left
 * over is rendered.
 */
function closingParen(source: string, from: number): number {
  let depth = 1;
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === '(') depth += 1;
    else if (source[at] === ')') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * An inline link, or its label alone when the URL is one we refuse.
 *
 * A refused link keeps its words and loses its target, which is what a reader
 * needs: the sentence still reads, and there is nothing to click. Printing the
 * rejected URL instead would put `javascript:...` on screen in a customer
 * demo, where it looks like a defect and invites someone to copy it.
 */
function takeLink(source: string, at: number, base: number): Taken | undefined {
  const closeLabel = source.indexOf(']', at + 1);
  if (closeLabel === -1 || source[closeLabel + 1] !== '(') return undefined;
  const closeHref = closingParen(source, closeLabel + 2);
  if (closeHref === -1) return undefined;
  const children = parseInline(source.slice(at + 1, closeLabel), base + at + 1);
  const href = safeHref(source.slice(closeLabel + 2, closeHref));
  const length = closeHref + 1 - at;
  return { nodes: href ? [{ kind: 'link', start: base + at, href, children }] : children, length };
}

/**
 * One line, or one span of a line, as inline nodes.
 *
 * `base` is where `source` sits in the whole answer, and every node records its
 * own offset there. That offset is the React key, and it has to be a property
 * of the node rather than its index in an array: the tracked table list arrives
 * one render after the prose does, so the same answer is segmented twice and an
 * index key would reconcile the wrong runs against each other.
 *
 * Delimiters are taken in the order they appear rather than by precedence,
 * which gives code spans priority over the emphasis inside them and emphasis
 * priority over a code span inside it, both of which are what Markdown means.
 */
function parseInline(source: string, base: number): Inline[] {
  const nodes: Inline[] = [];
  let plainFrom = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    let taken: Taken | undefined;
    if (character === '`') taken = takeCode(source, cursor, base);
    else if (character === '*' && source[cursor + 1] === '*') taken = takeStrong(source, cursor, base);
    else if (character === '[') taken = takeLink(source, cursor, base);
    // An unmatched delimiter is not a delimiter. Left where it was written.
    if (!taken) {
      cursor += 1;
      continue;
    }
    if (cursor > plainFrom) nodes.push(textNode('text', source.slice(plainFrom, cursor), base + plainFrom));
    nodes.push(...taken.nodes);
    cursor += taken.length;
    plainFrom = cursor;
  }
  if (plainFrom < source.length) nodes.push(textNode('text', source.slice(plainFrom), base + plainFrom));
  return nodes;
}

/** A line, its offset in the answer, and where its content starts. */
interface SourceLine {
  text: string;
  start: number;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const text of source.split('\n')) {
    lines.push({ text, start });
    start += text.length + 1;
  }
  return lines;
}

/** The content of a line after its block marker, with the offset it starts at. */
function contentAfter(line: SourceLine, marker: string): { text: string; start: number } {
  const rest = line.text.slice(marker.length);
  const lead = rest.length - rest.trimStart().length;
  return { text: rest.trim(), start: line.start + marker.length + lead };
}

/**
 * The answer, as blocks.
 *
 * Blank lines separate blocks; consecutive lines of prose are one paragraph
 * with a hard break between them. A hard break rather than the space Markdown
 * would insert, because this text is read as a chat message: the agent wraps
 * its own lines meaningfully, and joining them is the collapse this module
 * exists to fix, just done deliberately.
 */
export function parseAnswerMarkdown(source: string): Block[] {
  const lines = sourceLines(source);
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading) {
      const content = contentAfter(line, heading[0]);
      // Clamped to two levels. The card already has a heading -- the takeaway
      // above this prose -- so nothing in here may be a title, and six sizes
      // inside one chat bubble would be a document, not an answer.
      const level = heading[1].length <= 2 ? 2 : 3;
      blocks.push({ kind: 'heading', start: line.start, level, children: parseInline(content.text, content.start) });
      index += 1;
      continue;
    }

    const ordered = !BULLET.test(line.text) && NUMBERED.test(line.text);
    if (ordered || BULLET.test(line.text)) {
      const items: ListItem[] = [];
      // Stops at the first line that is not an item of this same kind, so a
      // numbered list following a bulleted one is a second list rather than
      // five more bullets.
      for (let marker = ordered ? NUMBERED : BULLET; index < lines.length; index += 1) {
        const item = marker.exec(lines[index].text);
        if (!item) break;
        const content = contentAfter(lines[index], item[0]);
        items.push({ start: lines[index].start, children: parseInline(content.text, content.start) });
      }
      blocks.push({ kind: 'list', start: line.start, ordered, items });
      continue;
    }

    const children: Inline[] = [];
    for (; index < lines.length; index += 1) {
      const current = lines[index];
      if (!current.text.trim()) break;
      if (HEADING.test(current.text) || BULLET.test(current.text) || NUMBERED.test(current.text)) break;
      // Keyed on the newline that produced it, which is a position no node
      // built from the line either side of it can also claim.
      if (children.length > 0) children.push({ kind: 'break', start: current.start - 1 });
      const lead = current.text.length - current.text.trimStart().length;
      children.push(...parseInline(current.text.trim(), current.start + lead));
    }
    blocks.push({ kind: 'paragraph', start: line.start, children });
  }
  return blocks;
}

function linkifyRuns(runs: readonly ProseSegment[], declared: readonly string[], tracked: readonly string[]) {
  const linked: ProseSegment[] = [];
  for (const run of runs) {
    for (const segment of linkifyEntities(run.text, declared, tracked)) {
      linked.push({ ...segment, start: run.start + segment.start });
    }
  }
  return linked;
}

/**
 * The same tree, with the tables this answer declared made clickable.
 *
 * Run over the text inside the tree rather than over the Markdown source, which
 * is the point of doing it here at all. Matching the source would find table
 * names inside `**` and backtick delimiters and cut segments that straddle
 * them, and the offsets it produced would address the source rather than the
 * rendered text.
 *
 * CODE SPANS ARE LINKED. The customer's convention is to write field and table
 * names in backticks, so the alternative is that adopting their own house style
 * silently switches this feature off: every table name in an answer would be in
 * a code span, and none of them would link. The usual objection, that a code
 * span is literal and a link inside one is a surprise, does not carry here
 * because the link set is not a dictionary lookup. A run only links when the
 * answer declared that table as a source AND the Connections page has a row for it,
 * so there is no reading of an answer under which the link is unwanted.
 *
 * LINK LABELS ARE NOT. An `<a>` inside an `<a>` is invalid HTML and the browser
 * un-nests it, so a table name inside a link the agent wrote stays plain text.
 */
function linkifyInline(nodes: readonly Inline[], declared: readonly string[], tracked: readonly string[]): Inline[] {
  return nodes.map((node) => {
    if (node.kind === 'text' || node.kind === 'code') {
      return { ...node, runs: linkifyRuns(node.runs, declared, tracked) };
    }
    if (node.kind === 'strong') return { ...node, children: linkifyInline(node.children, declared, tracked) };
    return node;
  });
}

/** Answer prose as renderable blocks, entities linked. */
export function answerBlocks(source: string, declared: readonly string[], tracked: readonly string[]): Block[] {
  // Case by case rather than one spread over the union: spreading a union of
  // block shapes widens the result to a shape with every field optional, which
  // is no longer a `Block`.
  return parseAnswerMarkdown(source).map((block): Block => {
    switch (block.kind) {
      case 'list':
        return {
          ...block,
          items: block.items.map((item) => ({ ...item, children: linkifyInline(item.children, declared, tracked) })),
        };
      case 'heading':
        return { ...block, children: linkifyInline(block.children, declared, tracked) };
      case 'paragraph':
        return { ...block, children: linkifyInline(block.children, declared, tracked) };
    }
  });
}

/**
 * The same, for the surfaces that are a sentence rather than a document.
 *
 * The caveat list and the degraded-answer banner render inside a running
 * sentence, after a bolded lead-in. Blocks there would break the line and put a
 * heading inside an alert, so those surfaces take the inline constructs --
 * bold, code, links -- and leave a `##` as the characters the agent wrote.
 */
export function answerInline(source: string, declared: readonly string[], tracked: readonly string[]): Inline[] {
  return linkifyInline(parseInline(source, 0), declared, tracked);
}
