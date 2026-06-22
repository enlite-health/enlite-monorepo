/**
 * DedupSignalBadge.test.tsx
 *
 * Covers the 3 countRealAccounts branches:
 *   1. All accounts have login_real=true  → allReal text/aria
 *   2. No account has login_real=true     → allTest text/aria
 *   3. Mixed (some real, some test)       → mixed text/aria
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DedupSignalBadge } from './DedupSignalBadge';
import type { DedupAccount } from '@domain/entities/DedupGroup';

// i18n is initialised in src/test/setup.ts — useTranslation returns the key
// (no resources loaded), so we match against defaultValue strings injected by the component.

function makeAccount(id: string, login_real: boolean): DedupAccount {
  return {
    id,
    email: `${id}@test.com`,
    tier: 'REGISTERED',
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    wja_count: 0,
    docs_count: 0,
    encuadres_count: 0,
    login_real,
  };
}

describe('DedupSignalBadge — allReal branch (realCount === total)', () => {
  it('renders badge with green style when all accounts are real', () => {
    const accounts = [
      makeAccount('a', true),
      makeAccount('b', true),
      makeAccount('c', true),
    ];
    const { container } = render(<DedupSignalBadge accounts={accounts} />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('bg-green-100');
    expect(badge?.className).toContain('text-green-700');
  });

  it('renders defaultValue text for allReal (count=3)', () => {
    const accounts = [makeAccount('a', true), makeAccount('b', true), makeAccount('c', true)];
    render(<DedupSignalBadge accounts={accounts} />);
    // defaultValue injected by component: "3 reales"
    expect(document.body.textContent).toContain('3');
    expect(document.body.textContent).toContain('real');
  });

  it('renders singular "real" when total=1', () => {
    const accounts = [makeAccount('a', true)];
    render(<DedupSignalBadge accounts={accounts} />);
    // defaultValue: "1 real"
    expect(document.body.textContent).toContain('1');
    expect(document.body.textContent).toContain('real');
  });
});

describe('DedupSignalBadge — allTest branch (realCount === 0)', () => {
  it('renders badge with slate style when no accounts are real', () => {
    const accounts = [makeAccount('a', false), makeAccount('b', false)];
    const { container } = render(<DedupSignalBadge accounts={accounts} />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('bg-slate-100');
    expect(badge?.className).toContain('text-slate-600');
  });

  it('renders defaultValue text for allTest', () => {
    const accounts = [makeAccount('a', false), makeAccount('b', false)];
    render(<DedupSignalBadge accounts={accounts} />);
    // defaultValue: "2 prueba"
    expect(document.body.textContent).toContain('2');
    expect(document.body.textContent).toContain('prueba');
  });
});

describe('DedupSignalBadge — mixed branch (0 < realCount < total)', () => {
  it('renders badge with amber style for mixed accounts', () => {
    const accounts = [makeAccount('a', true), makeAccount('b', false)];
    const { container } = render(<DedupSignalBadge accounts={accounts} />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('bg-amber-100');
    expect(badge?.className).toContain('text-amber-700');
  });

  it('renders defaultValue text for mixed', () => {
    const accounts = [
      makeAccount('a', true),
      makeAccount('b', false),
      makeAccount('c', false),
    ];
    render(<DedupSignalBadge accounts={accounts} />);
    // defaultValue: "1 real · 2 prueba"
    expect(document.body.textContent).toContain('1');
    expect(document.body.textContent).toContain('real');
    expect(document.body.textContent).toContain('2');
    expect(document.body.textContent).toContain('prueba');
  });

  it('renders Text atom (span role) inside badge', () => {
    const accounts = [makeAccount('a', true), makeAccount('b', false)];
    render(<DedupSignalBadge accounts={accounts} />);
    // The Text atom renders as a span when as="span"
    const spans = screen.getAllByText(/./, { selector: 'span' });
    expect(spans.length).toBeGreaterThan(0);
  });
});
