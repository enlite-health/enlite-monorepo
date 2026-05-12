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
        convidados: '329',
        postulados: '115',
        selecionados: '27',
        faltantes: '00',
      },
      {
        id: 'c83963ee-beaf-45f2-88a3-365147b0c205',
        caso: 'Caso 348',
        status: 'Esperando Ativação',
        priority: 'NORMAL',
        diasAberto: '03',
        convidados: '164',
        postulados: '52',
        selecionados: '06',
        faltantes: '00',
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

    // GARANTIA 4: Dados numéricos visíveis
    expect(screen.getByText('329')).toBeVisible();
    expect(screen.getByText('115')).toBeVisible();
    expect(screen.getByText('27')).toBeVisible();
    expect(screen.getByText('164')).toBeVisible();
    expect(screen.getByText('52')).toBeVisible();
    expect(screen.getByText('06')).toBeVisible();

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
