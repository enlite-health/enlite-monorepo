import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PersonAvatar } from '../PersonAvatar';

describe('PersonAvatar (spec 022, Rodada 2/R2-F — núcleo extraído de MessageAvatar)', () => {
  it('mostra as iniciais do nome', () => {
    render(<PersonAvatar uid="u-1" name="QA Staff Um" />);
    expect(screen.getByTestId('person-avatar')).toHaveTextContent('QS');
  });

  it('mesmo uid SEMPRE produz a MESMA cor (determinístico)', () => {
    const { unmount } = render(<PersonAvatar uid="staff-um" name="A" />);
    const class1 = screen.getByTestId('person-avatar').className;
    unmount();
    render(<PersonAvatar uid="staff-um" name="B" />);
    expect(screen.getByTestId('person-avatar').className).toBe(class1);
  });

  it('sem presence: nenhuma bolinha, DOM idêntico ao comportamento antigo (uma única div)', () => {
    const { container } = render(<PersonAvatar uid="u-1" name="X" />);
    expect(screen.queryByTestId('presence-dot')).not.toBeInTheDocument();
    // uma única div (sem wrapper extra) — a raiz do container É o próprio avatar.
    expect(container.firstElementChild).toBe(screen.getByTestId('person-avatar'));
  });

  it('presence="online": mostra a bolinha verde', () => {
    render(<PersonAvatar uid="u-1" name="X" presence="online" />);
    const dot = screen.getByTestId('presence-dot');
    expect(dot.className).toMatch(/bg-green-500/);
  });

  it('presence="offline": mostra a bolinha cinza', () => {
    render(<PersonAvatar uid="u-1" name="X" presence="offline" />);
    const dot = screen.getByTestId('presence-dot');
    expect(dot.className).toMatch(/bg-gray-400/);
  });

  it('data-testid customizável (MessageAvatar reusa com "message-avatar")', () => {
    render(<PersonAvatar uid="u-1" name="X" data-testid="custom-avatar" />);
    expect(screen.getByTestId('custom-avatar')).toBeInTheDocument();
  });
});
