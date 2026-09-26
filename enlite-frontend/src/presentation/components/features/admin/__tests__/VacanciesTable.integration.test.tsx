import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';

describe('VacanciesTable - Integration Test - GARANTIA DE RENDERIZAÇÃO', () => {
  it('CRITICAL: should render real API data structure on screen', () => {
    const realApiData: VacancyRow[] = [
      {
        id: 'fd269cde-d8c9-4fdc-88a9-5b19ebcdb531',
        caso: 'Caso 349',
        status: 'Esperando Ativação',
        priority: 'URGENT',
        diasAberto: '05',
        stageCounts: {
          INVITED: 32,
          INICIADO: 9,
          PRE_SCREENING: 5,
          COMPLETED: 3,
          CONFIRMED: 43,
          SELECTED: 27,
          REJECTED: 2,
        },
        postulados: '115',
        faltantes: '00',
        isDraft: false,
        lastActionAt: null,
        daysWithoutDivulgation: null,
      },
      {
        id: 'c83963ee-beaf-45f2-88a3-365147b0c205',
        caso: 'Caso 348',
        status: 'Esperando Ativação',
        priority: 'NORMAL',
        diasAberto: '03',
        stageCounts: {
          INVITED: 16,
          INICIADO: 41,
          PRE_SCREENING: 18,
          COMPLETED: 11,
          CONFIRMED: 19,
          SELECTED: 61,
          REJECTED: 10,
        },
        postulados: '52',
        faltantes: '01',
        isDraft: false,
        lastActionAt: null,
        daysWithoutDivulgation: null,
      },
    ];

    const { container } = render(<VacanciesTable vacancies={realApiData} />);

    // GARANTIA 1: Casos visíveis
    expect(screen.getByText('Caso 349')).toBeVisible();
    expect(screen.getByText('Caso 348')).toBeVisible();

    // GARANTIA 2: Status visível (aparece 2x)
    const statusElements = screen.getAllByText('Esperando Ativação');
    expect(statusElements).toHaveLength(2);
    statusElements.forEach((el) => expect(el).toBeVisible());

    // GARANTIA 3: Priority badge renderizado
    expect(screen.getByText('admin.vacancies.priorityOptions.urgent')).toBeVisible();
    expect(screen.getByText('admin.vacancies.priorityOptions.normal')).toBeVisible();

    // GARANTIA 4: Dados numéricos visíveis (stageCounts das 7 colunas + postulados/faltantes)
    expect(screen.getByText('32')).toBeVisible();
    expect(screen.getByText('09')).toBeVisible();
    expect(screen.getByText('05')).toBeVisible();
    expect(screen.getByText('03')).toBeVisible();
    expect(screen.getByText('43')).toBeVisible();
    expect(screen.getByText('27')).toBeVisible();
    expect(screen.getByText('02')).toBeVisible();
    expect(screen.getByText('115')).toBeVisible();
    expect(screen.getByText('00')).toBeVisible();

    // GARANTIA 5: 2 linhas de dados
    const dataRows = container.querySelectorAll('[class*="h-[72px]"]');
    expect(dataRows).toHaveLength(2);

    // GARANTIA 6: empty state ausente
    expect(screen.queryByText('admin.vacancies.noVacancies')).not.toBeInTheDocument();

    // GARANTIA 7: textContent OK
    const allText = container.textContent;
    expect(allText).toContain('Caso 349');
    expect(allText).toContain('Caso 348');
  });

  it('CRITICAL: should NOT render when vacancies array is empty', () => {
    render(<VacanciesTable vacancies={[]} />);
    expect(screen.queryByText('Caso 349')).not.toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });

  it('CRITICAL: should handle null/undefined gracefully', () => {
    // @ts-expect-error - testing runtime safety
    render(<VacanciesTable vacancies={null} />);
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });
});
