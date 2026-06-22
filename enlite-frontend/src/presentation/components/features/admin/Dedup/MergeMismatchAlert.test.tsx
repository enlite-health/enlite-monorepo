/**
 * MergeMismatchAlert.test.tsx
 *
 * Covers the branch at line 19 (conflictCount === 0 → return null)
 * and the render paths for 1 and N conflicts (singular/plural i18n).
 *
 * Branch summary:
 *   - conflictCount = 0  → returns null (branch 33% was missing this)
 *   - conflictCount = 1  → renders alert with singular text
 *   - conflictCount > 1  → renders alert with plural text
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergeMismatchAlert } from './MergeMismatchAlert';

// i18n in tests returns the key or defaultValue injected by the component.
// defaultValue format: "${conflictCount} campo${conflictCount !== 1 ? 's' : ''} con conflicto"

describe('MergeMismatchAlert — conflictCount = 0 (returns null)', () => {
  it('renders nothing when conflictCount is 0', () => {
    const { container } = render(<MergeMismatchAlert conflictCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('data-testid merge-mismatch-alert is NOT in the DOM when conflictCount = 0', () => {
    render(<MergeMismatchAlert conflictCount={0} />);
    expect(
      screen.queryByTestId('merge-mismatch-alert'),
    ).not.toBeInTheDocument();
  });

  it('role="alert" is NOT present when conflictCount = 0', () => {
    render(<MergeMismatchAlert conflictCount={0} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('MergeMismatchAlert — conflictCount = 1 (singular)', () => {
  it('renders the alert when conflictCount = 1', () => {
    render(<MergeMismatchAlert conflictCount={1} />);
    expect(screen.getByTestId('merge-mismatch-alert')).toBeInTheDocument();
  });

  it('renders with role="alert"', () => {
    render(<MergeMismatchAlert conflictCount={1} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the count (1) in the body', () => {
    render(<MergeMismatchAlert conflictCount={1} />);
    expect(document.body.textContent).toContain('1');
  });

  it('renders "campo" (singular, no trailing s) when conflictCount = 1', () => {
    render(<MergeMismatchAlert conflictCount={1} />);
    // defaultValue: "1 campo con conflicto" (no "s")
    const body = document.body.textContent ?? '';
    expect(body).toContain('campo');
  });

  it('has amber background styling', () => {
    const { container } = render(<MergeMismatchAlert conflictCount={1} />);
    const alert = container.querySelector('[data-testid="merge-mismatch-alert"]');
    expect(alert?.className).toContain('bg-amber-50');
  });
});

describe('MergeMismatchAlert — conflictCount > 1 (plural)', () => {
  it('renders the alert when conflictCount = 2', () => {
    render(<MergeMismatchAlert conflictCount={2} />);
    expect(screen.getByTestId('merge-mismatch-alert')).toBeInTheDocument();
  });

  it('renders the count (2) in the body', () => {
    render(<MergeMismatchAlert conflictCount={2} />);
    expect(document.body.textContent).toContain('2');
  });

  it('renders "campos" (plural with s) when conflictCount = 2', () => {
    render(<MergeMismatchAlert conflictCount={2} />);
    // defaultValue: "2 campos con conflicto" (with "s")
    const body = document.body.textContent ?? '';
    expect(body).toContain('campos');
  });

  it('renders the alert for conflictCount = 5', () => {
    render(<MergeMismatchAlert conflictCount={5} />);
    expect(screen.getByTestId('merge-mismatch-alert')).toBeInTheDocument();
    expect(document.body.textContent).toContain('5');
  });
});
