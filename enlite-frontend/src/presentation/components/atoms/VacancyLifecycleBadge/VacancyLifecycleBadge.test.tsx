import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyLifecycleBadge } from './VacancyLifecycleBadge';
import { CICLOS_DE_VIDA } from '@domain/value-objects/vacancyLifecycle';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('VacancyLifecycleBadge — lê só o ciclo de vida (5 valores), sem mapa de valores de banco', () => {
  it.each(CICLOS_DE_VIDA)('%s → rótulo i18n do ciclo', (ciclo) => {
    render(<VacancyLifecycleBadge lifecycle={ciclo} />);
    expect(screen.getByText(`admin.vacancyDetail.lifecycle.${ciclo}`)).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-lifecycle-badge')).toHaveAttribute('data-lifecycle', ciclo);
  });

  it('texto escuro sobre fundo claro em todos os ciclos (AAA); nenhum branco-sobre-médio', () => {
    for (const ciclo of CICLOS_DE_VIDA) {
      const { unmount } = render(<VacancyLifecycleBadge lifecycle={ciclo} />);
      const cls = screen.getByTestId('vacancy-lifecycle-badge').className;
      expect(cls).toContain('text-primary');
      expect(cls).not.toContain('text-white');
      unmount();
    }
  });

  it('sem ciclo (resposta sem o campo) → "—", nunca o valor cru', () => {
    render(<VacancyLifecycleBadge lifecycle={null} />);
    expect(screen.getByTestId('vacancy-lifecycle-badge')).toHaveTextContent('—');
  });

  it('className extra é aplicado', () => {
    render(<VacancyLifecycleBadge lifecycle="aberta" className="shrink-0" />);
    expect(screen.getByTestId('vacancy-lifecycle-badge').className).toContain('shrink-0');
  });
});
