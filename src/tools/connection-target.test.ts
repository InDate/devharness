import { describe, it, expect } from 'vitest';
import { choosePageTarget, type PageTarget } from './connection-tools.js';

const pages: PageTarget[] = [
  { id: 'A1', title: 'header', url: 'file:///tools/header/index.html' },
  { id: 'B2', title: 'sidebar', url: 'file:///tools/sidebar/index.html' },
  { id: 'C3', title: 'sidebar wide', url: 'file:///tools/sidebar-wide/index.html' },
];

describe('choosePageTarget', () => {
  it('takes an exact id, then an exact title, before any piece of a title or URL', () => {
    expect(choosePageTarget(pages, 'C3')).toEqual({ kind: 'one', page: pages[2] });
    expect(choosePageTarget(pages, 'sidebar')).toEqual({ kind: 'one', page: pages[1] });
    expect(choosePageTarget(pages, 'header/index')).toEqual({ kind: 'one', page: pages[0] });
  });

  it('names every match where a piece fits several, and none where it fits nothing', () => {
    expect(choosePageTarget(pages, 'side')).toEqual({ kind: 'several', matches: [pages[1], pages[2]] });
    expect(choosePageTarget(pages, 'footer')).toEqual({ kind: 'none' });
  });
});
