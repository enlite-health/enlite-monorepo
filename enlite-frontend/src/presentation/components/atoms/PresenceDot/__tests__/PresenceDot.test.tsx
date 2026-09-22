import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceDot } from '../PresenceDot';

describe('PresenceDot (spec 022, Rodada 2/R2-F)', () => {
  it('online: verde + aria-label distinto', () => {
    render(<PresenceDot presence="online" />);
    const dot = screen.getByTestId('presence-dot');
    expect(dot.className).toMatch(/bg-green-500/);
    expect(dot).toHaveAttribute('role', 'img');
    expect(dot.getAttribute('aria-label')).toBeTruthy();
  });

  it('offline: cinza + aria-label diferente do online', () => {
    const { unmount } = render(<PresenceDot presence="online" />);
    const onlineLabel = screen.getByTestId('presence-dot').getAttribute('aria-label');
    unmount();
    render(<PresenceDot presence="offline" />);
    const dot = screen.getByTestId('presence-dot');
    expect(dot.className).toMatch(/bg-gray-400/);
    expect(dot.getAttribute('aria-label')).not.toBe(onlineLabel);
  });
});
