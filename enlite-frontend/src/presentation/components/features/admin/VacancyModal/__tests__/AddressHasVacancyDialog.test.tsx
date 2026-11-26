/**
 * AddressHasVacancyDialog — mostra o CICLO DE VIDA da vaga (dono único: `lifecycle` do back + `VacancyLifecycleBadge`), nunca o valor
 * cru de `status` nem a chave i18n apagada `admin.vacancyDetail.vacancyForm.statusOptions.*` (estado-automatico-do-paciente, F2).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddressHasVacancyDialog } from '../AddressHasVacancyDialog';
import type { VacancyByAddressSummary } from '@domain/entities/VacancyDraft';

const keysLidas: string[] = [];
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => { keysLidas.push(key); return key; } }),
}));

const vaga = (over: Partial<VacancyByAddressSummary>): VacancyByAddressSummary => ({
  id: 'v1', case_number: 1, vacancy_number: 1, title: 'Caso 1', status: 'PENDING_ACTIVATION', lifecycle: 'aberta',
  is_draft: false, talentum_published_at: null, created_at: '2026-01-01T00:00:00Z', ...over,
});

describe('AddressHasVacancyDialog', () => {
  it('mostra o rótulo do ciclo de vida e nunca lê a chave statusOptions apagada nem mostra o código cru', () => {
    keysLidas.length = 0;
    render(
      <AddressHasVacancyDialog
        isOpen
        vacancies={[vaga({}), vaga({ id: 'v2', status: 'ON_HOLD', lifecycle: 'pausada' })]}
        onEditExisting={vi.fn()}
        onContinueCreating={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('admin.vacancyDetail.lifecycle.aberta')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancyDetail.lifecycle.pausada')).toBeInTheDocument();
    expect(keysLidas.some((k) => k.startsWith('admin.vacancyDetail.vacancyForm.statusOptions.'))).toBe(false);
    expect(screen.queryByText('PENDING_ACTIVATION')).not.toBeInTheDocument();
  });

  it('rascunho mostra o selo de rascunho ao lado do ciclo', () => {
    render(
      <AddressHasVacancyDialog isOpen vacancies={[vaga({ is_draft: true, lifecycle: 'rascunho' })]} onEditExisting={vi.fn()} onContinueCreating={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText('admin.vacancyDetail.lifecycle.rascunho')).toBeInTheDocument();
    expect(screen.getByText('admin.createVacancyV2.addressHasVacancyDialog.draftBadge')).toBeInTheDocument();
  });
});
