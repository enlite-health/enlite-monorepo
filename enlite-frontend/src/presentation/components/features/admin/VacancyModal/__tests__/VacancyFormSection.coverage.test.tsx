/**
 * VacancyFormSection — cobertura do arquivo inteiro (spec 028, definição de
 * pronto: 100% do arquivo TOCADO, não só o diff — `VacancyCaseCard.tsx` e
 * `VacancyFormSection.tsx`).
 *
 * Cobre os ramos que os testes já existentes (`.prefill`, `.defense`,
 * `.validationBanner`, `VacancyModal.test.tsx`) não alcançavam:
 *   - modo `edit` com `existingVacancy` totalmente preenchida (`reset({...})`,
 *     linhas 180-209 do componente) — inclusive o `age-range-select` (chama o
 *     `setValue` repassado como prop pra `VacancyFormLeftColumn`, a única
 *     função que aparecia com 0% de cobertura).
 *   - submit em modo `edit` (branches `mode === 'edit'` de `patientId`/
 *     `addressId` e a chamada a `updateVacancy`).
 *   - o `catch` do `onSubmit`: erro genérico (`Error`) → mostra `err.message`;
 *     erro não-`Error` → cai no fallback i18n; 403 "Forbidden fields" em modo
 *     `edit` → intercepta e NÃO mostra banner de erro (`handlePublishedVacancyForbidden`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@infrastructure/http/ApiError';

const {
  createVacancy,
  updateVacancy,
  updateVacancyMeetLinks,
  EDIT_VACANCY,
} = vi.hoisted(() => ({
  createVacancy: vi.fn().mockResolvedValue({ id: 'new-vac' }),
  updateVacancy: vi.fn().mockResolvedValue({}),
  updateVacancyMeetLinks: vi.fn().mockResolvedValue({}),
  EDIT_VACANCY: {
    id: 'vac-edit-1',
    case_number: 1041,
    vacancy_number: 77,
    patient_id: 'p-edit',
    patient_address_id: 'addr-edit-1',
    title: 'CASO EN1041-77',
    status: 'SEARCHING',
    required_professions: ['AT'],
    required_sex: 'BOTH',
    age_range_min: 25,
    age_range_max: 35,
    required_experience: 'Alguna',
    worker_attributes: 'Paciencia',
    providers_needed: 2,
    work_schedule: 'full-time',
    schedule: [{ days: ['lun'], timeFrom: '09:00', timeTo: '17:00' }],
    salary_text: 'A convenir',
    payment_day: '10',
    daily_obs: 'Obs de teste',
    published_at: '2026-01-05T00:00:00Z',
    closes_at: '2026-02-05T00:00:00Z',
    meet_link_1: 'https://meet.google.com/abc-defg-hij',
    meet_link_2: '',
    meet_link_3: '',
  },
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([]),
    getVacancyById: vi.fn().mockResolvedValue(EDIT_VACANCY),
    getPatientById: vi.fn().mockResolvedValue({ id: 'p-edit', dependencyLevel: 'SEVERE' }),
    listPatientAddresses: vi.fn().mockResolvedValue([
      {
        id: 'addr-edit-1',
        patient_id: 'p-edit',
        address_formatted: 'Av. Edit 1, CABA',
        address_raw: null,
        display_order: 1,
        source: 'manual',
      },
    ]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(999),
    createVacancy,
    updateVacancy,
    updateVacancyMeetLinks,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'admin.vacancyModal.caseSelectStep.caseOptionLabel') {
        return `CASO ${opts?.caseNumber}`;
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
}));

import { VacancyModal } from '../VacancyModal';

function renderEditModal() {
  return render(
    <MemoryRouter>
      <VacancyModal mode="edit" vacancyId="vac-edit-1" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('VacancyFormSection — modo edit: reset() carrega a vaga inteira', () => {
  beforeEach(() => {
    createVacancy.mockClear();
    updateVacancy.mockClear();
    updateVacancyMeetLinks.mockClear();
    updateVacancy.mockResolvedValue({});
    updateVacancyMeetLinks.mockResolvedValue({});
  });

  it('carrega required_professions, providers_needed e meet_link_1 no form (reset)', async () => {
    renderEditModal();

    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());

    // required_professions=['AT'] → checkbox AT marcado (Controller + reset).
    await waitFor(() =>
      expect(screen.getByTestId('profession-checkbox-AT')).toBeChecked(),
    );

    // providers_needed=2 (register direto).
    expect(screen.getByTestId('providers-needed-input')).toHaveValue(2);

    // meet_link_1 populado.
    expect(screen.getByTestId('meet-link-0')).toHaveValue(EDIT_VACANCY.meet_link_1);

    // case-number-display (modo edit é read-only) — confirma selectedCaseNumber
    // chegou via `flow.selectCase(v.case_number, v.patient_id, v.patient_address_id)`.
    expect(screen.getByTestId('case-number-display')).toHaveTextContent('CASO EN1041');
  });

  it('age-range-select dispara o setValue repassado (age_range_min/max) sem lançar', async () => {
    renderEditModal();
    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('profession-checkbox-AT')).toBeChecked());

    const ageSelect = screen.getByTestId('age-range-select') as HTMLSelectElement;
    // Já vem em '25_35' (min=25,max=35, reset) — troca pra outro bucket pra
    // provar que o setValue repassado por `VacancyFormSection` (a função
    // anônima que aparecia com 0% de cobertura) roda de ponta a ponta.
    await userEvent.selectOptions(ageSelect, '18_25');
    expect(ageSelect).toHaveValue('18_25');
  });

  it('submit em modo edit: chama updateVacancy (não createVacancy) com o id existente', async () => {
    renderEditModal();
    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('profession-checkbox-AT')).toBeChecked());
    // Endereço já vem auto-selecionado (só 1 endereço, preferido == único).
    await waitFor(() =>
      expect(screen.getByTestId(`address-option-addr-edit-1`)).toHaveClass(/border-primary/),
    );

    await userEvent.click(screen.getByTestId('header-save-btn'));

    await waitFor(() => expect(updateVacancy).toHaveBeenCalled());
    expect(updateVacancy).toHaveBeenCalledWith(
      'vac-edit-1',
      expect.objectContaining({ patient_id: 'p-edit', patient_address_id: 'addr-edit-1' }),
    );
    expect(createVacancy).not.toHaveBeenCalled();
  });
});

describe('VacancyFormSection — onSubmit catch: erro genérico, não-Error, e 403 interceptado', () => {
  beforeEach(() => {
    createVacancy.mockClear();
    updateVacancy.mockClear();
    updateVacancyMeetLinks.mockClear();
  });

  async function submitEditForm() {
    renderEditModal();
    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('profession-checkbox-AT')).toBeChecked());
    await waitFor(() =>
      expect(screen.getByTestId(`address-option-addr-edit-1`)).toHaveClass(/border-primary/),
    );
    await userEvent.click(screen.getByTestId('header-save-btn'));
  }

  it('Error genérico: banner mostra err.message', async () => {
    updateVacancy.mockRejectedValueOnce(new Error('Falha de rede simulada'));

    await submitEditForm();

    const errorBox = await screen.findByText('Falha de rede simulada');
    expect(errorBox).toBeInTheDocument();
  });

  it('valor não-Error (string crua): banner cai no fallback i18n', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    updateVacancy.mockRejectedValueOnce('erro cru, não é instância de Error');

    await submitEditForm();

    const errorBox = await screen.findByText('admin.vacancyDetail.vacancyForm.error');
    expect(errorBox).toBeInTheDocument();
  });

  it('403 "Forbidden fields": handlePublishedVacancyForbidden intercepta — SEM banner de erro', async () => {
    const forbidden = new ApiError(
      {
        success: false,
        error: 'Forbidden fields for vacancy in status "ACTIVE": case_number, title. Only schedule and status can be edited.',
      },
      403,
    );
    updateVacancy.mockRejectedValueOnce(forbidden);

    await submitEditForm();

    // Dá tempo do catch rodar (a promise rejeitada já resolveu o handler).
    await waitFor(() => expect(updateVacancy).toHaveBeenCalled());
    // O early-return de `handlePublishedVacancyForbidden` nunca chama
    // `setApiError` — o banner vermelho não deve aparecer.
    expect(
      screen.queryByText(/Forbidden fields/),
    ).not.toBeInTheDocument();
  });
});
