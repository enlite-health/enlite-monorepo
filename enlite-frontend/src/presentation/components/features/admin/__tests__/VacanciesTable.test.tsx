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
      convidados: '329',
      postulados: '115',
      confirmados: '43',
      selecionados: '27',
      faltantes: '00',
      isDraft: false,
    },
    {
      id: 'c83963ee-beaf-45f2-88a3-365147b0c205',
      caso: 'Caso 348',
      status: 'Esperando Ativação',
      priority: 'NORMAL',
      diasAberto: '03',
      convidados: '164',
      postulados: '52',
      confirmados: '09',
      selecionados: '06',
      faltantes: '00',
      isDraft: false,
    },
  ];

  it('should render table headers (case, status, priority, invited, applicants, confirmed, selected, missing)', () => {
    render(<VacanciesTable vacancies={[]} />);

    expect(screen.getByText('admin.vacancies.table.case')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.status')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.priority')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.invited')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.applicants')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.confirmed')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.table.selected')).toBeInTheDocument();
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

  it('should render numeric data fields', () => {
    render(<VacanciesTable vacancies={realApiData} />);

    expect(screen.getByText('329')).toBeInTheDocument();
    expect(screen.getByText('115')).toBeInTheDocument();
    expect(screen.getByText('43')).toBeInTheDocument();
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('164')).toBeInTheDocument();
    expect(screen.getByText('52')).toBeInTheDocument();
    expect(screen.getByText('09')).toBeInTheDocument();
    expect(screen.getByText('06')).toBeInTheDocument();
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

  it('calls onRowClick with the row id when the row is clicked', () => {
    const onRowClick = vi.fn();
    render(<VacanciesTable vacancies={realApiData} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Caso 349'));
    expect(onRowClick).toHaveBeenCalledWith('fd269cde-d8c9-4fdc-88a9-5b19ebcdb531');
  });
});
