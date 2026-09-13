import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: 10, patientId: 'p-1', dependencyLevel: 'SEVERE' },
      { caseNumber: 20, patientId: 'p-2', dependencyLevel: 'MILD' },
    ]),
    getPatientById: vi.fn().mockResolvedValue({ id: 'p-1', dependencyLevel: 'SEVERE' }),
    listPatientAddresses: vi.fn().mockResolvedValue([
      {
        id: 'addr-1',
        patient_id: 'p-1',
        address_formatted: 'Av. Corrientes 1234, CABA',
        address_raw: null,
        display_order: 1,
        source: 'manual',
      },
    ]),
    getVacancyById: vi.fn().mockResolvedValue({
      id: 'vac-1',
      case_number: 10,
      vacancy_number: 5,
      patient_id: 'p-1',
      patient_address_id: 'addr-1',
      title: 'CASO 10-5',
      status: 'SEARCHING',
      required_professions: ['AT'],
      required_sex: '',
      providers_needed: 1,
      work_schedule: '',
      schedule: [],
    }),
    getNextVacancyNumber: vi.fn().mockResolvedValue(42),
    createVacancy: vi.fn().mockResolvedValue({ id: 'new-vac' }),
    updateVacancy: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

import { VacancyModal } from '../VacancyModal';
import { CaseSelectStep } from '../CaseSelectStep';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

function renderModal(overrides: Partial<React.ComponentProps<typeof VacancyModal>> = {}) {
  const defaults = {
    mode: 'create' as const,
    isOpen: true,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };
  return {
    ...render(
      <MemoryRouter>
        <VacancyModal {...defaults} />
      </MemoryRouter>,
    ),
    props: defaults,
  };
}

// ── Visibility ──────────────────────────────────────────────────────────────

describe('VacancyModal — visibility', () => {
  it('hides sheet (translate-x-full) when isOpen is false', () => {
    renderModal({ isOpen: false });
    const sheet = screen.getByTestId('vacancy-modal');
    expect(sheet.className).toContain('translate-x-full');
  });

  it('shows sheet (translate-x-0) when isOpen is true', () => {
    renderModal({ isOpen: true });
    const sheet = screen.getByTestId('vacancy-modal');
    expect(sheet.className).toContain('translate-x-0');
  });
});

// ── Titles ──────────────────────────────────────────────────────────────────

describe('VacancyModal — titles', () => {
  it('renders createTitle in create mode', () => {
    renderModal({ mode: 'create' });
    expect(screen.getByText('admin.vacancyModal.createTitle')).toBeInTheDocument();
  });

  it('renders editTitle in edit mode', () => {
    renderModal({ mode: 'edit', vacancyId: 'vac-1' });
    expect(screen.getByText('admin.vacancyModal.editTitle')).toBeInTheDocument();
  });

  it('does not show stepper labels', () => {
    renderModal({ mode: 'create' });
    expect(screen.queryByText('admin.vacancyModal.stepCaseSelect')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.vacancyModal.stepVacancyForm')).not.toBeInTheDocument();
  });
});

// ── Create mode ─────────────────────────────────────────────────────────────

describe('VacancyModal — create mode', () => {
  it('shows case select in create mode', async () => {
    renderModal({ mode: 'create' });
    await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
  });

  it('shows vacancy form immediately in create mode (fields disabled until case selected)', async () => {
    renderModal({ mode: 'create' });
    await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
    // form always visible — patient-derived fields are disabled via hint banner
    expect(screen.getByTestId('vacancy-form')).toBeInTheDocument();
    // header Save button disabled until case is selected
    expect(screen.getByTestId('header-save-btn')).toBeDisabled();
  });
});

// ── Close / backdrop ────────────────────────────────────────────────────────

describe('VacancyModal — close', () => {
  it('calls onClose when close button is clicked', async () => {
    const { props } = renderModal();
    await userEvent.click(screen.getByLabelText('admin.vacancyModal.close'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop is clicked', async () => {
    const { props } = renderModal();
    await userEvent.click(screen.getByTestId('vacancy-modal-backdrop'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────

describe('VacancyModal — privacy invariant', () => {
  it('never renders firstName or lastName', () => {
    renderModal({ mode: 'create', isOpen: true });
    const sheet = screen.getByTestId('vacancy-modal');
    expect(sheet.textContent).not.toContain('firstName');
    expect(sheet.textContent).not.toContain('lastName');
  });
});

// ── Structural ───────────────────────────────────────────────────────────────

describe('VacancyModal — structural', () => {
  it('sheet has rounded-tl-[32px] rounded-bl-[32px] (Figma right-side drawer shape)', () => {
    renderModal();
    expect(screen.getByTestId('vacancy-modal').className).toContain('rounded-tl-[32px]');
    expect(screen.getByTestId('vacancy-modal').className).toContain('rounded-bl-[32px]');
  });

  it('sheet is fixed to the right (right-0)', () => {
    renderModal();
    expect(screen.getByTestId('vacancy-modal').className).toContain('right-0');
  });

  it('backdrop has fixed inset-0 classes', () => {
    renderModal();
    const backdrop = screen.getByTestId('vacancy-modal-backdrop');
    expect(backdrop.className).toContain('fixed');
    expect(backdrop.className).toContain('inset-0');
  });
});

// ── CaseSelectStep unit ──────────────────────────────────────────────────────

describe('CaseSelectStep', () => {
  const base = {
    selectedCaseNumber: null,
    selectedPatientId: null,
    dependencyLevel: null,
    addresses: [],
    selectedAddressId: null,
    isLoadingPatient: false,
    patientError: null,
    selectCase: vi.fn(),
    selectAddress: vi.fn(),
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('renders case label', () => {
    render(<CaseSelectStep {...base} />);
    expect(screen.getByText('admin.vacancyModal.caseSelectStep.caseLabel *')).toBeInTheDocument();
  });

  it('shows no-addresses message when patient selected but no addresses', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[]}
        selectedAddressId={null}
      />
    );
    expect(screen.getByText('admin.vacancyModal.caseSelectStep.noAddresses')).toBeInTheDocument();
  });

  it('renders dependency level chip', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="VERY_SEVERE"
        addresses={[]}
        selectedAddressId={null}
      />
    );
    expect(screen.getByText('admin.patients.dependencyOptions.VERY_SEVERE')).toBeInTheDocument();
  });

  it('calls selectAddress when address card is clicked', async () => {
    const selectAddress = vi.fn();
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[{
          id: 'addr-1',
          patient_id: 'p-1',
          address_formatted: 'Av. Corrientes 1234',
          address_raw: null,
          display_order: 1,
          source: 'manual',
          complement: null,
          lat: null,
          lng: null,
        }]}
        selectedAddressId={null}
        selectAddress={selectAddress}
      />
    );
    await userEvent.click(screen.getByTestId('address-option-addr-1'));
    expect(selectAddress).toHaveBeenCalledWith('addr-1');
  });

  it('never renders firstName or lastName', () => {
    render(<CaseSelectStep {...base} />);
    expect(document.body.textContent).not.toContain('firstName');
    expect(document.body.textContent).not.toContain('lastName');
  });

  it('C3 (spec 019): NUNCA exibe address_type — mesmo que o objeto ainda o carregue em runtime (regressão do vazamento de parentesco no wizard de vaga)', () => {
    // `as any`: PatientAddressRow não tem mais `address_type` (removido do tipo e do SELECT do
    // backend); o cast simula uma resposta desatualizada de fora do contrato TS para provar que
    // a TELA, e não só o tipo, ignora o campo — morre se a linha de exibição voltar.
    const addressComValorLegado = {
      id: 'addr-9',
      patient_id: 'p-1',
      address_formatted: 'Av. Corrientes 1234',
      address_raw: null,
      display_order: 1,
      source: 'manual',
      complement: null,
      lat: null,
      lng: null,
      address_type: 'casa_madre',
    } as any;
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[addressComValorLegado]}
        selectedAddressId={null}
      />
    );
    expect(screen.getByTestId('address-option-addr-9')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('casa_madre');
  });

  it('calls selectCase with the matched case when a valid option is chosen', async () => {
    const selectCase = vi.fn();
    render(<CaseSelectStep {...base} selectCase={selectCase} />);
    const select = await screen.findByTestId('case-select');
    await userEvent.selectOptions(select, '10');
    expect(selectCase).toHaveBeenCalledWith(10, 'p-1');
  });

  it('does not call selectCase when the placeholder option is (re)selected', async () => {
    const selectCase = vi.fn();
    render(<CaseSelectStep {...base} selectCase={selectCase} />);
    const select = await screen.findByTestId('case-select');
    await userEvent.selectOptions(select, '10');
    selectCase.mockClear();
    await userEvent.selectOptions(select, '');
    expect(selectCase).not.toHaveBeenCalled();
  });

  it('shows the cases error message when getCasesForSelect rejects', async () => {
    vi.mocked(AdminApiService.getCasesForSelect).mockRejectedValueOnce(new Error('falha ao buscar casos'));
    render(<CaseSelectStep {...base} />);
    expect(await screen.findByText('falha ao buscar casos')).toBeInTheDocument();
    expect(screen.queryByTestId('case-select')).not.toBeInTheDocument();
  });

  it('stringifies a non-Error rejection from getCasesForSelect', async () => {
    vi.mocked(AdminApiService.getCasesForSelect).mockRejectedValueOnce('falha-nao-error');
    render(<CaseSelectStep {...base} />);
    expect(await screen.findByText('falha-nao-error')).toBeInTheDocument();
  });

  it('falls back to em dash when a case option has no dependencyLevel', async () => {
    vi.mocked(AdminApiService.getCasesForSelect).mockResolvedValueOnce([
      { caseNumber: 99, patientId: 'p-9', dependencyLevel: '' },
    ]);
    const { container } = render(<CaseSelectStep {...base} />);
    await screen.findByTestId('case-select');
    const option = container.querySelector('option[value="99"]');
    expect(option).not.toBeNull();
    expect(option?.textContent).toBe('admin.vacancyModal.caseSelectStep.caseOptionLabel');
  });

  it.each([
    ['SEVERE', 'bg-orange-50'],
    ['MODERATE', 'bg-amber-50'],
    ['MILD', 'bg-green-50'],
    ['UNKNOWN_LEVEL', 'bg-blue-50'],
  ])('applies the %s dependency badge color', (level, expectedClass) => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel={level}
        addresses={[]}
        selectedAddressId={null}
      />
    );
    const badge = screen.getByText(`admin.patients.dependencyOptions.${level}`);
    expect(badge.className).toContain(expectedClass);
  });

  it('shows the loading-patient indicator while the patient is being fetched', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        isLoadingPatient
        dependencyLevel={null}
      />
    );
    expect(screen.getByText('admin.vacancyModal.caseSelectStep.loadingPatient')).toBeInTheDocument();
    expect(screen.queryByText('admin.vacancyModal.caseSelectStep.noAddresses')).not.toBeInTheDocument();
  });

  it('shows the patient error message instead of the address picker', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        patientError="paciente não encontrado"
      />
    );
    expect(screen.getByText('paciente não encontrado')).toBeInTheDocument();
    expect(screen.queryByText('admin.vacancyModal.caseSelectStep.noAddresses')).not.toBeInTheDocument();
  });

  it('applies the selected style to the address matching selectedAddressId', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[{
          id: 'addr-1',
          patient_id: 'p-1',
          address_formatted: 'Av. Corrientes 1234',
          address_raw: null,
          display_order: 1,
          source: 'manual',
          complement: null,
          lat: null,
          lng: null,
        }]}
        selectedAddressId="addr-1"
      />
    );
    const button = screen.getByTestId('address-option-addr-1');
    expect(button.className).toContain('border-primary');
    expect(button.className).toContain('ring-primary/30');
  });

  it('shows address_raw when address_formatted is missing', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[{
          id: 'addr-2',
          patient_id: 'p-1',
          address_formatted: '',
          address_raw: 'Calle Falsa 123',
          display_order: 1,
          source: 'manual',
          complement: null,
          lat: null,
          lng: null,
        }]}
        selectedAddressId={null}
      />
    );
    expect(screen.getByText('Calle Falsa 123')).toBeInTheDocument();
  });

  it('shows an em dash when both address_formatted and address_raw are missing', () => {
    render(
      <CaseSelectStep
        {...base}
        selectedCaseNumber={10}
        selectedPatientId="p-1"
        dependencyLevel="SEVERE"
        addresses={[{
          id: 'addr-3',
          patient_id: 'p-1',
          address_formatted: '',
          address_raw: null,
          display_order: 1,
          source: 'manual',
          complement: null,
          lat: null,
          lng: null,
        }]}
        selectedAddressId={null}
      />
    );
    expect(screen.getByTestId('address-option-addr-3').textContent).toContain('—');
  });
});
