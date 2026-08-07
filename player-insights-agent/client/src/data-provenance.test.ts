import { describe, expect, it } from 'vitest';
import { caveatAffirmsSynthetic, dataProvenance } from './data-provenance';
import { REPRESENTATIVE_ANSWER_CAVEAT, REPRESENTATIVE_CAVEATS } from '../../shared/representative-answer';

/**
 * The badge over the cited source used to be unconditional, so a run against a
 * deployment's own production view was labelled "Synthetic demo data" while the
 * answer beneath it said no synthetic data was used. These pin the rule that
 * replaced it: only an explicit claim in the answer counts, and everything else
 * is unknown.
 */
describe('the app only calls data synthetic when the answer says so', () => {
  it('says nothing about a live answer that makes no claim either way', () => {
    expect(dataProvenance({ caveats: ['Refunds are already netted into net bookings.'] })).toBe('unknown');
  });

  it('says nothing when the answer carries no caveats at all', () => {
    expect(dataProvenance({ caveats: [] })).toBe('unknown');
  });

  it('does not read a denial as a claim', () => {
    // The exact caveat from the customer run that exposed the defect. A
    // substring test for "synthetic" passes this and produces the false badge.
    const denial = 'No synthetic data was used; all figures are drawn directly from the queried data package.';
    expect(caveatAffirmsSynthetic(denial)).toBe(false);
    expect(dataProvenance({ caveats: [denial] })).toBe('unknown');
  });

  it.each([
    'None of these records are synthetic.',
    'The player records are not synthetic.',
    'This ran without synthetic data.',
    'Neither table is synthetic.',
  ])('does not read %j as a claim', (caveat) => {
    expect(dataProvenance({ caveats: [caveat] })).toBe('unknown');
  });

  it('repeats the claim when the agent states its records are synthetic', () => {
    expect(dataProvenance({ caveats: REPRESENTATIVE_CAVEATS })).toBe('synthetic');
  });

  it('reads a claim buried in a longer caveat', () => {
    const caveat =
      'All player, activity, purchase, and net bookings records in this demo are synthetic; ' +
      'figures do not represent real players.';
    expect(dataProvenance({ caveats: [caveat] })).toBe('synthetic');
  });

  it('does not let a denial in one clause suppress a claim in another', () => {
    expect(dataProvenance({ caveats: ['Figures do not represent real players. The records are synthetic.'] })).toBe(
      'synthetic'
    );
  });

  it("marks the app's own canned answer, which is the one dataset it does own", () => {
    expect(dataProvenance({ caveats: [REPRESENTATIVE_ANSWER_CAVEAT] })).toBe('synthetic');
  });

  it('does not infer anything from the source or catalog name', () => {
    // Provenance is a property of the answer, never of the table it names --
    // keying on a catalog name is how the defect would come back.
    expect(dataProvenance({ caveats: ['Queried <your_catalog>.<your_schema>.sessions.'] })).toBe('unknown');
  });
});
