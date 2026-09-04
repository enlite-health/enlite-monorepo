/**
 * TalentumConfigPage.d269-gate.test.tsx
 *
 * D269 (rodada 6 do gate): `/admin/vacancies/:id/talentum` é alcançável
 * DIRETO por URL. Sem `talentum:write`, a PORTA fecha
 * (`<Navigate to="/admin/vacancies/:id" replace />`), não só o botão
 * "Publicar". Mesmo padrão de mock de store de `AdminUsersPage.test.tsx`.
 *
 * Filhos pesados (`VacancySummaryCard`, `AIDescriptionEditor`,
 * `PrescreeningStep`, `VacancySocialLinksCard`) são stubados: o alvo aqui é
 * só o gate de rota + o botão de publicar, não o conteúdo deles.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@presentation/components/features/admin/TalentumConfig/VacancySummaryCard', () => ({
  VacancySummaryCard: () => <div data-testid="vacancy-summary-card-stub" />,
}));
vi.mock('@presentation/components/features/admin/TalentumConfig/AIDescriptionEditor', () => ({
  AIDescriptionEditor: () => <div data-testid="ai-description-editor-stub" />,
}));
vi.mock('@presentation/components/features/admin/TalentumConfig/PrescreeningStep', () => ({
  PrescreeningStep: () => <div data-testid="prescreening-step-stub" />,
}));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancySocialLinksCard', () => ({
  VacancySocialLinksCard: () => <div data-testid="vacancy-social-links-card-stub" />,
}));

const generateAIContent = vi.fn();
vi.mock('@hooks/admin/useTalentumConfig', () => ({
  useTalentumConfig: () => ({
    vacancyData: null,
    isLoadingVacancy: false,
    vacancyError: null,
    // `description` não-vazio: evita o auto-generate no mount (hasGeneratedContent=true).
    description: 'Descripción ya generada',
    prescreeningQuestions: [],
    prescreeningFaq: [],
    generateStatus: 'idle',
    generateError: null,
    isSavingDescription: false,
    saveDescriptionError: null,
    descriptionSaved: false,
    descriptionPropagated: false,
    isPublishing: false,
    publishError: null,
    setDescription: vi.fn(),
    generateAIContent,
    saveDescription: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
  }),
}));

import TalentumConfigPage from '../TalentumConfigPage';

function VacancyDetailMarker() {
  return <span>vacancy-detail-marker</span>;
}

function montar(vacancyId = 'vac-1') {
  return render(
    <MemoryRouter initialEntries={[`/admin/vacancies/${vacancyId}/talentum`]}>
      <Routes>
        <Route path="/admin/vacancies/:id" element={<VacancyDetailMarker />} />
        <Route path="/admin/vacancies/:id/talentum" element={<TalentumConfigPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

describe('TalentumConfigPage — D269 gate de rota (talentum:write)', () => {
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement "on" SEM talentum:write → redireciona para /admin/vacancies/:id (a porta fecha)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    montar();

    expect(screen.getByText('vacancy-detail-marker')).toBeInTheDocument();
    expect(screen.queryByText('admin.talentumConfig.publishButton')).not.toBeInTheDocument();
  });

  it('enforcement "on" COM talentum:write → renderiza a tela, com o botão publicar', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['talentum:write'], 'on') });
    montar();

    expect(screen.queryByText('vacancy-detail-marker')).not.toBeInTheDocument();
    expect(screen.getByText('admin.talentumConfig.publishButton')).toBeInTheDocument();
  });

  it('enforcement "off" (sem contrato) → comportamento atual: tela acessível, sem redirect', () => {
    montar();

    expect(screen.queryByText('vacancy-detail-marker')).not.toBeInTheDocument();
    expect(screen.getByText('admin.talentumConfig.publishButton')).toBeInTheDocument();
  });
});
