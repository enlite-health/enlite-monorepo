/**
 * CreateVacancyPage — edit mode hydration
 *
 * Cobre o regression do flow Step 2 → Volver → Step 1:
 *   - A rota `/admin/vacancies/:id/edit` carrega a vaga existente.
 *   - O form hidrata com os dados via `reset(...)`.
 *   - O endereço linkado (`vacancy.patient_address_id`) é pré-selecionado.
 *   - O botão Continuar fica habilitado (não trava em disabled enquanto
 *     o flow hidrata).
 *
 * Mockamos AdminApiService no boundary do component — sem rede, sem auth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([]),
    getPatientById: vi.fn(),
    listPatientAddresses: vi.fn(),
    getVacancyById: vi.fn(),
    getNextVacancyNumber: vi.fn().mockResolvedValue(99),
    generateAIContent: vi.fn(),
    createVacancy: vi.fn(),
    updateVacancy: vi.fn(),
    updateVacancyMeetLinks: vi.fn(),
    lookupMeetDatetime: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));

import CreateVacancyPage from '../CreateVacancyPage';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

const VACANCY_ID = 'vac-edit-1';
const PATIENT_ID = 'pat-edit-1';
const ADDRESS_LINKED_ID = 'addr-linked-1';
const ADDRESS_OTHER_ID = 'addr-other-2';

const EXISTING_VACANCY = {
  id: VACANCY_ID,
  case_number: 88,
  vacancy_number: 1,
  patient_id: PATIENT_ID,
  patient_address_id: ADDRESS_LINKED_ID,
  title: 'CASO 88-1',
  status: 'SEARCHING',
  required_professions: ['AT'],
  required_sex: '',
  required_experience: '',
  worker_attributes: '',
  providers_needed: 1,
  work_schedule: '',
  schedule: [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
  ],
  salary_text: '',
  payment_day: '',
  daily_obs: '',
  published_at: null,
  closes_at: null,
  meet_link_1: 'https://meet.google.com/abc-defg-hij',
  meet_link_2: null,
  meet_link_3: null,
};

const PATIENT_DETAIL = {
  id: PATIENT_ID,
  firstName: 'Lucía',
  lastName: 'Fernández',
  diagnosis: 'TEA leve',
  dependencyLevel: 'SEVERE',
  serviceType: ['AT'],
  cityLocality: 'CABA',
  province: 'Buenos Aires',
  responsibles: [],
};

const ADDRESS_LINKED = {
  id: ADDRESS_LINKED_ID,
  patient_id: PATIENT_ID,
  address_formatted: 'Av. Italia 736, Tigre, Buenos Aires, Argentina',
  address_raw: 'Av. Italia 736',
  display_order: 1,
  source: 'manual',
  complement: null,
  lat: -34.4,
  lng: -58.5,
};

const ADDRESS_OTHER = {
  ...ADDRESS_LINKED,
  id: ADDRESS_OTHER_ID,
  address_formatted: 'Carlos Gardel 2466, Olivos, Buenos Aires, Argentina',
  address_raw: 'Carlos Gardel 2466',
  display_order: 2,
};

function renderEditMode() {
  // CreateVacancyPage usa useParams(); precisa de uma <Route> com `:id` na URL.
  return render(
    <MemoryRouter initialEntries={[`/admin/vacancies/${VACANCY_ID}/edit`]}>
      <Routes>
        <Route path="/admin/vacancies/:id/edit" element={<CreateVacancyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(AdminApiService.getVacancyById).mockResolvedValue(EXISTING_VACANCY as any);
  vi.mocked(AdminApiService.getPatientById).mockResolvedValue(PATIENT_DETAIL as any);
  vi.mocked(AdminApiService.listPatientAddresses).mockResolvedValue([
    ADDRESS_LINKED,
    ADDRESS_OTHER,
  ] as any);
});

describe('CreateVacancyPage — edit mode', () => {
  it('busca a vaga via getVacancyById usando o id da URL', async () => {
    renderEditMode();
    await waitFor(() => {
      expect(AdminApiService.getVacancyById).toHaveBeenCalledWith(VACANCY_ID);
    });
  });

  it('hidrata o paciente e os endereços via flow.selectCase com preferredAddressId', async () => {
    renderEditMode();
    await waitFor(() => {
      expect(AdminApiService.getPatientById).toHaveBeenCalledWith(PATIENT_ID);
      expect(AdminApiService.listPatientAddresses).toHaveBeenCalledWith(PATIENT_ID);
    });
  });

  it('marca o endereço linkado da vaga como selecionado (não o primeiro)', async () => {
    renderEditMode();
    // Aguardar os endereços renderizarem na UI
    const linkedBtn = await screen.findByTestId(`address-option-${ADDRESS_LINKED_ID}`);
    const otherBtn = await screen.findByTestId(`address-option-${ADDRESS_OTHER_ID}`);

    // O endereço linkado fica destacado com border-primary; o outro fica neutro.
    // Usamos o style de seleção (border-primary) como sinal.
    await waitFor(() => {
      expect(linkedBtn.className).toContain('border-primary');
      expect(otherBtn.className).not.toContain('border-primary');
    });
  });

  it('botão Continuar NÃO fica travado em disabled durante a hidratação (regression)', async () => {
    // Esse é o regression direto do user report:
    // "Quando eu volto, ainda fica desabilitado".
    // Em edit mode, o gate `formComplete` em CreateVacancyPage é bypassado
    // (RHF valida no submit). O botão deve estar habilitado assim que a
    // vaga é fetchada — independentemente de quando o flow.selectCase resolve.
    renderEditMode();

    const saveBtn = await screen.findByTestId('create-vacancy-save-btn');

    await waitFor(() => {
      // Após o fetch da vaga resolver e o form montar, o botão tem que estar
      // habilitado. Sem o bypass do formComplete em edit mode, esse expect
      // ficaria pendente porque a hidratação assíncrona deixa
      // `selectedAddressId` ou outros campos vazios por uns ms.
      expect(saveBtn).not.toBeDisabled();
    });
  });
});
