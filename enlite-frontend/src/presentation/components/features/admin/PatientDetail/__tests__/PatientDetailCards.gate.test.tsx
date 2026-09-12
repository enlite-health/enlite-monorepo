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
    comEnforcement(['patient_identity:write'], 'on');
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
    comEnforcement(['patient_clinical:write'], 'on');
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('edit-clinical-btn')).toBeInTheDocument();
  });

  it('🔴 FamiliaresCard: enforcement=on, sem patient:write → edit-support-btn SOME', () => {
    comEnforcement([], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    expect(screen.queryByTestId('edit-support-btn')).not.toBeInTheDocument();
  });

  it('FamiliaresCard: enforcement=on, com a célula de escrita do container → edit-support-btn existe (e não desabilitado, com patientId)', () => {
    comEnforcement(['patient_family:write'], 'on');
    render(<FamiliaresCard responsibles={[]} patientId="test-id" />);
    const btn = screen.getByTestId('edit-support-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
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

  it('ServicosContratadosCard: enforcement=on, com a célula de escrita do container → new-service-btn e o lápis existem', () => {
    comEnforcement(['patient_services:write'], 'on');
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [SERVICO] }} />);
    expect(screen.getByTestId('new-service-btn')).toBeInTheDocument();
    expect(screen.getByTestId('contracted-service-edit-svc-gate')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-gate'));
    expect(screen.getByTestId('contracted-service-detail-edit')).toBeInTheDocument();
  });
});
