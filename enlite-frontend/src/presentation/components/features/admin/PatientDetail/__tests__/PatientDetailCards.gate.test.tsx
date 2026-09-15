import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from './patientDetailFixture';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

// Uma linha na tabela, para o lápis existir (o fixture nasce sem serviço contratado).
const SERVICO: PatientContractedServiceDetail = {
  id: 'svc-gate',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 1,
  authorizedHours: 10,
  weeklyHours: 10,
  careLocation: 'HOME',
  hourlyValue: null,
  hourlyValueRedacted: false,
  startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL',
  taxCondition: 'IVA_EXEMPT',
  supervisionFrequency: 'DAYS_30',
  guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45',
  addressId: null,
  liveVacancyId: null,
  schedule: null,
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: ['HOME'],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

// ── i18n mock ────────────────────────────────────────────────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) {
    current = current?.[part];
  }
  if (typeof current === 'string') {
    // interpolate {{count}} etc.
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'test-id' }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { PatientGeneralInfoCard } from '../PatientGeneralInfoCard';
import { DiagnosticoCard } from '../DiagnosticoCard';
import { FamiliaresCard } from '../FamiliaresCard';
import { ExternalContactsCard } from '../ExternalContactsCard';
import { ServicosContratadosCard } from '../ServicosContratadosCard';

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('D269/D286 — write-gate nos botões Editar/Novo (célula do CONTAINER)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('🔴 PatientGeneralInfoCard: enforcement=on, sem patient:write → edit-general-btn SOME', () => {
    comEnforcement([], 'on');
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.queryByTestId('edit-general-btn')).not.toBeInTheDocument();
  });

  it('PatientGeneralInfoCard: enforcement=on, com a célula de escrita do container → edit-general-btn existe', () => {
    comEnforcement(['patient_identity:update'], 'on');
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('edit-general-btn')).toBeInTheDocument();
  });

  it('PatientGeneralInfoCard: enforcement OFF (ou ausente) → edit-general-btn existe mesmo sem célula', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('edit-general-btn')).toBeInTheDocument();
  });

  it('🔴 D286: patient:write sozinho NÃO mostra o editar de nenhum container', () => {
    comEnforcement(['patient:read', 'patient:write'], 'on');
    render(<DiagnosticoCard patient={patientDetailFixture} onSaved={() => {}} />);
    render(<FamiliaresCard responsibles={[]} patientId="p1" onSaved={() => {}} />);
    expect(screen.queryByTestId('edit-clinical-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-support-btn')).not.toBeInTheDocument();
  });

  it('🔴 DiagnosticoCard: enforcement=on, sem patient:write → edit-clinical-btn SOME', () => {
    comEnforcement([], 'on');
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.queryByTestId('edit-clinical-btn')).not.toBeInTheDocument();
  });

  it('DiagnosticoCard: enforcement=on, com a célula de escrita do container → edit-clinical-btn existe', () => {
    comEnforcement(['patient_clinical:update'], 'on');
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('edit-clinical-btn')).toBeInTheDocument();
  });

  it('🔴 FamiliaresCard: enforcement=on, sem patient:write → edit-support-btn SOME', () => {
    comEnforcement([], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    expect(screen.queryByTestId('edit-support-btn')).not.toBeInTheDocument();
  });

  it('FamiliaresCard: enforcement=on, com patient_family:create (PR-8b) → edit-support-btn existe (e não desabilitado, com patientId)', () => {
    comEnforcement(['patient_family:create'], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    const btn = screen.getByTestId('edit-support-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  // Gate `canCreateRow || canUpdateRow` (PR-8b rodada B) — os 4 casos, FamiliaresCard e
  // ExternalContactsCard (mesma célula `patient_family`, mesmo componente de gate).
  it('FamiliaresCard: só patient_family:update → edit-support-btn existe (a outra metade do OR)', () => {
    comEnforcement(['patient_family:update'], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    expect(screen.getByTestId('edit-support-btn')).toBeInTheDocument();
  });

  it('FamiliaresCard: as duas células (create + update) → edit-support-btn existe', () => {
    comEnforcement(['patient_family:create', 'patient_family:update'], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    expect(screen.getByTestId('edit-support-btn')).toBeInTheDocument();
  });

  it('🔴 FamiliaresCard: nenhuma das duas células → edit-support-btn SOME', () => {
    comEnforcement([], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    expect(screen.queryByTestId('edit-support-btn')).not.toBeInTheDocument();
  });

  it('ExternalContactsCard: só patient_family:create → edit-external-contacts-btn existe', () => {
    comEnforcement(['patient_family:create'], 'on');
    render(<ExternalContactsCard externalContacts={[]} patientId="test-id" />);
    expect(screen.getByTestId('edit-external-contacts-btn')).toBeInTheDocument();
  });

  it('ExternalContactsCard: só patient_family:update → edit-external-contacts-btn existe', () => {
    comEnforcement(['patient_family:update'], 'on');
    render(<ExternalContactsCard externalContacts={[]} patientId="test-id" />);
    expect(screen.getByTestId('edit-external-contacts-btn')).toBeInTheDocument();
  });

  it('ExternalContactsCard: as duas células (create + update) → edit-external-contacts-btn existe', () => {
    comEnforcement(['patient_family:create', 'patient_family:update'], 'on');
    render(<ExternalContactsCard externalContacts={[]} patientId="test-id" />);
    expect(screen.getByTestId('edit-external-contacts-btn')).toBeInTheDocument();
  });

  it('🔴 ExternalContactsCard: nenhuma das duas células → edit-external-contacts-btn SOME', () => {
    comEnforcement([], 'on');
    render(<ExternalContactsCard externalContacts={[]} patientId="test-id" />);
    expect(screen.queryByTestId('edit-external-contacts-btn')).not.toBeInTheDocument();
  });

  // 06/09 (main): "Editar servicios" virou "+ Nuevo servicio" e o lápis por linha — as duas ações
  // fazem escrita, as duas ficam atrás da MESMA célula do container.
  it('🔴 ServicosContratadosCard: enforcement=on, sem patient_services:write → new-service-btn e o lápis da linha SOMEM', () => {
    comEnforcement([], 'on');
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
    expect(screen.queryByTestId('new-service-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contracted-service-edit-svc-gate')).not.toBeInTheDocument();
    // A 3ª porta: clicar na linha abre o detalhe, e o "Editar" de lá também não existe.
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-gate'));
    expect(screen.getByTestId('contracted-service-detail-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('contracted-service-detail-edit')).not.toBeInTheDocument();
  });

  it('ServicosContratadosCard: enforcement=on, com patient_services:create E :update (PR-8b) → new-service-btn e o lápis existem', () => {
    comEnforcement(['patient_services:create', 'patient_services:update'], 'on');
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
    expect(screen.getByTestId('new-service-btn')).toBeInTheDocument();
    expect(screen.getByTestId('contracted-service-edit-svc-gate')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-gate'));
    expect(screen.getByTestId('contracted-service-detail-edit')).toBeInTheDocument();
  });

  // 018 (fix, 12/09): a rota de ativação exige patient_services:write E vacancy:write. Regra do
  // Gabriel — sem as DUAS células, o ícone SOME (não desabilita). 4 casos: cada célula sozinha,
  // as duas, e nenhuma.
  describe('ícone "Activar reclutamiento": exige patient_services:write E vacancy:write (018)', () => {
    const ATIVAR_TESTID = 'contracted-service-activate-recruitment-svc-gate';

    it('🔴 só patient_services:update (sem vacancy:update) → ícone de ativação NÃO existe', () => {
      comEnforcement(['patient_services:update'], 'on');
      render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
      expect(screen.queryByTestId(ATIVAR_TESTID)).not.toBeInTheDocument();
    });

    it('🔴 só vacancy:update (sem patient_services:update) → ícone de ativação NÃO existe', () => {
      comEnforcement(['vacancy:update'], 'on');
      render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
      expect(screen.queryByTestId(ATIVAR_TESTID)).not.toBeInTheDocument();
    });

    it('com as DUAS células → ícone de ativação existe', () => {
      comEnforcement(['patient_services:update', 'vacancy:update'], 'on');
      render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
      expect(screen.getByTestId(ATIVAR_TESTID)).toBeInTheDocument();
    });

    it('🔴 nenhuma célula → ícone de ativação NÃO existe', () => {
      comEnforcement([], 'on');
      render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
      expect(screen.queryByTestId(ATIVAR_TESTID)).not.toBeInTheDocument();
    });

    // Achado do coordenador (12/09): o gate das duas células é só do BOTÃO de ativar. O "Ver
    // vacante" (serviço já com vaga viva) não tinha NENHUM gate na `origin/stage` — é um `<a>`
    // simples, sem `useActionGate`/`ActionButton` — e continua assim, mesmo sem nenhuma célula.
    it('"Ver vacante" (serviço COM liveVacancyId) continua visível SEM nenhuma célula — igual à stage, que não gateava esse link', () => {
      comEnforcement([], 'on');
      const comVagaViva = { ...SERVICO, liveVacancyId: 'vac-gate-1' };
      render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [comVagaViva] }} />);
      expect(screen.queryByTestId(ATIVAR_TESTID)).not.toBeInTheDocument();
      const link = screen.getByTestId('contracted-service-view-vacancy-svc-gate');
      expect(link.getAttribute('href')).toBe('/admin/vacancies/vac-gate-1');
    });
  });
});
