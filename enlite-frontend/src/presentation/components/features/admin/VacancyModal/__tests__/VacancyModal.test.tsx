import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
        address_type: 'PRIMARY',
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

function renderModal(overrides: Partial<React.ComponentProps<typeof VacancyModal>> = {}) {
  const defaults = {
    mode: 'create' as const,
    isOpen: true,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };
  return { ...render(<VacancyModal {...defaults} />), props: defaults };
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
    expect(screen.getByText('VERY_SEVERE')).toBeInTheDocument();
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
          address_type: 'PRIMARY',
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
});
