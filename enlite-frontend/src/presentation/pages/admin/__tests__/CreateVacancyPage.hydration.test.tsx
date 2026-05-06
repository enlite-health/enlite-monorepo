/**
 * CreateVacancyPage — patient hydration smoke
 *
 * Garante que ao escolher um case no select, TODOS os campos derivados do
 * paciente hidratam. Cobre o regression específico que motivou esse smoke:
 *   - `address_formatted` vazio + `address_raw` preenchido (cenário em ~55%
 *     das linhas no seed local de prod) → fallback pra address_raw funciona.
 *   - Sem isso, o botão do address selector vinha em branco e o usuário
 *     pensava que "o endereço não carregou".
 *
 * Mockamos AdminApiService no boundary do component — sem rede, sem auth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: 99, patientId: 'pat-smoke-1', dependencyLevel: 'SEVERE' },
    ]),
    getPatientById: vi.fn().mockResolvedValue({
      id: 'pat-smoke-1',
      firstName: 'Lucía',
      lastName: 'Fernández',
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      serviceType: ['AT'],
      cityLocality: 'CABA',
      province: 'Buenos Aires',
      responsibles: [],
    }),
    listPatientAddresses: vi.fn().mockResolvedValue([
      {
        id: 'addr-smoke-1',
        patient_id: 'pat-smoke-1',
        // Reproduz drift de prod: formatted vazio, raw preenchido, sem coords
        address_formatted: '',
        address_raw: 'Bolivia 4145, Caseros',
        address_type: 'primary',
        display_order: 1,
        source: 'clickup',
        complement: null,
        lat: null,
        lng: null,
      },
    ]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(1),
    generateAIContent: vi.fn(),
    createVacancy: vi.fn(),
    updateVacancy: vi.fn(),
    updateVacancyMeetLinks: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Resolve ${caseNumber} placeholder for case option label
      if (key === 'admin.vacancyModal.caseSelectStep.caseOptionLabel' && opts) {
        return `CASO ${(opts as { caseNumber: number }).caseNumber}`;
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));

import CreateVacancyPage from '../CreateVacancyPage';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/vacancies/new']}>
      <CreateVacancyPage />
    </MemoryRouter>,
  );
}

describe('CreateVacancyPage — patient hydration smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selecting a case populates every patient-derived field', async () => {
    renderPage();

    // Wait for the case dropdown to be populated
    const select = await screen.findByTestId('case-select');
    await waitFor(() => {
      expect(AdminApiService.getCasesForSelect).toHaveBeenCalled();
    });

    // Pick the case
    await userEvent.selectOptions(select, '99');

    // Patient detail fetched + addresses listed
    await waitFor(() => {
      expect(AdminApiService.getPatientById).toHaveBeenCalledWith('pat-smoke-1');
      expect(AdminApiService.listPatientAddresses).toHaveBeenCalledWith('pat-smoke-1');
    });

    // Derived fields all appear:
    //  - Patient name (read-only)
    expect(await screen.findByText('Lucía Fernández')).toBeInTheDocument();

    //  - Diagnosis (read-only)
    expect(await screen.findByText('TEA leve')).toBeInTheDocument();

    //  - Dependency level → translated via i18n key (mock returns the key)
    expect(
      await screen.findByText('admin.patients.dependencyOptions.SEVERE'),
    ).toBeInTheDocument();

    //  - Address: address_formatted came empty, fallback to address_raw must show
    expect(
      await screen.findByText('Bolivia 4145, Caseros'),
    ).toBeInTheDocument();

    //  - The address option button must exist (proves selector is interactive)
    expect(
      screen.getByTestId('address-option-addr-smoke-1'),
    ).toBeInTheDocument();
  });

  it('Continuar button stays disabled when only the case is picked (other required fields missing)', async () => {
    renderPage();

    const saveBtn = await screen.findByTestId('create-vacancy-save-btn');
    expect(saveBtn).toBeDisabled();

    const select = await screen.findByTestId('case-select');
    await userEvent.selectOptions(select, '99');

    // Picking a case is necessary but not sufficient — schedule, profession,
    // meet link and address are still required by the schema.
    await waitFor(() => {
      expect(AdminApiService.getPatientById).toHaveBeenCalled();
    });
    expect(saveBtn).toBeDisabled();
  });
});
