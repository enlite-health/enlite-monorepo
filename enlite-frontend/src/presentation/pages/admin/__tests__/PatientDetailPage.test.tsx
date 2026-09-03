/**
 * PatientDetailPage — a ficha monta o estado v2 no cabeçalho, o Historial na aba, e passa
 * `refetch`/`patientId` aos cards que agora editam (spec 012). Carregando / erro / não encontrado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from '@presentation/components/features/admin/PatientDetail/__tests__/patientDetailFixture';

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
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'p1' }), useNavigate: () => navigate }));
const detail = { patient: null as unknown, isLoading: false, error: null as string | null, refetch: vi.fn() };
const vac = { vacancies: [], isLoading: false, error: null, refetch: vi.fn() };
vi.mock('@hooks/admin/usePatientDetail', () => ({ usePatientDetail: () => detail }));
vi.mock('@hooks/admin/usePatientVacancies', () => ({ usePatientVacancies: () => vac }));
vi.mock('@presentation/components/ui/skeletons', () => ({ DetailSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientChatIdsCard', () => ({ PatientChatIdsCard: () => <div data-testid="chat-ids-stub" /> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientStatusHistoryCard', () => ({ PatientStatusHistoryCard: (p: { patientId: string }) => <div data-testid="history-stub">{p.patientId}</div> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientVacanciesCard', () => ({ PatientVacanciesCard: () => <div data-testid="vacancies-stub" /> }));
vi.mock('@presentation/components/features/admin/PatientDetail/ActivatePatientButton', () => ({ ActivatePatientButton: (p: { onActivated: () => void }) => <button data-testid="activate-stub" onClick={p.onActivated}>activate</button> }));
vi.mock('@presentation/components/features/admin/PatientDetail/PatientStatusControl', () => ({ PatientStatusControl: (p: { onSaved: () => void }) => <button data-testid="status-stub" onClick={p.onSaved}>status</button> }));
vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { updatePatientSection: vi.fn(), listInsuranceProviders: vi.fn().mockResolvedValue([]) } }));

import PatientDetailPage from '../PatientDetailPage';

describe('PatientDetailPage', () => {
  beforeEach(() => { detail.patient = { ...patientDetailFixture, admissionStatus: 'DONE', status: 'ACTIVE' }; detail.isLoading = false; detail.error = null; detail.refetch.mockReset(); vac.refetch.mockReset(); navigate.mockReset(); });

  it('carregando → skeleton', () => {
    detail.isLoading = true;
    render(<PatientDetailPage />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('não encontrado (404) e erro genérico → mensagem + voltar à lista', () => {
    detail.patient = null; detail.error = 'HTTP 404 not found';
    render(<PatientDetailPage />);
    expect(screen.getByText("Paciente não encontrado")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Voltar à lista"));
    expect(navigate).toHaveBeenCalledWith('/admin/patients');
    detail.error = 'boom';
    render(<PatientDetailPage />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    detail.error = null;
    render(<PatientDetailPage />);
    expect(screen.getByText("Erro ao carregar paciente")).toBeInTheDocument();
  });

  it('ficha: estado v2 no cabeçalho (onSaved → refetch), ativar → refetch dos dois; país sem bandeira cai em AR', () => {
    detail.patient = { ...(detail.patient as object), country: 'XX' };
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByTestId('status-stub'));
    expect(detail.refetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('activate-stub'));
    expect(detail.refetch).toHaveBeenCalledTimes(2);
    expect(vac.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: 'XX' })).toHaveTextContent('🇦🇷');
    fireEvent.click(screen.getByText("Voltar à lista"));
    expect(navigate).toHaveBeenCalledWith('/admin/patients');
  });

  it('abas: rede de apoio, serviço contratado (cobertura + localizações editáveis), vagas, encuadre, histórico (Historial)', () => {
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByText("Rede de Apoio"));
    expect(screen.getByTestId('familiares-card')).toBeInTheDocument();
    expect(screen.getByTestId('chat-ids-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText("Serviço Contratado"));
    expect(screen.getByTestId('edit-coverage-btn')).not.toBeDisabled();
    expect(screen.getByTestId('new-address-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByText("Vagas"));
    expect(screen.getByTestId('vacancies-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText("Enquadre"));
    expect(screen.getAllByText(/Enquadre|Encuadre/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Histórico"));
    expect(screen.getByTestId('history-stub')).toHaveTextContent(patientDetailFixture.id);
  });

  // Spec 014 US-D2 (decisão Gabriel 03/09, item 9): as abas "Dados Financeiros"/"Agendamentos"
  // saíram do tab bar — só tinham o placeholder genérico atrás, nenhum card real.
  it('"Dados Financeiros" e "Agendamentos" não aparecem mais no tab bar', () => {
    render(<PatientDetailPage />);
    expect(screen.queryByText("Dados Financeiros")).not.toBeInTheDocument();
    expect(screen.queryByText("Agendamentos")).not.toBeInTheDocument();
  });

  // Spec 014 US-D5: a ficha ganha um botão "Ver no Kanban".
  it('botão "Ver no Kanban" navega para /admin/patients/kanban', () => {
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByTestId('view-in-kanban-btn'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/kanban');
  });

  // Spec 014 US-D1: clicar num item do checklist troca de aba E pede foco ao card certo.
  it('clicar num item do checklist de completude troca para a aba certa (Cobertura → Serviço Contratado)', () => {
    // QA-caça rodada 1, item conserto 3: o checklist só aparece em status ACTIVATABLE —
    // o beforeEach default é ACTIVE (não ativável), então este teste precisa de um status
    // que o mostre.
    detail.patient = { ...(detail.patient as object), status: 'PENDING_ADMISSION' };
    render(<PatientDetailPage />);
    // A fixture tem COVERAGE/CONTRACTED_SERVICE faltando — o checklist aparece por default.
    fireEvent.click(screen.getByText('Cobertura'));
    // Foco foi para a aba "contractedService" — o card de cobertura fica visível.
    expect(screen.getByTestId('edit-coverage-btn')).toBeInTheDocument();
  });

  // QA-caça rodada 1, item conserto 3 (🟡3): o checklist aparecia INCONDICIONALMENTE, mesmo em
  // paciente ACTIVE (já aprovado) — ruído permanente sem ação possível, o D2 queria matar UI
  // morta. RED antes do conserto: o checklist aparecia mesmo aqui.
  it('status:ACTIVE (fora de ACTIVATABLE_STATUSES) → checklist de completude AUSENTE (nada a ativar)', () => {
    // beforeEach já semeia status:'ACTIVE' — não precisa override.
    render(<PatientDetailPage />);
    expect(screen.queryByTestId('completeness-checklist')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completeness-checklist-ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Cobertura')).not.toBeInTheDocument();
  });

  it('status:ADMISSION (ACTIVATABLE) → checklist de completude PRESENTE', () => {
    detail.patient = { ...(detail.patient as object), status: 'ADMISSION' };
    render(<PatientDetailPage />);
    expect(
      screen.queryByTestId('completeness-checklist') ?? screen.queryByTestId('completeness-checklist-ready'),
    ).toBeInTheDocument();
  });
});
