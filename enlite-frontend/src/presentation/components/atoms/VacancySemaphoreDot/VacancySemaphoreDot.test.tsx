import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancySemaphoreDot } from './VacancySemaphoreDot';
import { SEMAPHORE_COLORS } from '@domain/value-objects/vacancySemaphore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { color?: string; n?: number }) => (opts?.n !== undefined ? `${key}|${opts.color}|${opts.n}` : key),
  }),
}));

const dot = () => screen.getByTestId('vacancy-semaphore-dot');

describe('VacancySemaphoreDot — pinta a cor recebida e não decide nada', () => {
  it.each(SEMAPHORE_COLORS)('%s → data-color e a classe de token da cor', (color) => {
    render(<VacancySemaphoreDot value={{ color, n: 3 }} />);
    expect(dot()).toHaveAttribute('data-color', color);
    expect(dot().querySelector('[data-part="circle"]')!.className).toContain(`bg-${{ red: 'red', yellow: 'amber', green: 'green' }[color]}-600`);
  });

  it('n = 0 com color green pinta VERDE (o front não decide a cor pelo n)', () => {
    render(<VacancySemaphoreDot value={{ color: 'green', n: 0 }} />);
    expect(dot()).toHaveAttribute('data-color', 'green');
    expect(dot()).toHaveAttribute('aria-label', 'admin.semaphore.dotAria|admin.semaphore.colors.green|0');
  });

  it('n = 99 com color red pinta VERMELHO', () => {
    render(<VacancySemaphoreDot value={{ color: 'red', n: 99 }} />);
    expect(dot()).toHaveAttribute('data-color', 'red');
  });

  it('com n: mostra o número ao lado, em texto escuro (AAA), e o aria-label traz a palavra da cor', () => {
    render(<VacancySemaphoreDot value={{ color: 'yellow', n: 9 }} />);
    expect(screen.getByText('9').className).toContain('text-primary');
    expect(dot()).toHaveAttribute('title', 'admin.semaphore.dotAria|admin.semaphore.colors.yellow|9');
  });

  it('sem n (pior cor do paciente): aria-label é só a cor e nenhum número aparece', () => {
    render(<VacancySemaphoreDot value={{ color: 'red' }} />);
    expect(dot()).toHaveAttribute('aria-label', 'admin.semaphore.colors.red');
    expect(dot().textContent).toBe('');
  });

  it("display='dotOnly': sem número visível, mas o aria-label e o title carregam o n", () => {
    render(<VacancySemaphoreDot value={{ color: 'green', n: 10 }} display="dotOnly" />);
    expect(dot().textContent).toBe('');
    expect(dot()).toHaveAttribute('aria-label', 'admin.semaphore.dotAria|admin.semaphore.colors.green|10');
    expect(dot()).toHaveAttribute('title', 'admin.semaphore.dotAria|admin.semaphore.colors.green|10');
    expect(dot().querySelector('[data-part="circle"]')).not.toBeNull();
  });

  it('null → "—" com admin.semaphore.none, sem cor', () => {
    render(<VacancySemaphoreDot value={null} />);
    expect(dot()).toHaveAttribute('data-color', 'none');
    expect(dot()).toHaveAttribute('aria-label', 'admin.semaphore.none');
    expect(dot()).toHaveTextContent('—');
  });

  it('testId opcional substitui o padrão', () => {
    render(<VacancySemaphoreDot value={{ color: 'green', n: 1 }} testId="meu-dot" />);
    expect(screen.getByTestId('meu-dot')).toHaveAttribute('data-color', 'green');
  });
});
