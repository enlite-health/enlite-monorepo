/**
 * Spec 046 F4 — A14/A16 no nível da página: sort/order entram nos filtros e a ordem volta à página 1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminVacanciesPage } from '../AdminVacanciesPage';

const useVacanciesData = vi.fn();
vi.mock('@hooks/admin/useVacanciesData', () => ({
  useVacanciesData: (f: unknown) => useVacanciesData(f),
}));
const lastFilters = () => useVacanciesData.mock.calls[useVacanciesData.mock.calls.length - 1][0] as Record<string, string>;

function renderPage() {
  return render(<MemoryRouter><AdminVacanciesPage /></MemoryRouter>);
}

describe('AdminVacanciesPage — ordenação', () => {
  beforeEach(() => {
    useVacanciesData.mockReset();
    useVacanciesData.mockReturnValue({
      vacancies: [], stats: [], total: 200, isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('A14: sem clique não manda sort/order; 1º clique desc, 2º asc', async () => {
    renderPage();
    expect(lastFilters().sort).toBeUndefined();
    expect(lastFilters().order).toBeUndefined();
    const th = screen.getByTestId('vacancies-col-COMPLETED');
    await userEvent.click(within(th).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'completed', order: 'desc' });
    await userEvent.click(within(screen.getByTestId('vacancies-col-COMPLETED')).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'completed', order: 'asc' });
  });

  it('A16: estando na página 3, ordenar volta para a página 1', async () => {
    renderPage();
    const next = screen.getByLabelText('admin.vacancies.nextPage');
    await userEvent.click(next);
    await userEvent.click(next);
    expect(lastFilters().offset).toBe('40');
    await userEvent.click(within(screen.getByTestId('vacancies-col-INVITED')).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'invited', order: 'desc', offset: '0' });
  });

  it('refetch (isLoading=true) não troca a tabela pelo esqueleto: o botão focado do cabeçalho continua o mesmo', async () => {
    // 1ª carga: dados prontos. Depois de ordenar, o hook liga isLoading (como o real a cada busca).
    useVacanciesData.mockImplementation((f: Record<string, string>) => ({
      vacancies: [], stats: [], total: 200, isLoading: !!f.sort, error: null, refetch: vi.fn(),
    }));
    renderPage();
    const botao = within(screen.getByTestId('vacancies-col-COMPLETED')).getByRole('button');
    await userEvent.click(botao);
    expect(lastFilters().sort).toBe('completed');
    expect(useVacanciesData.mock.results[useVacanciesData.mock.results.length - 1].value.isLoading).toBe(true);

    const depois = within(screen.getByTestId('vacancies-col-COMPLETED')).getByRole('button');
    expect(depois).toBe(botao);
    expect(botao.isConnected).toBe(true);
    expect(document.activeElement).toBe(botao);
    expect(screen.getByTestId('vacancies-table-region')).toHaveAttribute('aria-busy', 'true');
  });

  it('na 1ª carga (sem dados ainda) mostra o esqueleto, não a tabela', () => {
    useVacanciesData.mockReturnValue({
      vacancies: [], stats: [], total: 0, isLoading: true, error: null, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.queryByTestId('vacancies-col-COMPLETED')).toBeNull();
  });
});
