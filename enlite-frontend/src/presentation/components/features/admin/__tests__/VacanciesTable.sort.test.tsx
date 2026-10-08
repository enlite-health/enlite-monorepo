/**
 * Spec 046 F4 — cabeçalho ordenável da lista de vacantes (A14/A15/A18 no nível do componente).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacanciesTable } from '../VacanciesTable';

const ORDENAVEIS: Array<[string, string]> = [
  ['COMPATIBLE', 'compatible'],
  ['INVITED', 'invited'],
  ['INICIADO', 'iniciado'],
  ['PRE_SCREENING', 'preScreening'],
  ['COMPLETED', 'completed'],
  ['SELECTED', 'selected'],
  ['QUICK_RESPONSE_TEAM', 'quickResponseTeam'],
  ['REJECTED', 'rejected'],
  ['applicants', 'postulados'],
  ['missing', 'faltantes'],
  ['last-action', 'lastActionAt'],
];

describe('VacanciesTable — ordenação pelo cabeçalho', () => {
  it.each(ORDENAVEIS)('coluna %s chama onSort("%s")', async (col, sortKey) => {
    const onSort = vi.fn();
    render(<VacanciesTable vacancies={[]} sort={null} onSort={onSort} />);
    const th = screen.getByTestId(`vacancies-col-${col}`);
    await userEvent.click(within(th).getByRole('button'));
    expect(onSort).toHaveBeenCalledWith(sortKey);
  });

  it('Caso e Status não têm botão nem ícone e o clique não chama onSort', async () => {
    const onSort = vi.fn();
    render(<VacanciesTable vacancies={[]} sort={null} onSort={onSort} />);
    for (const col of ['case', 'status']) {
      const th = screen.getByTestId(`vacancies-col-${col}`);
      expect(within(th).queryByRole('button')).toBeNull();
      expect(th.hasAttribute('aria-sort')).toBe(false);
      await userEvent.click(th);
    }
    expect(onSort).not.toHaveBeenCalled();
  });

  it('só a coluna ativa mostra ícone e aria-sort', () => {
    render(<VacanciesTable vacancies={[]} sort={{ key: 'completed', direction: 'asc' }} onSort={vi.fn()} />);
    const ativa = screen.getByTestId('vacancies-col-COMPLETED');
    expect(ativa).toHaveAttribute('aria-sort', 'ascending');
    expect(ativa.querySelector('[data-sort-icon="asc"]')).not.toBeNull();
    const outra = screen.getByTestId('vacancies-col-INVITED');
    expect(outra).toHaveAttribute('aria-sort', 'none');
    expect(outra.querySelector('[data-sort-icon]')).toBeNull();
  });
});
