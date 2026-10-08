import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';

describe('VacanciesTable - Integration Test - GARANTIA DE RENDERIZAÇÃO', () => {
  it('CRITICAL: should render real API data structure on screen', () => {
    const realApiData: VacancyRow[] = [
      {
        id: 'fd269cde-d8c9-4fdc-88a9-5b19ebcdb531',
        caseNumber: 349, caseOrdinal: 1,
        status: 'Esperando Ativação',
        diasAberto: '05',
        stageCounts: {
          COMPATIBLE: 6,
          INVITED: 32,
          INICIADO: 9,
          PRE_SCREENING: 5,
          COMPLETED: 3,
          CONFIRMED: 43,
          SELECTED: 27,
          QUICK_RESPONSE_TEAM: 7,
          REJECTED: 2,
        },
        postulados: '115',
        faltantes: '00',
        isDraft: false,
        lastActionAt: null,
      },
      {
        id: 'c83963ee-beaf-45f2-88a3-365147b0c205',
        caseNumber: 348, caseOrdinal: 1,
        status: 'Esperando Ativação',
        diasAberto: '03',
        stageCounts: {
          COMPATIBLE: 8,
          INVITED: 16,
          INICIADO: 41,
          PRE_SCREENING: 18,
          COMPLETED: 11,
          CONFIRMED: 19,
          SELECTED: 61,
          QUICK_RESPONSE_TEAM: 4,
          REJECTED: 10,
        },
        postulados: '52',
        faltantes: '01',
        isDraft: false,
        lastActionAt: null,
      },
    ];

    const { container } = render(<VacanciesTable vacancies={realApiData} />);

    // GARANTIA 1: Casos visíveis
    expect(screen.getByText('349#01')).toBeVisible();
    expect(screen.getByText('348#01')).toBeVisible();

    // GARANTIA 2: Status visível (aparece 2x)
    const statusElements = screen.getAllByText('Esperando Ativação');
    expect(statusElements).toHaveLength(2);
    statusElements.forEach((el) => expect(el).toBeVisible());

    // GARANTIA 3: sem coluna de prioridade (spec 046 F1)
    expect(screen.queryByText('admin.vacancies.priorityOptions.urgent')).not.toBeInTheDocument();

    // GARANTIA 4: Dados numéricos visíveis (stageCounts das 9 colunas, Fase 5: +COMPATIBLE, + postulados/faltantes)
    expect(screen.getByText('06')).toBeVisible();
    expect(screen.getByText('32')).toBeVisible();
    expect(screen.getByText('09')).toBeVisible();
    expect(screen.getByText('05')).toBeVisible();
    expect(screen.getByText('03')).toBeVisible();
    // CONFIRMED (43 e 19) segue no payload mas a lista não o mostra mais
    expect(screen.queryByText('43')).not.toBeInTheDocument();
    expect(screen.queryByText('19')).not.toBeInTheDocument();
    expect(screen.getByText('27')).toBeVisible();
    expect(screen.getByText('07')).toBeVisible();
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
    expect(allText).toContain('349#01');
    expect(allText).toContain('348#01');
  });

  it('CRITICAL: should NOT render when vacancies array is empty', () => {
    render(<VacanciesTable vacancies={[]} />);
    expect(screen.queryByText('349#01')).not.toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });

  it('CRITICAL: should handle null/undefined gracefully', () => {
    // @ts-expect-error - testing runtime safety
    render(<VacanciesTable vacancies={null} />);
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });
});
