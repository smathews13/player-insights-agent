import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PiaAcronym, PiaAvatar, PiaEmptyStateMark, PiaLockup, PiaMark, PiaWordmark } from './PiaMark';
import {
  PIA_CLUSTER,
  PIA_DPAD_ENGRAVED,
  PIA_DPAD_SIMPLIFIED,
  PIA_LOCKUP_SEATS,
  PIA_MARK_VIEWBOX,
  PIA_SIMPLIFIED_CUTOFF,
  piaDpadCut,
  piaMarkElements,
} from './pia-mark';
import { partial, partialNames } from './styles/stylesheet';

const ASSET_NAMES = [
  'pia-dpad.svg',
  'pia-dpad-white.svg',
  'pia-dpad-sm.svg',
  'pia-dpad-white-sm.svg',
  'pia-cluster.svg',
  'pia-cluster-white.svg',
] as const;

function asset(name: (typeof ASSET_NAMES)[number]): string {
  return readFileSync(new URL(`assets/logo/${name}`, import.meta.url), 'utf8');
}

describe('the six delivered PIA assets', () => {
  it('keeps the complete required set on one 64-unit grid', () => {
    expect(ASSET_NAMES).toHaveLength(6);
    for (const name of ASSET_NAMES) {
      expect(asset(name), name).toContain(`viewBox="0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}"`);
    }
  });

  it('uses the same D-pad arm and center geometry in every cut', () => {
    for (const name of ['pia-dpad.svg', 'pia-dpad-white.svg', 'pia-dpad-sm.svg', 'pia-dpad-white-sm.svg'] as const) {
      const svg = asset(name);
      expect(svg).toContain('<rect x="25" y="6" width="14" height="52" rx="7"');
      expect(svg).toContain('<rect x="6" y="25" width="52" height="14" rx="7"');
      expect(svg).toContain('<circle cx="32" cy="32" r="3.4"');
    }
  });

  it('engraves only the full D-pad pair', () => {
    for (const name of ['pia-dpad.svg', 'pia-dpad-white.svg'] as const) {
      expect(asset(name)).toContain('M32 12.5 L35.5 18.5 H28.5 Z');
    }
    for (const name of ['pia-dpad-sm.svg', 'pia-dpad-white-sm.svg'] as const) {
      expect(asset(name)).not.toContain('M32 12.5 L35.5 18.5 H28.5 Z');
    }
  });

  it('keeps the cluster secondary: dashed diamond, four glyphs, accent cross', () => {
    for (const name of ['pia-cluster.svg', 'pia-cluster-white.svg'] as const) {
      const svg = asset(name);
      expect(svg).toContain('M32 18 L46 32 L32 46 L18 32 Z');
      expect(svg).toContain('stroke-dasharray="2 4"');
      expect(svg).toContain('M27 46.5 L37 56.5 M37 46.5 L27 56.5');
    }
  });

  it('ships the approved light and dark inks', () => {
    expect(asset('pia-dpad.svg')).toMatch(/#11171C[\s\S]*#2272B4/);
    expect(asset('pia-dpad-white.svg')).toMatch(/#FFFFFF[\s\S]*#6FAEDD/);
    expect(asset('pia-cluster.svg')).toMatch(/#11171C[\s\S]*#2272B4/);
    expect(asset('pia-cluster-white.svg')).toMatch(/#6FAEDD[\s\S]*#FFFFFF/);
  });
});

describe('typed PIA mark geometry', () => {
  it('switches at 24px exactly, never at a caller-selected cut', () => {
    expect(PIA_SIMPLIFIED_CUTOFF).toBe(24);
    expect(piaDpadCut(23.999)).toBe('simplified');
    expect(piaDpadCut(24)).toBe('engraved');
    expect(piaMarkElements(23)).toBe(PIA_DPAD_SIMPLIFIED);
    expect(piaMarkElements(24)).toBe(PIA_DPAD_ENGRAVED);
    expect(piaMarkElements(12, 'cluster')).toBe(PIA_CLUSTER);
  });

  it('exposes locked header, hero, and compact measurements', () => {
    expect(PIA_LOCKUP_SEATS).toEqual({
      header: { mark: 24, type: 12.5, gap: 7 },
      hero: { mark: 48, type: 24, gap: 12 },
      compact: { mark: 40, type: 38, gap: 5 },
    });
  });

  it('marks the selected cut in rendered SVG markup', () => {
    expect(renderToStaticMarkup(<PiaMark size={15} />)).toContain('data-pia-cut="simplified"');
    expect(renderToStaticMarkup(<PiaMark size={24} />)).toContain('data-pia-cut="engraved"');
  });
});

describe('wordmark, acronym, lockup, and static identity primitives', () => {
  it('accents Agent and the A without shortening the accessible name', () => {
    expect(renderToStaticMarkup(<PiaWordmark tone="dark" />)).toContain(
      'Player Insights <span class="pia-accent">Agent</span>'
    );
    const acronym = renderToStaticMarkup(<PiaAcronym tone="dark" />);
    expect(acronym).toContain('aria-label="Player Insights Agent"');
    expect(acronym).toContain('PI<span class="pia-accent">A</span>');
  });

  it('uses the full-name wordmark and legible engraved avatar in the header lockup', () => {
    const lockup = renderToStaticMarkup(<PiaLockup seat="header" tone="dark" />);
    expect(lockup).toContain('pia-lockup--full');
    expect(lockup).toContain('data-pia-cut="engraved"');
    expect(lockup).toContain('data-pia-static="true"');
    expect(lockup).toContain('width="24"');
    expect(lockup).toContain('Player Insights <span class="pia-accent">Agent</span>');
    expect(lockup).toContain('pia-wordmark');
    expect(lockup).not.toContain('pia-acronym');
    expect(lockup).not.toContain('pia-caption');
  });

  it('keeps the complete engraved D-pad and ice center in every static avatar size', () => {
    for (const size of [11, 14, 24, 32]) {
      const avatar = renderToStaticMarkup(<PiaAvatar size={size} />);
      expect(avatar).toContain('data-pia-cut="engraved"');
      expect(avatar).toContain('data-pia-static="true"');
      expect(avatar.match(/data-pia-role="arm"/g)).toHaveLength(2);
      expect(avatar.match(/data-pia-role="glyph"/g)).toHaveLength(4);
      expect(avatar.match(/data-pia-role="center"/g)).toHaveLength(1);
      expect(avatar).toContain('fill="var(--pia-mark-accent)"');
      expect(avatar).not.toContain('pia-anim');
      expect(avatar).not.toMatch(/animation(?:-name)?:/);
    }
  });

  it('uses only the static cluster for the empty-state primitive', () => {
    const empty = renderToStaticMarkup(<PiaEmptyStateMark />);
    expect(empty).toContain('pia-mark--cluster');
    expect(empty).not.toContain('pia-anim');
  });

  it('wires light, dark, print, and responsive rules into the cascade', () => {
    expect(partialNames()).toContain('pia-brand.css');
    const css = partial('pia-brand.css');
    expect(css).toContain('.pia-mark--light');
    expect(css).toContain('.pia-mark--dark');
    expect(css).toMatch(/\.pia-avatar,\s*\.pia-avatar \*\s*\{[^}]*animation:\s*none[^}]*transition:\s*none/s);
    expect(css).toMatch(/\.pia-mark--dark\s*\{[^}]*--pia-mark-ink:\s*var\(--ast-white\)/s);
    expect(css).toMatch(/\.pia-mark--dark\s*\{[^}]*--pia-mark-accent:\s*var\(--ast-ice-accent\)/s);
    expect(css).toMatch(/\.pia-type--dark,[\s\S]*?\{[^}]*color:\s*var\(--ast-white\)/);
    expect(css).toMatch(/\.pia-type--dark \.pia-accent\s*\{[^}]*color:\s*var\(--ast-ice-accent\)/s);
    expect(css).toContain('@media print');
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*\.pia-avatar\s*\{[^}]*--pia-mark-accent:\s*Highlight/s
    );
    expect(css).toContain('@media (max-width: 720px)');
  });
});
