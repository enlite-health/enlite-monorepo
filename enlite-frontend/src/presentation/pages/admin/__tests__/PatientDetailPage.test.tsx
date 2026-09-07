/**
 * PatientDetailPage — a ficha monta o estado v2 no cabeçalho, o Historial na aba, e passa
 * `refetch`/`patientId` aos cards que agora editam (spec 012). Carregando / erro / não encontrado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('abas: rede de apoio, serviço contratado (cobertura + localizações editáveis), vagas, histórico (Historial) — sem "Enquadre" (05/09)', () => {
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByText("Rede de Apoio"));
    expect(screen.getByTestId('familiares-card')).toBeInTheDocument();
    expect(screen.getByTestId('chat-ids-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText("Serviço Contratado"));
    expect(screen.getByTestId('edit-coverage-btn')).not.toBeDisabled();
    expect(screen.getByTestId('new-address-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByText("Vagas"));
    expect(screen.getByTestId('vacancies-stub')).toBeInTheDocument();
    // A aba "Enquadre" saiu: era a MESMA tabela de serviços contratados montada uma 2ª vez, sem
    // `onSaved` — editar por ali salvava e a tela não atualizava.
    expect(screen.queryByText("Enquadre")).not.toBeInTheDocument();
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

  /**
   * F3 (gate `revisao-pr`, MÉDIO) — `setFocusRequest` só era chamado em `focusChecklistItem`;
   * NADA o devolvia a `null`. Os cards são montados POR ABA e o de-dupe do `useAutoOpenDrawer`
   * vive num `useRef` que morre junto com o componente. Resultado: ela clicava em "Cobertura" no
   * checklist, o drawer abria, ela fechava, ia para outra aba e voltava — e o drawer abria
   * SOZINHO, por cima do que ela estava fazendo. Vale igual para CONSENT → DiagnosticoCard.
   */
  it('F3: voltar para a aba depois de fechar o drawer NÃO o reabre sozinho (o pedido de foco é consumido)', () => {
    vi.useFakeTimers();
    try {
    detail.patient = { ...(detail.patient as object), status: 'PENDING_ADMISSION' };
    render(<PatientDetailPage />);
    // 1. Clica em "Cobertura" no checklist: troca de aba e o drawer de cobertura abre.
    fireEvent.click(screen.getByText('Cobertura'));
    expect(screen.getByTestId('patient-coverage-edit-drawer')).toBeInTheDocument();
    // 2. Fecha o drawer (o fechamento tem animação: `setShow(false)` + `setTimeout(onClose)`).
    fireEvent.click(screen.getByTestId('patient-coverage-edit-backdrop'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId('patient-coverage-edit-drawer')).not.toBeInTheDocument();
    // 3. Vai para outra aba e volta — o card remonta.
    fireEvent.click(screen.getByText('Rede de Apoio'));
    fireEvent.click(screen.getByText('Serviço Contratado'));
    // 4. O drawer NÃO pode ter reaberto sozinho: ela não pediu nada.
    expect(screen.queryByTestId('patient-coverage-edit-drawer')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-coverage-btn')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('F3: clicar no checklist DEPOIS de trocar de aba continua abrindo o drawer (o conserto não mata a US-D1)', () => {
    detail.patient = { ...(detail.patient as object), status: 'PENDING_ADMISSION' };
    render(<PatientDetailPage />);
    fireEvent.click(screen.getByText('Rede de Apoio'));
    fireEvent.click(screen.getByText('Cobertura'));
    expect(screen.getByTestId('patient-coverage-edit-drawer')).toBeInTheDocument();
  });

  it('status:ADMISSION (ACTIVATABLE) → checklist de completude PRESENTE', () => {
    detail.patient = { ...(detail.patient as object), status: 'ADMISSION' };
    render(<PatientDetailPage />);
    expect(
      screen.queryByTestId('completeness-checklist') ?? screen.queryByTestId('completeness-checklist-ready'),
    ).toBeInTheDocument();
  });

  // lex 06/09 (C3): o `h1` passou a ser o NOME do paciente, que é dado projetado pela rota. Se a
  // resposta vier sem nome — porque o ator não tem a célula, ou porque o dado não existe — o
  // título tem de cair no rótulo genérico e NENHUM nome pode aparecer na página. Isto é o que
  // torna verdadeira a frase "a rota projeta, a tela não esconde" (D286) quando a família
  // `admin.patients` ganhar célula de identidade.
  it('sem nome na resposta, o h1 cai no rótulo genérico e NENHUM nome vaza na página', () => {
    detail.patient = { ...(detail.patient as object), firstName: null, lastName: null };
    render(<PatientDetailPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cadastro do Paciente');
    expect(screen.queryByText(/Santiago/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claiman/)).not.toBeInTheDocument();
  });

  it('com nome na resposta, o h1 É o nome do paciente', () => {
    render(<PatientDetailPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Santiago Claiman');
  });

  // lex 06/09 (C1): o nome virou nó de PÁGINA, fora do cartão. A máscara não pode depender de
  // regra do dashboard do Clarity — que é remota e muda sem PR. Trava no DOM.
  it('o h1 com o nome do paciente está dentro de data-clarity-mask="True"', () => {
    render(<PatientDetailPage />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.closest('[data-clarity-mask="True"]')).not.toBeNull();
  });
});
