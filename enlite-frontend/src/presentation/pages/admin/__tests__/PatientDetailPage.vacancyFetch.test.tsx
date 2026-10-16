/**
 * Spec 047 (F1), A4 — SEM `vacancy:read` o bloco da vacante não está no DOM E `GET /patients/:id/vacancies`
 * NÃO é chamado (espião com 0 chamadas). Aqui o hook e o card são os REAIS; só a camada HTTP é espionada.
 * Com a célula, a mesma rota É chamada (o controle positivo que prova que o espião enxerga a chamada).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from '@presentation/components/features/admin/PatientDetail/__tests__/patientDetailFixture';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'p1' }),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: null }),
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
}));
const detail = { patient: null as unknown, isLoading: false, error: null as string | null, refetch: vi.fn() };
vi.mock('@hooks/admin/usePatientDetail', () => ({ usePatientDetail: () => detail }));
vi.mock('@infrastructure/http/AdminPatientsApiService');
vi.mock('@presentation/components/features/admin/PatientDetail/ProjetoTerapeuticoCard', () => ({ ProjetoTerapeuticoCard: () => <div /> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientStatusControl', () => ({ PatientStatusControl: () => <div /> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientStatusHistoryCard', () => ({ PatientStatusHistoryCard: () => <div /> }));

import PatientDetailPage from '../PatientDetailPage';

const comCelulas = (permissions: string[]) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });

describe('PatientDetailPage — 047 A4: a rota de vacantes só é pedida com vacancy:read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detail.patient = { ...patientDetailFixture, admissionStatus: 'DONE', status: 'ACTIVE' };
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('sem vacancy:read: o bloco não está no DOM e getPatientVacancies tem 0 chamadas', async () => {
    const spy = vi.spyOn(AdminPatientsApiService, 'getPatientVacancies').mockResolvedValue([]);
    comCelulas(['patient:read', 'patient_services:read']);
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByText('Serviço Contratado'));
    await Promise.resolve();
    expect(screen.queryByTestId('patient-vacancies-card')).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('controle positivo — com vacancy:read: o bloco está no DOM e a rota é chamada 1×', async () => {
    const spy = vi.spyOn(AdminPatientsApiService, 'getPatientVacancies').mockResolvedValue([]);
    comCelulas(['patient:read', 'vacancy:read']);
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByText('Serviço Contratado'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('p1');
    expect(screen.getByTestId('patient-vacancies-card')).toBeInTheDocument();
  });
});
