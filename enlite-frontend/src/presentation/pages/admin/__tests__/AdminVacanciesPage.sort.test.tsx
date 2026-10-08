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

  it('A14: sem clique não manda sort/order; 1º clique asc, 2º desc', async () => {
    renderPage();
    expect(lastFilters().sort).toBeUndefined();
    expect(lastFilters().order).toBeUndefined();
    const th = screen.getByTestId('vacancies-col-COMPLETED');
    await userEvent.click(within(th).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'completed', order: 'asc' });
    await userEvent.click(within(screen.getByTestId('vacancies-col-COMPLETED')).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'completed', order: 'desc' });
  });

  it('A16: estando na página 3, ordenar volta para a página 1', async () => {
    renderPage();
    const next = screen.getByLabelText('admin.vacancies.nextPage');
    await userEvent.click(next);
    await userEvent.click(next);
    expect(lastFilters().offset).toBe('40');
    await userEvent.click(within(screen.getByTestId('vacancies-col-INVITED')).getByRole('button'));
    expect(lastFilters()).toMatchObject({ sort: 'invited', order: 'asc', offset: '0' });
  });
});
