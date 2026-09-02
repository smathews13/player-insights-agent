/**
 * One cause, said once, over every check that shares it.
 *
 * WHAT THIS REPLACED. The "What to fix" panel rendered one block per blocked
 * check, and on this deployment one missing OAuth scope stops twelve Unity
 * Catalog table checks at once. So the panel printed the same three-sentence
 * diagnosis, the same two-line remedy and the same "Why this is the fix" fold
 * twelve times over, verbatim: roughly forty lines of identical text to carry
 * one fact, which is that one permission is holding up twelve objects. The
 * Vector Search row did it again with an eleven-line shell snippet attached.
 *
 * A reader cannot count the rows of a wall of prose. So the checks that share a
 * diagnosis are collected here and the panel draws the group: the explanation
 * once, the remedy once, and the affected objects as a compact list underneath.
 *
 * WHAT THE GROUPING KEY IS, AND WHY IT IS NOT LOOSER. Two checks group only
 * when they share a STATUS, the sentence a reader is shown, and the remedy in
 * full. That is stricter than "same scope" or "same HTTP code" on purpose:
 *
 * - Status is in the key because `failed` and `unverified` are different claims
 *   with different next actions, and a group states one status for every member.
 *   A scope refusal is reported `unverified` precisely because nothing was
 *   established about the object; folding it in with a real refusal would print
 *   "Blocked" over a check that never reached the thing it was asking about.
 *   DECISIONS.md D6 and D8.
 * - The sentence is in the key because the group prints ONE of them. Grouping on
 *   anything coarser would show a reader an explanation naming `catalog.tables:read`
 *   over a row that was refused over a different permission, which is a diagnosis
 *   asserting a cause the evidence behind that row does not support. D10.
 *
 * TWO LAYERS, AND WHY. `groupByCause` collects checks that share a diagnosis;
 * `groupByRemedy` collects those groups by the remedy that clears them. The
 * second layer exists because the first was not enough: four API families
 * refused for four different permissions produce four diagnoses with ONE remedy,
 * and the panel drew four cards repeating the same instruction. The panel is now
 * one block per remedy, with the causes as rows inside it.
 *
 * Pure, and separate from the page, so the grouping is assertable without
 * composing markup and the page cannot grow a second reading of it.
 */
import { type PreflightCheck, type PreflightRemedy, type PreflightStatus } from './preflight';
import { CHECK_VERDICT_LABEL, checkVerdict, countCheckVerdicts, type CheckVerdict } from '../../shared/check-verdict';

export interface CauseGroup {
  /** Stable across renders, and the React key for the group. */
  key: string;
  /** One status for every member; see the note above on why it is in the key. */
  status: PreflightStatus;
  /**
   * The word this group's chip shows, which is finer than its status.
   *
   * Derived once here rather than at each of the surfaces that draw a group,
   * because the panel's chip and the declared-tables strip were reading one
   * status two ways and printed "Not checked" over twelve refusals.
   */
  verdict: CheckVerdict;
  /** The sentence every member of this group is explained by. */
  detail: string;
  /** The remedy every member of this group shares, or null where none can. */
  remedy: PreflightRemedy | null;
  /** The checks, in the order the report listed them. */
  checks: PreflightCheck[];
}

/**
 * A remedy reduced to the thing a reader would act on.
 *
 * Every field, including the guidance line and who may run it. Two remedies that
 * differ in the guidance differ in what a reader has to do to carry the statement
 * out, and printing one of them for both would be the same overclaim in a quieter
 * place. It matters more now than it did when this field was an unrendered note:
 * the guidance is on screen, so grouping two remedies that disagree about it
 * would show one group's line over the other group's objects.
 */
function remedySignature(remedy: PreflightRemedy | null): string {
  if (!remedy) return 'no-remedy';
  return [remedy.kind, remedy.statement, remedy.guidance, remedy.run_by ?? ''].join('\u0000');
}

/**
 * The sentence a check is explained by, which is what the group prints once.
 *
 * `detail` first, which is the precedence the "What to fix" panel has always
 * used and is the right way round for it: the detail is the verdict written for
 * a reader, and the raw `error` is the fallback for a check that reached one
 * without producing the other. The declared-tables matrix reads the two the
 * other way round, deliberately; see {@link rowStatusLine}.
 */
export function causeSentence(check: PreflightCheck): string {
  return (check.detail || check.error).trim();
}

/**
 * The identity of one check's cause. Equal keys mean an identical block.
 *
 * The VERDICT rather than the status, which is a narrowing of the same rule the
 * status was in the key for: a group prints one chip, so two checks whose chips
 * would read differently -- one refused, one never run -- have to be two groups
 * even where every word of their prose agrees.
 */
export function causeKey(check: PreflightCheck): string {
  return [checkVerdict(check), causeSentence(check), remedySignature(check.remedy)].join('\u0001');
}

/** The blocked checks, collected into the blocks the panel draws. */
export function groupByCause(checks: readonly PreflightCheck[]): CauseGroup[] {
  const groups = new Map<string, CauseGroup>();
  for (const check of checks) {
    const key = causeKey(check);
    const existing = groups.get(key);
    if (existing) {
      existing.checks.push(check);
      continue;
    }
    groups.set(key, {
      key,
      status: check.status,
      verdict: checkVerdict(check),
      detail: causeSentence(check),
      remedy: check.remedy,
      checks: [check],
    });
  }
  return [...groups.values()];
}

/**
 * One detail split into the sentences it is made of.
 *
 * Cut on sentence-ending punctuation followed by a space or the end of the
 * string, which is the same rule {@link rowStatusLine} uses and for the same
 * reason: a scope name like `catalog.tables:read` and a three-part table name
 * both contain full stops and neither ends a sentence.
 */
export function sentencesOf(detail: string): string[] {
  const out: string[] = [];
  let rest = detail.trim();
  while (rest) {
    const end = /[.!?](\s|$)/.exec(rest);
    if (!end) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, end.index + 1).trim());
    rest = rest.slice(end.index + 1).trim();
  }
  return out.filter(Boolean);
}

/**
 * The sentences every one of these details states, in the first one's order.
 *
 * WHY THIS IS SENTENCE-WISE AND NOT WHOLE-DETAIL. The four scope refusals on
 * this deployment differ in exactly one sentence each -- the one naming the
 * permission -- and agree on the four around it. Grouped on the whole detail
 * they are four causes, so the panel printed the agreeing four sentences four
 * times over, plus four copies of one remedy. Lifting out what they share leaves
 * each cause carrying only the fact that is about it, which is the permission a
 * reader came for.
 */
export function sharedSentences(details: readonly string[]): string[] {
  if (details.length === 0) return [];
  const first = sentencesOf(details[0]);
  if (details.length === 1) return first;
  const rest = details.slice(1).map((detail) => new Set(sentencesOf(detail)));
  return first.filter((sentence) => rest.every((set) => set.has(sentence)));
}

/** One cause inside a block, with the part of its detail the block does not state. */
export interface BlockCause extends CauseGroup {
  /**
   * What this cause says that the block's shared lines do not, or '' where it
   * adds nothing. Empty is normal for a block of one, where everything the cause
   * says is by definition shared.
   */
  own: string;
}

/**
 * One remedy, and every cause it clears.
 *
 * ONE PANEL, NOT ONE PANEL PER FAILURE. `groupByCause` collects the checks that
 * share a diagnosis, and that was not enough: a missing permission and a stale
 * sign-in produce four DIFFERENT diagnoses -- one per API family -- with one
 * identical remedy, so the panel drew four cards, each repeating the same
 * three-line instruction about private browsing windows and the same sentence
 * about signing out of Databricks. A reader crossed twelve lines of identical
 * advice to learn one thing they could do once.
 *
 * So the remedy is the block and the causes are its rows. Each cause keeps its
 * own chip and its own sentence, because they fail for genuinely different
 * reasons and flattening them would assert one permission over objects refused
 * over another (DECISIONS.md D10). What they agree on is said once.
 */
export interface RemedyBlock {
  /** Stable across renders, and the React key. */
  key: string;
  /** The remedy every cause here shares, or null where none can fix any of them. */
  remedy: PreflightRemedy | null;
  /** The sentences every cause states, said once. '' when they share none. */
  shared: string;
  causes: BlockCause[];
}

/**
 * The sentence a LONE cause leads with, which is the one a reader came for.
 *
 * WHY A BLOCK OF ONE NEEDS THIS. Everything a single cause says is shared with
 * itself, so the block stated all of it and the cause's own line was empty. That
 * was harmless while the shared sentences were the prominent ones and it stopped
 * being harmless the moment they were ranked below the finding: the panel's one
 * required finding read "Vector Search index, Refused" with the permission it was
 * refused over three sentences down in small grey type, under the caveats.
 *
 * THE SCOPE NAME PICKS IT, not a grammar. `PreflightCheck.scope` is the
 * permission the probe established the refusal turned on, so the sentence
 * carrying that name is the sentence about THIS object rather than about what a
 * refusal does or does not settle. Where no permission was established, the first
 * sentence leads, which is the same precedence {@link rowStatusLine} uses and is
 * usually the code the workspace answered with.
 */
function leadSentence(cause: CauseGroup): string {
  const sentences = sentencesOf(cause.detail);
  const scope = (cause.checks[0]?.scope ?? '').trim();
  const naming = scope ? sentences.find((sentence) => sentence.includes(scope)) : undefined;
  return naming ?? sentences[0] ?? '';
}

/**
 * The causes, collected into one block per remedy.
 *
 * Blocks that can be acted on come first. A block with no remedy is the one a
 * reader can do nothing about, and putting it above four they can act on is the
 * page burying its own answer.
 */
export function groupByRemedy(groups: readonly CauseGroup[]): RemedyBlock[] {
  const byRemedy = new Map<string, CauseGroup[]>();
  for (const group of groups) {
    const key = remedySignature(group.remedy);
    byRemedy.set(key, [...(byRemedy.get(key) ?? []), group]);
  }
  const blocks = [...byRemedy.entries()].map(([key, causes]) => {
    // Only for a block of ONE, and the restriction is what keeps it honest: a
    // sentence in `shared` across several causes is a sentence every one of them
    // states, so lifting it onto one cause's line would take it away from the
    // others. With several causes their sentences already differ where it matters
    // -- that is what `sharedSentences` computes -- and each keeps its own.
    const lead = causes.length === 1 ? leadSentence(causes[0]) : '';
    const shared = sharedSentences(causes.map((cause) => cause.detail)).filter((sentence) => sentence !== lead);
    const stated = new Set(shared);
    return {
      key,
      remedy: causes[0].remedy,
      shared: shared.join(' '),
      causes: causes.map((cause) => ({
        ...cause,
        own: sentencesOf(cause.detail)
          .filter((sentence) => !stated.has(sentence))
          .join(' '),
      })),
    };
  });
  return [...blocks.filter((block) => block.remedy), ...blocks.filter((block) => !block.remedy)];
}

/**
 * What a group calls itself.
 *
 * A group of one is the check's own label, unchanged, because that is what it
 * is: a single blocked dependency, and the page said so correctly before any of
 * this. A group of several leads with the COUNT, which is the fact a reader was
 * previously left to derive by scrolling.
 *
 * The wording follows the status rather than smoothing over it. `unverified`
 * means the call stopped, so the objects behind it are not being called blocked
 * (D8); `failed` means the workspace refused a call that reached the object, so
 * they are.
 */
export function causeGroupHeadline(group: CauseGroup): string {
  if (group.checks.length === 1) return group.checks[0].label;
  const count = group.checks.length;
  if (group.status === 'failed') return `${count} objects, blocked for the same reason`;
  if (group.status === 'unverified') return `${count} checks, stopped for the same reason`;
  return `${count} checks, answered the same way`;
}

/**
 * The dotted prefix every label in a group shares, or '' when they share none.
 *
 * Twelve three-part table names are twelve copies of one catalog and one schema.
 * The prefix is stated once above the list and the tails are what the list
 * carries, so the part that differs is the part a reader reads. The full name is
 * still on each entry, in a `title`.
 *
 * Never returns a whole label: the last segment is always kept, so a group whose
 * members are the same object under different labels cannot collapse to nothing.
 */
export function sharedLabelPrefix(labels: readonly string[]): string {
  if (labels.length < 2) return '';
  const parts = labels.map((label) => label.split('.'));
  let shared = 0;
  while (parts.every((part) => part.length > shared + 1 && part[shared] === parts[0][shared])) shared += 1;
  return shared === 0 ? '' : parts[0].slice(0, shared).join('.');
}

/** One entry of the affected list, with the shared prefix taken off the front. */
export function affectedLabel(label: string, prefix: string): string {
  return prefix && label.startsWith(`${prefix}.`) ? label.slice(prefix.length + 1) : label;
}

/**
 * A row's own text, cut to the status it reports.
 *
 * The declared-tables matrix printed each check's whole detail in its Detail
 * column, so opening it on this deployment meant reading the same
 * three-sentence diagnosis twelve more times. The first sentence is the part
 * that is about THIS object -- the code the workspace answered with, or what it
 * said about the table -- and the reasoning behind it now lives once, on the
 * group in "What to fix".
 *
 * Cut on sentence-ending punctuation followed by a space or the end of the
 * string, so a scope name like `catalog.tables:read` and a three-part table name
 * are not mistaken for the end of a sentence.
 *
 * `error` first here, which is the precedence this cell has always used and is
 * the right way round for a matrix: what the workspace itself said about this
 * one table is the row's own fact, where the detail is now largely the shared
 * diagnosis the group above states.
 */
export function rowStatusLine(check: PreflightCheck): string {
  const sentence = (check.error || check.detail).trim();
  const end = /[.!?](\s|$)/.exec(sentence);
  return end ? sentence.slice(0, end.index + 1) : sentence;
}

/**
 * The declared-tables aside, with each verdict under its own word.
 *
 * It used to read `N blocked` over every check that was not `ok`, which put the
 * scope refusals -- reported `unverified` exactly because nothing was
 * established about the object -- under the word "blocked". That is the sum
 * DECISIONS.md D6 forbids and the reading D8 forbids, in one line.
 *
 * AND THEN IT SAID `12 not checked` OVER TWELVE ROWS READING `HTTP 403`, which
 * is the same fault pointed the other way: a refusal was attempted, so it is not
 * unchecked. The strip and the rows are counted through the SAME function now
 * (`countCheckVerdicts`), so the two cannot describe one table differently.
 *
 * Zero counts do not render, so a healthy list says only how many tables were
 * declared. `reachable` is dropped from the tally rather than counted: the row
 * count is already `N declared`, and "12 declared · 12 reachable" states one
 * number twice.
 */
export function declaredTablesAside(checks: readonly PreflightCheck[]): string {
  const counts = countCheckVerdicts(checks);
  const parts = [`${checks.length} ${checks.length === 1 ? 'table' : 'tables'} declared`];
  for (const verdict of ['blocked', 'refused', 'unreachable', 'unasked'] as const) {
    if (counts[verdict] > 0) parts.push(`${counts[verdict]} ${CHECK_VERDICT_LABEL[verdict].toLowerCase()}`);
  }
  return parts.join(' \u00b7 ');
}
