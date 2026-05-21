import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Changelog from '../../src/routes/Changelog';
import { CHANGELOG } from '../../src/data/changelog';

function renderPage() {
  return render(
    <MemoryRouter>
      <Changelog />
    </MemoryRouter>,
  );
}

describe('Changelog page', () => {
  it('renders the header and at least one entry', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /changelog/i })).toBeInTheDocument();
    expect(screen.getByText(CHANGELOG[0].title)).toBeInTheDocument();
  });

  it('entries are sorted newest first', () => {
    // Validates the data file — we depend on hand-ordering.
    for (let i = 0; i < CHANGELOG.length - 1; i++) {
      expect(CHANGELOG[i].date >= CHANGELOG[i + 1].date).toBe(true);
    }
  });

  it('every entry has a valid category and YYYY-MM-DD date', () => {
    const validCategories = new Set(['feature', 'fix', 'config', 'engine', 'ui', 'infra']);
    for (const e of CHANGELOG) {
      expect(validCategories.has(e.category)).toBe(true);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.length).toBeGreaterThan(0);
    }
  });

  it('clicking an entry with details expands it; clicking again collapses', () => {
    const firstWithDetails = CHANGELOG.find((e) => e.details);
    expect(firstWithDetails).toBeDefined();

    renderPage();
    const row = screen.getByText(firstWithDetails!.title).closest('button');
    expect(row).toBeInTheDocument();

    // The details substring shouldn't be visible until expanded. Use a snippet
    // of the details that's unlikely to appear in the title.
    const snippet = firstWithDetails!.details!.slice(0, 30);
    expect(screen.queryByText(new RegExp(snippet.slice(0, 20)))).toBeNull();

    fireEvent.click(row!);
    expect(screen.getByText((content) => content.includes(snippet.slice(0, 20)))).toBeInTheDocument();

    fireEvent.click(row!);
    expect(screen.queryByText(new RegExp(snippet.slice(0, 20)))).toBeNull();
  });

  it('category filter restricts visible entries', () => {
    renderPage();
    const featureChip = screen.getByRole('button', { name: '[feature]' });
    fireEvent.click(featureChip);

    const featuresInData = CHANGELOG.filter((e) => e.category === 'feature');
    expect(featuresInData.length).toBeGreaterThan(0);
    expect(screen.getByText(featuresInData[0].title)).toBeInTheDocument();

    const nonFeature = CHANGELOG.find((e) => e.category !== 'feature');
    if (nonFeature) {
      expect(screen.queryByText(nonFeature.title)).toBeNull();
    }
  });
});
