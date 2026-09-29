/**
 * A RÉGUA do conserto do colapso `null → []` (achado do gate, PR da stage #565).
 *
 * Por que este arquivo existe separado de `VacancyFormLeftColumn.patologia.test.tsx`:
 * aquele renderiza o LeftColumn DIRETO, passando as props na mão — então ele pula
 * justamente o componente que tinha o bug. `VacancyFormSection.tsx` é quem lê
 * `patientDetail.diagnoses` e decide o que passar adiante; se alguém devolver o
 * `?? []` ali, o teste do LeftColumn continua verde e o defeito volta calado.
 *
 * Este teste monta o modal INTEIRO e mocka a API devolvendo `diagnoses: null`
 * (o que o servidor manda quando falta a célula `patient_clinical:read` — medido
 * por curl contra a stage). Ele MORRE se o `??` voltar.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';

const { CASE_N } = vi.hoisted(() => ({ CASE_N: 1234 }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'admin.vacancyModal.caseSelectStep.caseOptionLabel'
        ? `CASO ${opts?.caseNumber}`
        : key,
  }),
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: CASE_N, patientId: 'p-1', dependencyLevel: 'SEVERE' },
    ]),
    // O servidor manda `null` quando o ator não tem `patient_clinical:read`.
    getPatientById: vi.fn((id: string) =>
      Promise.resolve({ id, dependencyLevel: 'SEVERE', diagnoses: null, diagnosesUnavailable: false }),
    ),
    listPatientAddresses: vi.fn().mockResolvedValue([
      {
        id: 'addr-1',
        patient_id: 'p-1',
        address_formatted: 'Av. Test 123, CABA',
        address_raw: null,
        display_order: 1,
        source: 'manual',
      },
    ]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(7),
    createVacancy: vi.fn(),
    updateVacancy: vi.fn(),
    updateVacancyMeetLinks: vi.fn(),
  },
}));

import { VacancyModal } from '../VacancyModal';

async function abrirComCasoSelecionado() {
  render(
    <MemoryRouter>
      <VacancyModal mode="create" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
  await userEvent.click(screen.getByTestId('case-select').querySelector('button') as HTMLElement);
  const options = await screen.findAllByRole('option');
  const alvo = options.find((o) => o.textContent === `CASO ${formatCaseNumber(CASE_N)}`);
  if (!alvo) throw new Error('opção do caso não encontrada');
  await userEvent.click(alvo);
}

describe('VacancyFormSection — patología: o `null` do servidor não pode virar `[]`', () => {
  it('ator sem `patient_clinical:read` vê o aviso de permissão, NUNCA "—"', async () => {
    await abrirComCasoSelecionado();

    // Se `VacancyFormSection` voltar a fazer `patientDetail?.diagnoses ?? []`,
    // o estado vira `empty` e este `findByTestId` estoura — que é o ponto.
    expect(
      await screen.findByTestId('vacancy-form-patologia-no-permission'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-form-patologia-empty')).toBeNull();
  });
});
