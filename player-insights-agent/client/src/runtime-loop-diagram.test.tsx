import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeLoopDiagram } from './RuntimeLoopDiagram';

const panel = fs.readFileSync(path.join(__dirname, 'RuntimeSettingsPanel.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles', 'settings.css'), 'utf8');
const responsiveStyles = fs.readFileSync(path.join(__dirname, 'styles', 'responsive.css'), 'utf8');

const render = (maxSteps: number, maxToolCalls: number, maxRunSeconds: number): string =>
  renderToStaticMarkup(<RuntimeLoopDiagram loop={{ maxSteps, maxToolCalls, maxRunSeconds }} />);

describe('Runtime loop diagram', () => {
  it('renders the currently staged limits instead of fixed example values', () => {
    const first = render(7, 19, 88);
    const changed = render(13, 31, 144);

    expect(first).toContain('up to 7');
    expect(first).toContain('up to 19 total');
    expect(first).toContain('Stops after 88s');
    expect(changed).toContain('up to 13');
    expect(changed).toContain('up to 31 total');
    expect(changed).toContain('Stops after 144s');
    expect(first).not.toContain('overall run budget');
    expect(changed).not.toContain('overall run budget');
    expect(panel).toContain('<RuntimeLoopDiagram loop={settings.loop} />');
  });

  it('labels the actual run-wide semantics and the reasoning/tool loop', () => {
    const markup = render(10, 15, 100);

    expect(markup).toContain('>Ask</text>');
    expect(markup).toContain('>Reasoning step</text>');
    expect(markup).toContain('>Tool calls</text>');
    expect(markup).toContain('>Answer</text>');
    expect(markup).toContain('up to 15 total');
    expect(markup).toContain('total across the run');
    expect(markup).toContain('run-wide time boundary stops gathering after');
    expect(markup.match(/runtime-loop-diagram__edge--loop/g)).toHaveLength(2);
    expect(markup).toContain('Stops after 100s · then writes the answer');
    expect(markup).not.toContain('100s overall run budget');
  });

  it('uses named agent, tool and budget treatments so color is not the only cue', () => {
    const markup = render(10, 15, 100);

    expect(markup).toContain('runtime-loop-diagram__node--agent');
    expect(markup).toContain('runtime-loop-diagram__node--tool');
    expect(markup).toContain('runtime-loop-diagram__budget-frame');
    expect(markup).toContain('runtime-loop-diagram__deadline-note');
    expect(markup).not.toContain('runtime-loop-diagram__budget-label');
    expect(styles).toMatch(
      /\.runtime-loop-diagram__node--agent[^}]*\{[^}]*stroke:\s*var\(--ast-primary-control-border\)/
    );
    expect(styles).toMatch(/\.runtime-loop-diagram__node--tool[^}]*\{[^}]*stroke:\s*var\(--db-teal-600\)/);
    expect(styles).toMatch(/\.runtime-loop-diagram__budget-frame\s*\{[^}]*stroke:\s*var\(--ast-blue\)/);
  });

  it('exposes a dynamic title and description as one accessible image', () => {
    const markup = render(9, 17, 120);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1].split(' ') ?? [];

    expect(markup).toContain('role="img"');
    expect(labelledBy).toHaveLength(2);
    expect(markup).toContain(`<title id="${labelledBy[0]}">Runtime loop limits</title>`);
    expect(markup).toContain(`<desc id="${labelledBy[1]}">`);
    expect(markup).toContain('up to 9 reasoning steps');
    expect(markup).toContain('up to 17 tool calls total');
    expect(markup).toContain('stops gathering after 120 seconds');
  });

  it('sits beside controls on desktop and stacks without squeezing them on narrow layouts', () => {
    expect(styles).toMatch(
      /\.runtime-loop-layout\s*\{[^}]*grid-template-columns:\s*minmax\(330px,\s*354px\)\s+minmax\(320px,\s*1fr\)[^}]*align-items:\s*center/
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width:\s*800px\)\s*\{[\s\S]*?\.runtime-loop-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.runtime-loop-row\s*\{[^}]*repeat\(auto-fit,\s*minmax\(100px,\s*1fr\)\)/
    );
    const diagramStyles = styles.slice(
      styles.indexOf('.runtime-loop-diagram {'),
      styles.indexOf('.runtime-field {', styles.indexOf('.runtime-loop-diagram {'))
    );
    expect(diagramStyles).toMatch(/aspect-ratio:\s*420\s*\/\s*118/);
    expect(diagramStyles).toMatch(/max-width:\s*440px/);
    expect(diagramStyles).not.toMatch(/\banimation\s*:/);
    expect(diagramStyles).not.toMatch(/\btransition\s*:/);
  });
});
