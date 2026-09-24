/**
 * VacancyFormSection — prefill do título em modo `create` (spec 028,
 * "CASO EN{n}-{m} em todo lugar").
 *
 * Os 2 pontos de `setValue('title', …)` em `VacancyFormSection.tsx` (ao
 * carregar com um caso já selecionado, e ao trocar o caso no `case-select`)
 * agora passam `selectedCaseNumber`/`cn` por `formatCaseNumber` antes de
 * montar o título — caso NATIVO (`case_number >= 1000`) grava
 * `CASO EN{n}-{m}`; caso LEGADO (`< 1000`) continua `CASO {n}-{m}`, sem
 * prefixo (D412 ponto 1-2, não reaberta por esta task — SUP-2 do plano).
 *
 * Prova de ponta a ponta (via UI real, sem mock de dado) fica no e2e de
 * integração `028-caso-en.integration.e2e.ts`; este teste unitário prova só
 * a FORMATAÇÃO do título no payload de `createVacancy`, com o mínimo de
 * preenchimento necessário pra passar a validação Zod.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';

// `vi.mock` é hoisted pro topo do arquivo — as constantes que o factory usa
// (inclusive os mocks capturados nas asserções) precisam nascer dentro de
// `vi.hoisted()` pra não virar `ReferenceError: Cannot access '…' before
// initialization` quando outro módulo (ex.: `adminAuthStore`, importado
// transitivamente pelo `VacancyModal`) roda antes do resto do arquivo.
const {
  createVacancy,
  updateVacancyMeetLinks,
  NATIVE_CASE,
  LEGACY_CASE,
  NEXT_VACANCY_NUMBER,
} = vi.hoisted(() => ({
  createVacancy: vi.fn().mockResolvedValue({ id: 'new-vac' }),
  updateVacancyMeetLinks: vi.fn().mockResolvedValue({}),
  NATIVE_CASE: 1041,
  LEGACY_CASE: 828,
  NEXT_VACANCY_NUMBER: 5597,
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: NATIVE_CASE, patientId: 'p-native', dependencyLevel: 'SEVERE' },
      { caseNumber: LEGACY_CASE, patientId: 'p-legacy', dependencyLevel: 'MODERATE' },
    ]),
    getPatientById: vi.fn((id: string) =>
      Promise.resolve({
        id,
        dependencyLevel: id === 'p-native' ? 'SEVERE' : 'MODERATE',
      }),
    ),
    listPatientAddresses: vi.fn().mockResolvedValue([
      {
        id: 'addr-1',
        patient_id: 'p-native',
        address_formatted: 'Av. Test 123, CABA',
        address_raw: null,
        display_order: 1,
        source: 'manual',
      },
    ]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(NEXT_VACANCY_NUMBER),
    createVacancy,
    updateVacancy: vi.fn(),
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

function renderModal() {
  return render(
    <MemoryRouter>
      <VacancyModal mode="create" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />
    </MemoryRouter>,
  );
}

/** Seleciona o caso e preenche o mínimo pra passar o Zod (profissão, 1 slot
 * de horário na segunda-feira, e 1 link de Meet válido). Endereço já vem
 * auto-selecionado — só existe 1 no mock de `listPatientAddresses`. */
async function selectCaseAndFillMinimum(caseNumber: number) {
  await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
  await userEvent.click(
    screen.getByTestId('case-select').querySelector('button') as HTMLElement,
  );
  const options = await screen.findAllByRole('option');
  const label = `CASO ${formatCaseNumber(caseNumber)}`;
  const target = options.find((o) => o.textContent === label);
  if (!target) {
    throw new Error(`opção "${label}" não encontrada entre: ${options.map((o) => o.textContent).join(', ')}`);
  }
  await userEvent.click(target);

  await userEvent.click(await screen.findByTestId('profession-checkbox-AT'));

  const addSlotBtn = (
    await screen.findAllByLabelText('admin.vacancyModal.scheduleSlotsLabel')
  )[0];
  await userEvent.click(addSlotBtn);

  const meetInput = await screen.findByTestId('meet-link-0');
  await userEvent.type(meetInput, 'https://meet.google.com/abc-defg-hij');

  await waitFor(() => expect(screen.getByTestId('header-save-btn')).not.toBeDisabled());
}

describe('VacancyFormSection — prefill do título (spec 028)', () => {
  beforeEach(() => {
    createVacancy.mockClear();
    updateVacancyMeetLinks.mockClear();
  });

  it('caso NATIVO (case_number >= 1000): grava "CASO EN{n}-{m}"', async () => {
    renderModal();
    await selectCaseAndFillMinimum(NATIVE_CASE);

    await userEvent.click(screen.getByTestId('header-save-btn'));

    await waitFor(() => expect(createVacancy).toHaveBeenCalled());
    const payload = createVacancy.mock.calls[0][0] as { title: string };
    expect(payload.title).toBe(`CASO EN${NATIVE_CASE}-${NEXT_VACANCY_NUMBER}`);
  });

  it('caso LEGADO (case_number < 1000): continua "CASO {n}-{m}", sem EN', async () => {
    renderModal();
    await selectCaseAndFillMinimum(LEGACY_CASE);

    await userEvent.click(screen.getByTestId('header-save-btn'));

    await waitFor(() => expect(createVacancy).toHaveBeenCalled());
    const payload = createVacancy.mock.calls[0][0] as { title: string };
    expect(payload.title).toBe(`CASO ${LEGACY_CASE}-${NEXT_VACANCY_NUMBER}`);
  });
});
