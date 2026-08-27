import { describe, expect, it } from 'vitest';

import {
  derivedSemanticIndexName,
  resolveSemanticIndexValue,
  SEMANTIC_LAYER_INDEX,
} from './semantic-index-name';

describe('the derived Vector Search index name', () => {
  it('matches the agent’s catalog.schema.semantic_layer_index spelling', () => {
    expect(derivedSemanticIndexName('a_catalog', 'a_schema')).toBe(
      `a_catalog.a_schema.${SEMANTIC_LAYER_INDEX}`
    );
  });

  it('does not invent a name when the namespace is missing', () => {
    expect(derivedSemanticIndexName('a_catalog', '')).toBe('');
    expect(derivedSemanticIndexName('', 'a_schema')).toBe('');
  });
});

describe('resolving the index flag', () => {
  it('turns true into the derived name when catalog and schema are known', () => {
    expect(resolveSemanticIndexValue('true', 'a_catalog', 'a_schema')).toBe(
      'a_catalog.a_schema.semantic_layer_index'
    );
  });

  it('leaves true alone when there is no namespace to derive from', () => {
    expect(resolveSemanticIndexValue('true', '', '')).toBe('true');
  });

  it('keeps a three-level name and treats unset as none', () => {
    expect(resolveSemanticIndexValue('a.b.an_index', 'a', 'b')).toBe('a.b.an_index');
    expect(resolveSemanticIndexValue('', 'a', 'b')).toBe('');
    expect(resolveSemanticIndexValue('false', 'a', 'b')).toBe('');
  });
});
