import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppGroupEditor } from './AppGroupEditor';

describe('Teams editor labels', () => {
  it('states that Teams organize Monitoring and grant no access', () => {
    const markup = renderToStaticMarkup(<AppGroupEditor canManage />);
    expect(markup).toContain('Teams');
    expect(markup).toContain('Monitoring');
    expect(markup).toContain('grant no access');
    expect(markup).not.toContain('Unity Catalog');
  });
});
