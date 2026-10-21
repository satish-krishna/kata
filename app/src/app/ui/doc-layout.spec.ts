import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import { DocLayout } from './doc-layout';

const BODY = ['# Intent: Build the plan', '', 'Lead.', '', '## Problem', '', 'After a plan is accepted, the Workbench stops.', '', '### Who hits it', '', 'Engineers.', '', '## Proposed outcome', '', 'One run.', ''].join('\n');
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
const toc = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('nav[aria-label="On this page"] button'));

/* jsdom has no scrollIntoView; stand one in that records which element it was called on. */
let scrolled: Element[];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const SHORT = ['# Photo upload at first notice of loss', '', 'Policyholders attach damage photos when they report a claim.', ''].join('\n');

describe('DocLayout', () => {
  it('draws no outline column for a document with no sections, and the text column comes first', async () => {
    const { container } = await render(DocLayout, { body: SHORT });
    const view = container.querySelector<HTMLElement>('.k-docview')!;
    expect(container.querySelector('nav[aria-label="On this page"]')).toBeNull();
    expect(view.classList.contains('k-docview--bare')).toBe(true);
    expect(Array.from(view.children).map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase())).toEqual(['doc-column', 'aside']);
  });

  it('draws the outline column, and not the bare layout, once the document has sections', async () => {
    const { container } = await render(DocLayout, { body: BODY });
    const view = container.querySelector<HTMLElement>('.k-docview')!;
    expect(view.classList.contains('k-docview--bare')).toBe(false);
    expect(Array.from(view.children).map((c) => c.tagName.toLowerCase())).toEqual(['nav', 'div', 'aside']);
  });

  it('draws the text, an outline of its sections, and a rail', async () => {
    const { container } = await render(DocLayout, { body: BODY });
    expect(container.querySelector('article h1')!.textContent).toBe('Intent: Build the plan');
    expect(toc(container).map(text)).toEqual(['Problem', 'Who hits it', 'Proposed outcome']);
    expect(container.querySelector('aside[aria-label="About this document"]')).not.toBeNull();
  });

  it('indents a third-level heading under its section in the outline', async () => {
    const { container } = await render(DocLayout, { body: BODY });
    expect(toc(container).map((b) => b.dataset['level'])).toEqual(['2', '3', '2']);
  });

  it('marks the first section as the one in view until the text scrolls', async () => {
    const { container } = await render(DocLayout, { body: BODY });
    expect(toc(container).map((b) => b.getAttribute('aria-current'))).toEqual(['location', null, null]);
  });

  it('scrolls the clicked section into view and marks it', async () => {
    const { container, fixture } = await render(DocLayout, { body: BODY });
    toc(container)[2].click();
    await fixture.whenStable();
    expect(scrolled.length).toBe(1);
    expect(scrolled[0].tagName).toBe('H2');
    expect(scrolled[0].textContent).toBe('Proposed outcome');
    expect(toc(container).map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'location']);
  });

  it('marks the last section whose heading has reached the top of the scrolling column', async () => {
    const { container, fixture } = await render(DocLayout, { body: BODY });
    const column = container.querySelector<HTMLElement>('[data-testid="doc-column"]')!;
    const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    column.getBoundingClientRect = () => rect(100);
    const tops: Record<string, number> = { Problem: -40, 'Who hits it': -10, 'Proposed outcome': 300 };
    for (const h of Array.from(container.querySelectorAll<HTMLElement>('article h1, article h2, article h3'))) {
      h.getBoundingClientRect = () => rect(100 + (tops[h.textContent!] ?? -300));
    }
    column.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    expect(toc(container).map((b) => b.getAttribute('aria-current'))).toEqual([null, 'location', null]);
  });

  it('looks a heading up inside its own document when another one on the page has the same id', async () => {
    @Component({
      imports: [DocLayout],
      template: `
        <app-doc-layout id="first" [body]="body" />
        <app-doc-layout id="second" [body]="body" />
      `,
    })
    class Two {
      readonly body = BODY;
    }
    TestBed.configureTestingModule({ imports: [Two] });
    const fixture = TestBed.createComponent(Two);
    await fixture.whenStable();
    const second = (fixture.nativeElement as HTMLElement).querySelector('#second') as HTMLElement;
    toc(second)[0].click();
    await fixture.whenStable();
    expect(scrolled.length).toBe(1);
    expect(second.contains(scrolled[0])).toBe(true);
  });

  it('has an outline entry for no heading when the text has none, and still draws the text', async () => {
    const { container } = await render(DocLayout, { body: 'Just a paragraph.' });
    expect(toc(container)).toEqual([]);
    expect(container.querySelector('article')!.textContent).toContain('Just a paragraph.');
  });

  describe('the rail', () => {
    it('lists the front matter as label and value fields', async () => {
      const { container } = await render(DocLayout, {
        body: BODY,
        fields: [['author', 'SatishKrishna Pilla'], ['context', '[kata@7226252]']],
      });
      const labels = Array.from(container.querySelectorAll('aside dt')).map(text);
      const values = Array.from(container.querySelectorAll('aside dd')).map(text);
      expect(labels).toEqual(['author', 'context']);
      expect(values).toEqual(['SatishKrishna Pilla', '[kata@7226252]']);
    });

    it('says which document uses this one, with its status in words', async () => {
      const { container } = await render(DocLayout, { body: BODY, usedBy: { name: 'spec.md', status: { text: 'Draft', tone: 'warning' } } });
      const section = container.querySelector('[data-testid="used-by"]')!;
      expect(text(section)).toContain('Used by');
      expect(text(section)).toContain('spec.md');
      expect(text(section)).toContain('Draft');
      expect(section.querySelector('.k-status--warning')).not.toBeNull();
    });

    it('leaves Used by out when nothing uses this document', async () => {
      const { container } = await render(DocLayout, { body: BODY, usedBy: null });
      expect(container.querySelector('[data-testid="used-by"]')).toBeNull();
    });

    it('lists recent runs as kind and time with the total, and links nowhere', async () => {
      const { container } = await render(DocLayout, {
        body: BODY,
        runs: [
          { id: 'r2', kind: 'Intent', time: 'Oct 20 10:05', tone: 'success', exit: 0 },
          { id: 'r1', kind: 'Intent', time: 'Oct 19 18:12', tone: 'error', exit: 1 },
        ],
        runTotal: 5,
      });
      const section = container.querySelector('[data-testid="recent-runs"]')!;
      expect(text(section.querySelector('h2')!)).toBe('Recent runs · 5');
      expect(Array.from(section.querySelectorAll('li')).map(text)).toEqual(['Succeeded Intent Oct 20 10:05', 'Failed Intent Oct 19 18:12']);
      expect(section.querySelector('a, button')).toBeNull();
    });

    it('says how each run ended in words, not by the color of its dot alone', async () => {
      const { container } = await render(DocLayout, {
        body: BODY,
        runs: [
          { id: 'r3', kind: 'Spec', time: 'Oct 21 09:00', tone: 'success', exit: 0 },
          { id: 'r2', kind: 'Spec', time: 'Oct 20 10:05', tone: 'error', exit: 1 },
          { id: 'r1', kind: 'Spec', time: 'Oct 19 18:12', tone: 'idle', exit: null },
        ],
        runTotal: 3,
      });
      const rows = Array.from(container.querySelectorAll('[data-testid="recent-runs"] li'));
      expect(rows.map((r) => /Succeeded|Failed|No result/.exec(text(r))?.[0])).toEqual(['Succeeded', 'Failed', 'No result']);
      // The word is on screen for everyone, so the dot beside it is decoration, not a second announcement.
      expect(container.querySelectorAll('[data-testid="recent-runs"] [role="img"]').length).toBe(0);
    });

    it('says there are no runs yet when there are none', async () => {
      const { container } = await render(DocLayout, { body: BODY });
      expect(text(container.querySelector('[data-testid="recent-runs"]')!)).toContain('No runs yet');
    });
  });

  it('projects extra content under the text', async () => {
    @Component({ imports: [DocLayout], template: `<app-doc-layout [body]="body"><p id="extra">Build log</p></app-doc-layout>` })
    class Host {
      readonly body = BODY;
    }
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="doc-column"] #extra')).not.toBeNull();
  });
});
