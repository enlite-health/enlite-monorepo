import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageAvatar } from '../MessageAvatar';

describe('MessageAvatar', () => {
  it('mostra as 2 iniciais do nome (primeira letra das 2 primeiras palavras)', () => {
    render(<MessageAvatar uid="u-1" name="QA Staff Um" />);
    expect(screen.getByTestId('message-avatar')).toHaveTextContent('QS');
  });

  it('nome de uma palavra só: 1 inicial (nunca quebra)', () => {
    render(<MessageAvatar uid="u-1" name="Marcel" />);
    expect(screen.getByTestId('message-avatar')).toHaveTextContent('M');
  });

  it('nome vazio (uid cru como fallback, sem espaço): usa a 1ª letra, nunca "?"', () => {
    render(<MessageAvatar uid="u-1" name="staff-um" />);
    expect(screen.getByTestId('message-avatar')).toHaveTextContent('S');
  });

  it('mesmo uid SEMPRE produz a MESMA cor (determinístico)', () => {
    const { unmount } = render(<MessageAvatar uid="staff-um" name="A" />);
    const class1 = screen.getByTestId('message-avatar').className;
    unmount();
    render(<MessageAvatar uid="staff-um" name="B" />);
    const class2 = screen.getByTestId('message-avatar').className;
    expect(class1).toBe(class2);
  });

  it('uids diferentes podem produzir cores diferentes — só os 4 tokens ≥4.5:1 com branco (medido, ver comentário do componente)', () => {
    const allowed = ['bg-primary', 'bg-new-car', 'bg-clinic', 'bg-blue-yonder'];
    for (const uid of ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'staff-um', 'staff-dois']) {
      const { unmount } = render(<MessageAvatar uid={uid} name="X" />);
      const cls = screen.getByTestId('message-avatar').className;
      expect(allowed.some((token) => cls.includes(token))).toBe(true);
      unmount();
    }
  });
});
