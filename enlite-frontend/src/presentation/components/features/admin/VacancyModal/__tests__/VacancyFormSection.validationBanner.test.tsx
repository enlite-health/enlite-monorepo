/**
 * VacancyFormSection — banner de validação (spec 014, US-D6, lex D6.1 CONDICIONADO).
 *
 * Lex D6.1: o banner lista os campos inválidos por NOME (rótulo i18n), NUNCA o VALOR digitado.
 * Prova estrutural: um valor "sabotado" (string com dado sensível/identificável) que falha a
 * validação NÃO pode aparecer no DOM do banner — só o rótulo do campo pode.
 *
 * Também cobre: `patientAddressId` como campo obrigatório do zod (US-D6, "Dirección" —
 * `selectedAddressId` sincronizado, inclusive quando o paciente não tem endereço nenhum) e
 * `grep console` no arquivo fonte = 0 (mesmo padrão de `PatientKanbanPage.moveError.test.tsx`).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: 10, patientId: 'p-1', dependencyLevel: 'SEVERE' },
    ]),
    getPatientById: vi.fn().mockResolvedValue({ id: 'p-1', dependencyLevel: 'SEVERE' }),
    // Paciente SEM endereço nenhum: `selectedAddressId` fica null mesmo depois de escolher o
    // caso — é o único jeito de o campo "Dirección" (patientAddressId) chegar inválido no
    // submit sem precisar simular clique nenhum na lista de endereços.
    listPatientAddresses: vi.fn().mockResolvedValue([]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(42),
    createVacancy: vi.fn(),
    updateVacancy: vi.fn(),
    updateVacancyMeetLinks: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => key,
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

// Um valor sabotado — parece um dado sensível (identifica alguém). Se aparecesse no banner por
// engano (ex.: alguém trocar `listInvalidFields` para ecoar `errors[k].message`/o texto
// digitado em vez do rótulo fixo), este teste pega.
const SABOTAGE_VALUE = 'juan.perez.telefono.1155551234@dato-sensible.com';

describe('VacancyFormSection — banner de validação (US-D6, lex D6.1)', () => {
  it('submeter sem preencher nada (caso selecionado, sem endereço) → banner lista os NOMES dos campos inválidos', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('case-select').querySelector('button') as HTMLElement);
    // options[0] é "Todos" (limpa a seleção) — o caso de verdade é options[1].
    const options = await screen.findAllByRole('option');
    await userEvent.click(options[1]);
    await waitFor(() => expect(screen.getByTestId('header-save-btn')).not.toBeDisabled());

    await userEvent.click(screen.getByTestId('header-save-btn'));

    const banner = await screen.findByTestId('vacancy-validation-banner');
    expect(banner).toHaveTextContent('admin.vacancyModal.validationBanner.title');
    // Campos que ficam inválidos com o form vazio (menos "Estado", que tem default):
    expect(banner).toHaveTextContent('admin.vacancyModal.professionalType');
    expect(banner).toHaveTextContent('admin.vacancyModal.serviceAddress');
    expect(banner).toHaveTextContent('admin.vacancyModal.schedule');
    expect(banner).toHaveTextContent('admin.vacancyModal.meetLinksLabel');
  });

  it('valor sabotado (link de Meet inválido, parece dado sensível) → banner mostra o NOME do campo, nunca o valor digitado', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByTestId('case-select')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('case-select').querySelector('button') as HTMLElement);
    // options[0] é "Todos" (limpa a seleção) — o caso de verdade é options[1].
    const options = await screen.findAllByRole('option');
    await userEvent.click(options[1]);
    await waitFor(() => expect(screen.getByTestId('header-save-btn')).not.toBeDisabled());

    // Link de Meet inválido — o valor digitado carrega algo que PARECE dado sensível
    // (telefone/e-mail de uma pessoa). A validação falha (não bate com o regex de
    // meet.google.com); o teste prova que esse texto nunca chega ao banner.
    await userEvent.type(await screen.findByTestId('meet-link-0'), SABOTAGE_VALUE);

    await userEvent.click(screen.getByTestId('header-save-btn'));

    const banner = await screen.findByTestId('vacancy-validation-banner');
    // O NOME do campo aparece...
    expect(banner).toHaveTextContent('admin.vacancyModal.meetLinksLabel');
    // ...o VALOR sabotado nunca aparece em lugar nenhum do banner.
    expect(banner.textContent).not.toContain(SABOTAGE_VALUE);
    expect(banner.textContent).not.toContain('juan.perez');
  });

  it('grep console no arquivo fonte de VacancyFormSection = 0 (lex D6.1)', () => {
    const source = readFileSync(
      join(__dirname, '../VacancyFormSection.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)\(/);
  });
});
