import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from './patientDetailFixture';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

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

  it('🔴 ServicosContratadosCard: enforcement=on, sem patient:write → edit-service-btn SOME', () => {
    comEnforcement([], 'on');
    render(<ServicosContratadosCard patient={patientDetailFixture} />);
    expect(screen.queryByTestId('edit-service-btn')).not.toBeInTheDocument();
  });

  it('ServicosContratadosCard: enforcement=on, com a célula de escrita do container → edit-service-btn existe', () => {
    comEnforcement(['patient_services:write'], 'on');
    render(<ServicosContratadosCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('edit-service-btn')).toBeInTheDocument();
  });
});
