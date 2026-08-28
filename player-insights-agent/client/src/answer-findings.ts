/**
 * Turn an answer essay into labeled finding blocks the card can scan.
 *
 * The synthesis prompt asks for `###` labels and 2–4 bullets. Stored answers
 * from before that instruction, and a model that still writes paragraphs, land
 * as a wall of sentences. This pass does not drop a figure or rewrite a table
 * name. It splits sentences into bullets and puts a short label on each block.
 *
 * A label is, in order: a `###` heading the agent wrote, a short bold lead-in,
 * a "Label (source: table):" opening, or a theme that fits the paragraph
 * (Who, Identity, Sessions & spend, Where, Publishers, What this run skipped).
 * Gold / Silver / Raw catalog lines stay the bold paragraphs they are.
 */
import {
  inlinePlainText as rawInline,
  type Block,
  type Inline,
  type InlineText,
  type ListItem,
} from './answer-markdown';

const LABEL_MAX = 90;
const MAX_BULLETS = 4;

const THEMES: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'What this run skipped',
    pattern: /\b(skipped|not (?:aggregated|enumerated|assessed|queried)|was not aggregated)\b/i,
  },
  { label: 'Who', pattern: /\b(player|profile|audience|cohort|declared-favorite|favourite)\b/i },
  { label: 'Identity', pattern: /\b(identity|confidence|email addressable|addressab)/i },
  { label: 'Where', pattern: /\b(countr(?:y|ies)|region|geo(?:graph|$))/i },
  { label: 'Publishers', pattern: /\b(publisher|label column|\bplatforms?\b)/i },
  { label: 'Sessions & spend', pattern: /\b(sessions?|spend|purchases?|bookings?|engagement|conversions?)\b/i },
];

const COLON_OPENING = /^(?<label>[^:\n]{2,80}?)(?:\s*\((?:source:\s*)?(?<source>[^)]+)\))?\s*:\s+(?<body>[\s\S]+)$/i;

const INVENTORY_TIER_LABEL =
  /^(?:[^\p{L}\p{N}]+\s*)?(gold|silver|raw|bronze|reference(?:\s*\/\s*metadata)?)\b(?:\s*\([^)]*\))?\s*$/iu;

/** Collapsed words, for matching labels and themes. Offsets still use `rawInline`. */
export function inlinePlainText(nodes: readonly Inline[]): string {
  return rawInline(nodes).replace(/\s+/g, ' ').trim();
}

function isInventoryTierLabel(nodes: readonly Inline[]): boolean {
  return INVENTORY_TIER_LABEL.test(inlinePlainText(nodes));
}

function isEmptyInline(node: Inline): boolean {
  if (node.kind === 'break') return true;
  if (node.kind === 'text' || node.kind === 'code') return node.runs.every((run) => !run.text.trim());
  return false;
}

function trimInline(nodes: Inline[]): Inline[] {
  const next = [...nodes];
  while (next.length > 0 && isEmptyInline(next[0])) next.shift();
  while (next.length > 0 && isEmptyInline(next[next.length - 1])) next.pop();
  if (next.length === 0) return next;
  const first = next[0];
  if (first.kind === 'text' || first.kind === 'code') {
    const text = first.runs.map((run) => run.text).join('');
    const trimmed = text.replace(/^[:.\s—–-]+/, '');
    if (trimmed !== text) {
      next[0] = textNode(first.kind, trimmed, first.start + (text.length - trimmed.length));
    }
  }
  return next.filter((node) => !isEmptyInline(node));
}

function textNode(kind: 'text' | 'code', text: string, start: number): InlineText {
  return { kind, start, runs: text ? [{ text, start }] : [] };
}

function headingFromLabel(start: number, label: string): Extract<Block, { kind: 'heading' }> {
  return {
    kind: 'heading',
    start,
    level: 3,
    children: [{ kind: 'text', start, runs: [{ text: label, start }] }],
  };
}

function isSentenceEnd(text: string, index: number): boolean {
  const character = text[index];
  if (character !== '.' && character !== '?' && character !== '!') return false;
  if (character === '.' && /\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return false;
  if (character === '.' && text[index + 1] === '.') return false;
  const after = text.slice(index + 1);
  if (!after.trim()) return true;
  const space = /^\s+/.exec(after);
  if (!space) return false;
  const rest = after.slice(space[0].length);
  if (!rest) return true;
  return /[A-Z0-9`$]/.test(rest[0]);
}

function splitInlineSentences(nodes: readonly Inline[]): Inline[][] {
  const sentences: Inline[][] = [];
  let current: Inline[] = [];

  const flush = () => {
    const kept = trimInline(current);
    if (kept.length > 0) sentences.push(kept);
    current = [];
  };

  const pushText = (kind: 'text' | 'code', text: string, start: number) => {
    if (!text) return;
    current.push(textNode(kind, text, start));
  };
  const pushSlice = (node: InlineText, from: number, to: number) => {
    if (to <= from) return;
    current.push(...sliceNodes([node], from, to));
  };

  for (const node of nodes) {
    if (node.kind === 'break') {
      pushText('text', ' ', node.start);
      continue;
    }
    if (node.kind === 'strong' || node.kind === 'link') {
      current.push(node);
      continue;
    }
    const text = node.runs.map((run) => run.text).join('');
    let from = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (!isSentenceEnd(text, index)) continue;
      pushSlice(node, from, index + 1);
      flush();
      from = index + 1;
      while (from < text.length && text[from] === ' ') from += 1;
      index = from - 1;
    }
    pushSlice(node, from, text.length);
  }
  flush();
  return sentences;
}

function splitLeadIn(nodes: readonly Inline[]): { label?: Inline[]; rest: Inline[] } {
  if (nodes.length === 0) return { rest: [] };
  const first = nodes[0];
  if (first.kind !== 'strong') return { rest: [...nodes] };
  if (isInventoryTierLabel(first.children)) return { rest: [...nodes] };
  const labelText = inlinePlainText(first.children);
  if (!labelText || labelText.length > LABEL_MAX) return { rest: [...nodes] };
  // **11** countries… is a figure, not a block label.
  if (/^[\d,.\s/%$]+$/.test(labelText)) return { rest: [...nodes] };
  if (/[.?!]$/.test(labelText) && labelText.length > 40) return { rest: [...nodes] };
  return { label: first.children, rest: trimInline(nodes.slice(1)) };
}

function themeFor(text: string): string | undefined {
  return THEMES.find((theme) => theme.pattern.test(text))?.label;
}

function labeledOpening(text: string): { label: string; bodyFrom: number } | null {
  const match = COLON_OPENING.exec(text.trimStart());
  if (!match?.groups) return null;
  const label = match.groups.label.replace(/\*+/g, '').trim();
  if (!label || /^(?:and|or|the|a|an)$/i.test(label)) return null;
  if (label.length < 3 || /^\d/.test(label)) return null;
  const body = match.groups.body ?? '';
  if (!body.trim()) return null;
  return { label, bodyFrom: text.length - body.length };
}

function sliceNodes(nodes: readonly Inline[], from: number, to: number): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  const visit = (node: Inline): Inline | undefined => {
    if (node.kind === 'break') {
      const start = cursor;
      cursor += 1;
      return start >= from && start < to ? node : undefined;
    }
    if (node.kind === 'strong' || node.kind === 'link') {
      const start = cursor;
      const width = rawInline(node.children).length;
      cursor += width;
      if (cursor <= from || start >= to) return undefined;
      const children = sliceNodes(node.children, from - start, to - start);
      if (children.length === 0) return undefined;
      return node.kind === 'strong'
        ? { kind: 'strong', start: node.start, children }
        : { kind: 'link', start: node.start, href: node.href, children };
    }
    const start = cursor;
    const text = node.runs.map((run) => run.text).join('');
    cursor += text.length;
    if (cursor <= from || start >= to) return undefined;
    const cutFrom = Math.max(from, start) - start;
    const cutTo = Math.min(to, cursor) - start;
    let runCursor = 0;
    const runs = [];
    for (const run of node.runs) {
      const runEnd = runCursor + run.text.length;
      if (runEnd > cutFrom && runCursor < cutTo) {
        const innerFrom = Math.max(cutFrom, runCursor) - runCursor;
        const innerTo = Math.min(cutTo, runEnd) - runCursor;
        runs.push({ ...run, text: run.text.slice(innerFrom, innerTo), start: run.start + innerFrom });
      }
      runCursor = runEnd;
    }
    return { kind: node.kind, start: node.start, runs };
  };
  for (const node of nodes) {
    const taken = visit(node);
    if (taken) out.push(taken);
  }
  return out;
}

function joinInlineGroups(groups: readonly Inline[][]): Inline[] {
  const out: Inline[] = [];
  for (const group of groups) {
    if (out.length > 0) out.push(textNode('text', ' ', group[0]?.start ?? 0));
    out.push(...group);
  }
  return out;
}

function capSentences(sentences: readonly Inline[][]): Inline[][] {
  if (sentences.length <= MAX_BULLETS) return [...sentences];
  const head = sentences.slice(0, MAX_BULLETS - 1);
  return [...head, joinInlineGroups(sentences.slice(MAX_BULLETS - 1))];
}

function capList(block: Extract<Block, { kind: 'list' }>): Extract<Block, { kind: 'list' }> {
  if (block.items.length <= MAX_BULLETS) return block;
  const head = block.items.slice(0, MAX_BULLETS - 1);
  const rest = block.items.slice(MAX_BULLETS - 1);
  const merged: ListItem = {
    start: rest[0]?.start ?? block.start,
    children: joinInlineGroups(rest.map((item) => item.children)),
  };
  return { ...block, items: [...head, merged] };
}

function asList(start: number, sentences: readonly Inline[][]): Extract<Block, { kind: 'list' }> {
  const capped = capSentences(sentences);
  const items: ListItem[] = capped.map((children) => ({
    start: children[0]?.start ?? start,
    children,
  }));
  return { kind: 'list', start: items[0]?.start ?? start, ordered: false, items };
}

function isLabelOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > LABEL_MAX) return false;
  if (/[.!?…]/.test(trimmed)) return false;
  return trimmed.length >= 2;
}

function paragraphAsFinding(block: Extract<Block, { kind: 'paragraph' }>): Block[] {
  if (isInventoryTierLabel(block.children)) return [block];
  const raw = rawInline(block.children);
  const opening = labeledOpening(raw);
  if (opening) {
    const label =
      opening.label.length <= 40
        ? opening.label.replace(/\s+/g, ' ')
        : (themeFor(raw.slice(opening.bodyFrom)) ?? opening.label.replace(/\s+/g, ' '));
    const body = sliceNodes(block.children, opening.bodyFrom, raw.length);
    const sentences = splitInlineSentences(body.length > 0 ? body : block.children);
    if (sentences.length === 0) return [block];
    return [headingFromLabel(block.start, label), asList(block.start, sentences)];
  }
  const { label, rest } = splitLeadIn(block.children);
  if (label) {
    const sentences = splitInlineSentences(rest);
    if (sentences.length === 0) return [headingFromLabel(block.start, inlinePlainText(label))];
    return [headingFromLabel(block.start, inlinePlainText(label)), asList(block.start, sentences)];
  }
  const sentences = splitInlineSentences(block.children);
  if (sentences.length === 0) return [block];
  const inferred = themeFor(inlinePlainText(block.children));
  // A one-line skip note is a finding. Any other single sentence stays a sentence,
  // even if it happens to mention players or sessions.
  if (sentences.length === 1) {
    if (inferred === 'What this run skipped') {
      return [headingFromLabel(block.start, inferred), asList(block.start, sentences)];
    }
    return [block];
  }
  if (inferred) return [headingFromLabel(block.start, inferred), asList(block.start, sentences)];
  return [asList(block.start, sentences)];
}

/**
 * The same blocks, with dense paragraphs turned into labeled lists.
 *
 * Tables, code, rules and lists the agent already wrote are left alone. A
 * heading the agent wrote stays a heading, so a `### Who` over bullets is
 * grouped by the renderer rather than rebuilt here.
 */
export function layoutFindingBlocks(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (
      block.kind === 'paragraph' &&
      isLabelOnly(inlinePlainText(block.children)) &&
      !isInventoryTierLabel(block.children) &&
      next?.kind === 'list' &&
      !next.ordered
    ) {
      out.push(headingFromLabel(block.start, inlinePlainText(block.children).replace(/:$/, '')));
      out.push(capList(next));
      index += 1;
      continue;
    }
    if (block.kind === 'heading' && block.level === 3 && next?.kind === 'list' && !next.ordered) {
      out.push(block);
      out.push(capList(next));
      index += 1;
      continue;
    }
    if (block.kind === 'paragraph') out.push(...paragraphAsFinding(block));
    else out.push(block);
  }
  return out;
}
