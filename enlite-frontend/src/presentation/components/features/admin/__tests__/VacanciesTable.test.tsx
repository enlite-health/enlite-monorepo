import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';

describe('VacanciesTable', () => {
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
    },
  ];

  it('should render table headers (case, status, priority, as 7 colunas do funil, applicants, missing)', () => {
    render(<VacanciesTable vacancies={[]} />);

    expect(screen.getByText('admin.vacancies.table.case')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.status')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.priority')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.INVITED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.INICIADO')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.PRE_SCREENING')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.CONFIRMED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.SELECTED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.REJECTED')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.applicants')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.missing')).toBeInTheDocument();
  });

  it('should NOT render the removed dependencyLevel column', () => {
    render(<VacanciesTable vacancies={[]} />);
    expect(screen.queryByText('admin.vacancies.table.dependencyLevel')).not.toBeInTheDocument();
  });

  it('should render "no vacancies" message when array is empty', () => {
    render(<VacanciesTable vacancies={[]} />);
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });

  it('should render vacancy rows when data is provided', () => {
    render(<VacanciesTable vacancies={realApiData} />);

    expect(screen.getByText('Caso 349')).toBeInTheDocument();
    expect(screen.getByText('Caso 348')).toBeInTheDocument();

    const statusElements = screen.getAllByText('Esperando Ativação');
    expect(statusElements).toHaveLength(2);
  });

  it('should render priority badge with the localized label', () => {
    render(<VacanciesTable vacancies={realApiData} />);

    // t() returns the key in test env
    expect(screen.getByText('admin.vacancies.priorityOptions.urgent')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.priorityOptions.normal')).toBeInTheDocument();
  });

  it('should render numeric data fields (stageCounts das 7 colunas + postulados/faltantes)', () => {
    render(<VacanciesTable vacancies={realApiData} />);

    // Caso 349: stageCounts padStart(2,'0')
    expect(screen.getByText('32')).toBeInTheDocument();
    expect(screen.getByText('09')).toBeInTheDocument();
    expect(screen.getByText('05')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
    expect(screen.getByText('43')).toBeInTheDocument();
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('115')).toBeInTheDocument();
    expect(screen.getByText('00')).toBeInTheDocument();
    // Caso 348
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('19')).toBeInTheDocument();
    expect(screen.getByText('61')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('52')).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
  });

  it('soma columnCount de todos os sources da coluna (Pre Screening = PRE_SCREENING + IN_PROGRESS)', () => {
    const withInProgress: VacancyRow[] = [
      { ...realApiData[0], stageCounts: { PRE_SCREENING: 1, IN_PROGRESS: 1 } },
    ];
    render(<VacanciesTable vacancies={withInProgress} />);
    expect(
      screen.getByTestId(`vacancy-row-${withInProgress[0].id}-stage-PRE_SCREENING`),
    ).toHaveTextContent('02');
  });

  it('should not render "no vacancies" message when data is provided', () => {
    render(<VacanciesTable vacancies={realApiData} />);
    expect(screen.queryByText('admin.vacancies.noVacancies')).not.toBeInTheDocument();
  });

  it('should render correct number of rows', () => {
    const { container } = render(<VacanciesTable vacancies={realApiData} />);
    const rows = container.querySelectorAll('[class*="h-[72px]"]');
    expect(rows).toHaveLength(2);
  });

  it('renders "—" when priority is null', () => {
    const noPriority: VacancyRow[] = [
      { ...realApiData[0], priority: null },
    ];
    render(<VacanciesTable vacancies={noPriority} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the draft badge only on rows where isDraft is true', () => {
    const mixed: VacancyRow[] = [
      { ...realApiData[0], id: 'draft-1', isDraft: true },
      { ...realApiData[1], id: 'published-1', isDraft: false },
    ];
    render(<VacanciesTable vacancies={mixed} />);

    // t() returns the key in test env
    const badges = screen.getAllByText('admin.vacancies.table.draftBadge');
    expect(badges).toHaveLength(1);
    expect(screen.getByTestId('vacancy-draft-badge-draft-1')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-draft-badge-published-1')).not.toBeInTheDocument();
  });

  it('does not crash and shows empty state when vacancies is undefined', () => {
    // @ts-expect-error — testando o fallback `vacancies ?? []` de props ausente/undefined.
    render(<VacanciesTable vacancies={undefined} />);
    expect(screen.getByText('admin.vacancies.noVacancies')).toBeInTheDocument();
  });

  it('calls onRowClick with the row id AND isDraft when the row is clicked (F25/D425, Fase 3 — quem decide o destino em rascunho é o pai)', () => {
    const onRowClick = vi.fn();
    render(<VacanciesTable vacancies={realApiData} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Caso 349'));
    expect(onRowClick).toHaveBeenCalledWith('fd269cde-d8c9-4fdc-88a9-5b19ebcdb531', false);
  });
});
