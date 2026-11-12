/**
 * The furniture a full-width page is built from.
 *
 * Split out of App.tsx when the pages became modules. Run Explorer, the
 * Benchmark Lab and App settings each open with the same heading block, so it
 * lives where all three can reach it rather than in whichever page happened to
 * be defined first.
 */

/**
 * The reasoning behind a stated fact, collapsed.
 *
 * Every surface in this app had the same failure: a nuanced state was reported
 * by narrating three sentences of reasoning where a chip and a short line would
 * do. The reasoning is usually correct and worth keeping, so it moves in here
 * rather than being deleted -- one reader in twenty wants it and the other
 * nineteen were reading past it to find the status.
 *
 * `<details>` rather than AppKit's Collapsible, on purpose. Collapsible unmounts
 * its content while shut, so a distinction one of the standing decisions
 * protects would stop being in the document at all, and the tests that hold
 * those decisions read the rendered text. A closed `<details>` is present and
 * addressable and simply not drawn, which is what "behind a disclosure" should
 * mean.
 *
 * `summary` is a label, not a question. The house style kills phrases in
 * headings, and a summary is a heading for the thing under it.
 */
export function Disclosure({
  summary,
  className,
  children,
}: {
  summary: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={`copy-disclosure ${className ?? ''}`}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * A page opens with its title and nothing else.
 *
 * `description` used to be required, and every page spent its first line
 * explaining itself to a reader who had just clicked the tab bearing the same
 * words. The prop is gone rather than made optional, so a page cannot quietly
 * grow one back; a page with something live to say above its content says it in
 * a chip or a timestamp, which is data and survives being read twice.
 */
export function PageHeading({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h2>{title}</h2>
      </div>
      {actions}
    </div>
  );
}
