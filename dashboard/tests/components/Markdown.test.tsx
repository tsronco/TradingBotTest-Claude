import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown from '../../src/components/Markdown';

describe('Markdown', () => {
  it('renders a GitHub-style pipe table as a real <table>', () => {
    const md = [
      '| Name shown | Also known as | Bias |',
      '|---|---|---|',
      '| Bull Call Spread | Call debit spread | Bullish |',
      '| Bull Put Spread | Put credit spread | Bullish / neutral |',
    ].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // header + both data rows landed in real cells
    expect(screen.getByText('Also known as')).toBeTruthy();
    expect(screen.getByText('Call debit spread')).toBeTruthy();
    expect(screen.getByText('Put credit spread')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('renders headings, bold, and links', () => {
    const { container } = render(
      <Markdown>{'# Title\n\nsome **bold** and a [link](https://example.com)'}</Markdown>,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
  });

  it('does not inject raw HTML (script/img are escaped, not rendered)', () => {
    const { container } = render(
      <Markdown>{'hello <img src=x onerror=alert(1)> <b>world</b>'}</Markdown>,
    );
    // No raw HTML elements from the string should exist in the DOM.
    expect(container.querySelector('img')).toBeNull();
    // The <b> in the source is not honored as markup either.
    expect(container.querySelector('b')).toBeNull();
  });
});
