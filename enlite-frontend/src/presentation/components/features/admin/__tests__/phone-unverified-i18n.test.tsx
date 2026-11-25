/**
 * Token `phone_unverified` (migration 594, `fn_worker_missing_fields_of`) com o i18n REAL (es / pt-BR).
 *
 * Antes desta chave o token saía CRU na tela: o `defaultValue` dos leitores é o próprio token. Dois grupos o traduzem:
 *   - `admin.blockedAttempts.missingField` — KanbanCardBlocked e BlockedAttemptsPage (mesma chave);
 *   - `publicVacancy.incompleteModal.fields` — IncompleteRegistrationModal e o rótulo do botão de postular (jobsConstants).
 * MORRE se a chave sair de qualquer um dos dois grupos, em qualquer dos dois idiomas.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import { KanbanCardBlocked } from '../Kanban/KanbanCardBlocked';
import { IncompleteRegistrationModal } from '../../../../pages/public/components/IncompleteRegistrationModal';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    // SEM fallback: o rótulo é o mesmo nos dois idiomas, e com `fallbackLng: 'es'` a chave faltando no pt-BR passaria muda.
    fallbackLng: false,
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('es');
});

describe.each([
  ['es', 'Celular verificado'],
  ['pt-BR', 'Celular verificado'],
] as const)('phone_unverified traduzido (%s)', (lng, rotulo) => {
  it('card do Kanban em BLOQUEADO (admin.blockedAttempts.missingField): rótulo, nunca o token cru', async () => {
    await i18n.changeLanguage(lng);
    const { container } = render(
      <KanbanCardBlocked blockedReason="registration_incomplete" missingFields={['phone_unverified']} attemptCount={1} />,
    );
    expectNoRawEnumLeaks(container);
    const tags = screen.getByTestId('blocked-missing-fields');
    expect(tags).toHaveTextContent(rotulo);
    expect(tags.textContent).not.toContain('phone_unverified');
  });

  it('modal de cadastro incompleto da vaga pública (publicVacancy.incompleteModal.fields): rótulo, nunca o token cru', async () => {
    await i18n.changeLanguage(lng);
    const { container } = render(
      <MemoryRouter>
        <IncompleteRegistrationModal missingFields={['phone_unverified']} onClose={() => {}} />
      </MemoryRouter>,
    );
    expectNoRawEnumLeaks(container);
    expect(screen.getByText(rotulo)).toBeInTheDocument();
    expect(container.textContent).not.toContain('phone_unverified');
  });
});
