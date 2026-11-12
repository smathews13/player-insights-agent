/**
 * A cause the app states to a user must be derived from evidence the app has,
 * or be labelled as unknown.
 *
 * WHY THIS EXISTS. On 2026-08-16 the Connections page turned Unity Catalog rows
 * red with HTTP 403 and explained them. The explanation had two halves and only
 * one of them was earned. The first half compared the scope Databricks named in
 * its own refusal against the scope claim on the forwarded token, and returned
 * `undetermined` with no remedy where it could not tell: real work, on real
 * evidence, and the part of that panel worth keeping. The second half appended a
 * confident sentence about WHY the scope was absent, and a four-step remedy
 * built on it. Nothing in the code could know that why. Three of the four steps
 * had already been done and verified. The reader spent an afternoon on them.
 *
 * The defect is not the wrong guess. It is that a guess and a determination
 * reached the screen looking identical, so no reader could tell which they were
 * being given. That is what this module makes hard to repeat: a diagnosis is a
 * value with its evidence attached, and {@link auditDiagnosis} refuses one whose
 * prose claims more than its evidence supports.
 *
 * Pure and dependency-free on purpose. It is audited from the vitest suite,
 * which is what makes it a guard rather than a convention; see
 * `server/lib/diagnosis-audit.test.ts`, which is where a new diagnosis is
 * registered.
 */

/** The cause of a diagnosis nothing decided. Not a placeholder: an answer. */
export const UNDETERMINED = 'undetermined';

/**
 * The action offered for a determined cause, in the form that action takes.
 *
 * A type alias rather than an interface, and that is load-bearing rather than
 * stylistic. Callers widen this with their own fields and pass the result into
 * shapes that carry an index signature, which TypeScript permits for an alias
 * and refuses for an interface. Written as an interface it does not compile at
 * the one place it most needs to: the surface that renders it.
 */
export type DiagnosisRemedy = {
  /** `sql` runs in a SQL editor, `cli` is a Databricks CLI call, `ui` is a click path. */
  kind: 'sql' | 'cli' | 'ui';
  statement: string;
  /**
   * The one thing a reader has to know to carry the statement out CORRECTLY, or
   * `''` where the statement stands on its own.
   *
   * GUIDANCE, NOT EXPLANATION, and the field is named for the distinction
   * because the distinction is the whole of what belongs here. This was `note`,
   * it held the paragraph the Connections page printed under "Why this is the
   * fix", and the paragraph was cut for reading as narrative. What the cut also
   * removed was a handful of sentences a reader could not act correctly without,
   * so the field came back narrowed to those and renamed so the paragraph cannot
   * come back with it.
   *
   * THE TEST, applied to every remedy on the server and recorded here because it
   * is the only thing keeping this field small: if a reader followed `statement`
   * WITHOUT this sentence, could they waste real time or take a wrong action? A
   * stale sign-in passes it -- the statement says to open a private window, and
   * without the sentence a reader reasonably signs out of Databricks first, which
   * does not clear this app's session and never has. A sentence saying what kind
   * of object the statement acts on fails it: the statement runs either way.
   *
   * So the shapes that do NOT go here, each of which was in the paragraph:
   * naming the object's taxonomy ("a warehouse is a workspace object"), saying
   * what the check does or does not prove, restating something another row or the
   * statement's own comments already say, or offering a UI path beside a CLI call
   * that already works.
   *
   * ONE SHORT LINE, enforced by {@link auditGuidance} rather than agreed: a
   * length and a ban on line breaks, because the failure mode is a paragraph and
   * a paragraph is what those two rules cannot be.
   */
  guidance: string;
};

/**
 * One thing the app tells a user about why something is the way it is.
 *
 * `cause` and `explanation` are kept apart deliberately. `cause` is the code's
 * own verdict, in a fixed vocabulary, and is what the audit reasons about.
 * `explanation` is the prose a person reads. Splitting them is the only way a
 * check can hold the second against the first.
 */
export interface Diagnosis {
  /** The verdict, or {@link UNDETERMINED} when the evidence does not decide it. */
  cause: string;
  /**
   * What was read to reach `cause`, quoting the values that were read.
   *
   * Required for any cause but {@link UNDETERMINED}, and required to quote
   * something: the sentence that caused this module cited nothing at all, and
   * "the session is stale" with no values behind it is the same sentence wearing
   * a field name.
   */
  evidence: string;
  /** The words a person reads. Never empty: an unexplained verdict reads as a bug. */
  explanation: string;
  /** What to do about it, or null. Always null for {@link UNDETERMINED}. */
  remedy: DiagnosisRemedy | null;
}

/**
 * Prose that asserts a cause.
 *
 * NOT A GENERAL ENGLISH RULE, and it would be wrong as one. These patterns are
 * only ever applied to the explanation of a diagnosis the code has labelled
 * `undetermined`, where any causal claim is by construction unsupported. Copy
 * that has earned its cause is free to explain it, and most of this app's copy
 * does exactly that.
 *
 * The list is drawn from how the offending sentence and its neighbours were
 * actually written, not from a grammar: "because", a bare "due to", and the
 * second-person accusation ("you have not signed in again") are the three shapes
 * that appear when somebody fills a gap in the evidence with a story.
 */
export const CAUSAL_PHRASES: readonly RegExp[] = [
  /\bbecause\b/i,
  /\bdue to\b/i,
  /\bcaused by\b/i,
  /\bthe (?:cause|reason) (?:is|was)\b/i,
  /\bthis (?:is|happens) when\b/i,
  /\bhappens when\b/i,
  /\b(?:that|which) is why\b/i,
  /\byou (?:have|did) not\b/i,
  /\byou (?:haven't|didn't|never)\b/i,
  /\bthe app is missing\b/i,
  /\bwas (?:minted|issued|granted|created) before\b/i,
  /\bpredates\b/i,
  /\bhas not been (?:stopped|started|restarted|redeployed)\b/i,
];

/**
 * A second action, hung off the first with a condition.
 *
 * THE OTHER HALF OF THE 2026-08-16 DEFECT, and the half the first rule here
 * does not reach. That panel's remedy was not one wrong action, it was a LIST:
 *
 *     Reload this page to pick up a fresh token. If it persists, sign out of
 *     the workspace and back in, then open the app again.
 *
 * Three actions, in a sequence, presented as a statement to carry out. The
 * shape is what makes it costly. Each step is offered as though the one before
 * it had ruled something out, so a reader works down the list believing they
 * are narrowing the problem, when nothing in the code had established which
 * step, if any, applied. Signing out of the workspace could never have worked;
 * it was in the list because it sounded like the next thing to try.
 *
 * So the rule is that the statement is the one action a reader takes, and it
 * must be an action they can take without deciding anything first.
 *
 * WHAT TO CONCLUDE IF IT DOES NOT WORK USED TO GO IN THE NOTE, and that is no
 * longer an answer: the note is now {@link DiagnosisRemedy.guidance}, it is one
 * short line, and it holds only what a reader needs to carry the statement out
 * correctly. An escalation has nowhere to be moved to and is meant to have
 * nowhere: this app re-probes and states the next verdict from its own evidence,
 * which is a diagnosis rather than the reader working down a list.
 *
 * Deliberately narrow. It matches conditional ESCALATION, not the word "if":
 * a statement may say "if you are an account admin", and this leaves it alone.
 */
export const ESCALATING_PHRASES: readonly RegExp[] = [
  /\bif (?:it|that|this|they|the\b[^.]{0,30}?) (?:persists?|still|does not|doesn't|do not|don't|fails?)\b/i,
  /\bif not,/i,
  /\bfailing that\b/i,
  /\botherwise,? (?:try|run|sign|open|reload|restart)\b/i,
  /\bthen try\b/i,
];

/** The escalation this text hangs off its first action, or null. */
export function escalatesToAnotherAction(text: string): string | null {
  for (const pattern of ESCALATING_PHRASES) {
    const found = pattern.exec(text);
    if (found) return found[0];
  }
  return null;
}

/** The em dash, which DECISIONS.md D9 keeps out of copy a reader reaches. */
const EM_DASH = /\u2014/;

/**
 * The longest a remedy's guidance may be.
 *
 * A number rather than a judgement, because "keep it short" is what the cut
 * paragraph was written under. 200 characters is about two lines on the narrowest
 * column this renders in and comfortably fits every sentence that survived the
 * test in {@link DiagnosisRemedy.guidance}; the shortest thing it refuses is
 * roughly three sentences.
 */
export const GUIDANCE_MAX_CHARS = 200;

/**
 * What is wrong with one remedy's guidance, as findings. Empty means clean.
 *
 * SEPARATE AND EXPORTED so the producers outside the diagnosis register can be
 * held to it too. Most of this app's remedies are built by the probes and the
 * grant helpers rather than as a {@link Diagnosis}, they were never audited from
 * here, and they carried the same paragraph. See `remedy-guidance.test.ts`.
 *
 * Empty guidance is clean, and deliberately so: a statement that stands on its
 * own says nothing here, and the commonest correct value is `''`.
 */
export function auditGuidance(name: string, guidance: string): string[] {
  const findings: string[] = [];
  // The escalation rule, applied here as well as to the statement, because until
  // now the note was where an escalation was told to go and the audit therefore
  // waved it through. One short line is not enough on its own to keep the 401
  // advice out: "If it persists, sign out of the workspace and back in" fits.
  const escalation = escalatesToAnotherAction(guidance);
  if (escalation) {
    findings.push(
      `${name}: the remedy guidance hangs a second action off the statement ("${escalation}"). ` +
        'This field says what a reader needs in order to do the statement correctly, not what to ' +
        "do instead when it fails. The next verdict is the app's to reach from its own evidence."
    );
  }
  if (/\n/.test(guidance)) {
    findings.push(
      `${name}: the remedy guidance contains a line break. This field is ONE line rendered ` +
        'under the statement, not the paragraph it replaced. If it needs a second line it is ' +
        'explanation, and the decision was to cut explanation rather than shorten it.'
    );
  }
  if (guidance.length > GUIDANCE_MAX_CHARS) {
    findings.push(
      `${name}: the remedy guidance is ${guidance.length} characters, over ` +
        `${GUIDANCE_MAX_CHARS}. Keep the one fact a reader cannot act correctly without and drop ` +
        'the rest; see the test in `DiagnosisRemedy.guidance`.'
    );
  }
  return findings;
}

/**
 * The causal phrase this text asserts, or null.
 *
 * Returns the matched words rather than a boolean so a failure can quote the
 * offending phrase back. A finding that says only "asserts a cause" sends
 * somebody re-reading a paragraph looking for it.
 */
export function statesACause(text: string): string | null {
  for (const pattern of CAUSAL_PHRASES) {
    const found = pattern.exec(text);
    if (found) return found[0];
  }
  return null;
}

/** Whether evidence quotes a value it read, rather than restating the verdict. */
function quotesSomething(evidence: string): boolean {
  return /`[^`]+`/.test(evidence) || /\d/.test(evidence);
}

/**
 * What is wrong with one diagnosis, as a list of findings. Empty means clean.
 *
 * Findings rather than a thrown error, so one run can report every fault in
 * every registered diagnosis instead of stopping at the first. The strings are
 * written to be read in a test failure by somebody who has just added the
 * diagnosis and does not yet know this rule exists.
 */
export function auditDiagnosis(name: string, diagnosis: Diagnosis): string[] {
  const findings: string[] = [];
  const { cause, evidence, explanation, remedy } = diagnosis;

  if (!explanation.trim()) {
    findings.push(`${name}: has no explanation. A verdict with no words beside it reads as a bug.`);
  }

  if (cause === UNDETERMINED) {
    const phrase = statesACause(explanation);
    if (phrase) {
      findings.push(
        `${name}: the cause is undetermined, but the explanation a user reads asserts one ` +
          `("${phrase}"). Either determine the cause from something the app read and name it in ` +
          '`cause` with the values in `evidence`, or take the claim out of the prose. This is the ' +
          'exact fault of 2026-08-16: a guess that reached a screen looking like a finding.'
      );
    }
    if (remedy) {
      findings.push(
        `${name}: the cause is undetermined, but a remedy is offered. A remedy is a claim ` +
          'about the cause. Offering one here sends somebody to do work that may already be done, ' +
          'which is what cost an afternoon on 2026-08-16.'
      );
    }
  } else {
    if (!evidence.trim()) {
      findings.push(
        `${name}: claims the cause is "${cause}" and cites no evidence. Put what was read in ` +
          '`evidence`, or set the cause to UNDETERMINED.'
      );
    } else if (!quotesSomething(evidence)) {
      findings.push(
        `${name}: the evidence for "${cause}" quotes nothing that was read (no \`value\` and no ` +
          'number). Restating the verdict in longer words is not evidence for it.'
      );
    }
  }

  if (remedy) {
    const escalation = escalatesToAnotherAction(remedy.statement);
    if (escalation) {
      findings.push(
        `${name}: the remedy statement hangs a second action off the first ("${escalation}"). ` +
          'A reader carries out the statement; they should not have to judge which part of it ' +
          'applies to them. Keep one action in `statement` and drop the rest: what to conclude ' +
          'if it does not work is a further diagnosis, and this app states those from evidence ' +
          'rather than offering them as steps. The 2026-08-16 remedy was a list of three built ' +
          'this way, and the middle one could never have worked.'
      );
    }
    findings.push(...auditGuidance(name, remedy.guidance));
  }

  // DECISIONS.md D9. Checked here because this is the one place every diagnosis
  // passes through, and copy is where the rule is broken.
  for (const [field, text] of [
    ['explanation', explanation],
    ['remedy statement', remedy?.statement ?? ''],
    ['remedy guidance', remedy?.guidance ?? ''],
  ] as const) {
    if (EM_DASH.test(text)) findings.push(`${name}: em dash in the ${field}. DECISIONS.md D9.`);
  }

  return findings;
}

/** One producer's diagnoses, named so a finding says which branch it came from. */
export interface AuditedDiagnoses {
  /** The producing function, for the failure message. */
  producer: string;
  /** Every branch it can return, keyed by a name a reader will recognise. */
  branches: Readonly<Record<string, Diagnosis>>;
}

/** Every finding across every registered producer. Empty means clean. */
export function auditAll(registered: readonly AuditedDiagnoses[]): string[] {
  return registered.flatMap((entry) =>
    Object.entries(entry.branches).flatMap(([branch, diagnosis]) =>
      auditDiagnosis(`${entry.producer} (${branch})`, diagnosis)
    )
  );
}
