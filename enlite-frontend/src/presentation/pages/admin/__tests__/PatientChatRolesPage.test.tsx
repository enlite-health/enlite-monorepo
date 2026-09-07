/**
 * Unit da tela de administração do catálogo de papéis de chat.
 *
 * Mesmo padrão das outras telas de admin: i18n resolvido contra o pt-BR.json de
 * verdade (chave errada aparece como a própria chave e o teste quebra),
 * react-router e AdminApiService mockados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const translations = ptBR as Record<string, any>;

function t(key: string, opts?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current !== 'string') return typeof opts === 'string' ? opts : key;
  // interpolação mínima do i18next, o suficiente para provar que o NÚMERO chega
  return current.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const listPatientChatRoles = vi.fn();
const createPatientChatRole = vi.fn();
const updatePatientChatRole = vi.fn();
const deletePatientChatRole = vi.fn();
// ⚠️ Só `AdminApiService` é mockado. `AdminPatientsApiService` fica REAL porque
// dele vem a classe `PatientApiError`, que carrega o `code`/`details` da recusa
// — é justamente o que a tradução consome.
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listPatientChatRoles: (...a: unknown[]) => listPatientChatRoles(...a),
    createPatientChatRole: (...a: unknown[]) => createPatientChatRole(...a),
    updatePatientChatRole: (...a: unknown[]) => updatePatientChatRole(...a),
    deletePatientChatRole: (...a: unknown[]) => deletePatientChatRole(...a),
  },
}));

const PatientChatRolesPage = (await import('../PatientChatRolesPage')).default;

function spec(code: string, over: Partial<PatientChatRoleSpec> = {}): PatientChatRoleSpec {
  return {
    code,
    labelEs: `es ${code}`,
    labelPtBr: `pt ${code}`,
    isExclusive: true,
    displayOrder: 0,
    isActive: true,
    matchKeywords: [],
    ...over,
  };
}

const ROLES = [
  spec('FAMILY', { displayOrder: 1, matchKeywords: ['flia'] }),
  spec('PROVIDERS', { displayOrder: 2 }),
  spec('HEALTH_PLAN', { isExclusive: false, displayOrder: 3 }),
];
const USAGE = { FAMILY: 15, PROVIDERS: 232, HEALTH_PLAN: 0 };

describe('PatientChatRolesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sem contrato = engine desligado: a tela abre como sempre abriu.
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listPatientChatRoles.mockResolvedValue({ roles: ROLES, usage: USAGE });
    updatePatientChatRole.mockResolvedValue(ROLES[0]);
    createPatientChatRole.mockResolvedValue(ROLES[0]);
    deletePatientChatRole.mockResolvedValue(undefined);
  });

  async function renderPage() {
    const utils = render(<PatientChatRolesPage />);
    await screen.findByTestId('chat-roles-table');
    return utils;
  }

  it('pede o catálogo COM inativos e uso — é a visão de administração', async () => {
    await renderPage();
    expect(listPatientChatRoles).toHaveBeenCalledWith(true);
  });

  it('lista os papéis com código, os dois rótulos e a política de unicidade', async () => {
    await renderPage();

    const linha = screen.getByTestId('chat-role-row-FAMILY');
    expect(linha).toHaveTextContent('FAMILY');
    expect(linha).toHaveTextContent('es FAMILY');
    expect(linha).toHaveTextContent('pt FAMILY');
    expect(screen.getByTestId('chat-role-exclusive-FAMILY')).toHaveTextContent(
      ptBR.admin.patientChatRoles.exclusiveYes,
    );
    expect(screen.getByTestId('chat-role-exclusive-HEALTH_PLAN')).toHaveTextContent(
      ptBR.admin.patientChatRoles.exclusiveNo,
    );
  });

  it('mostra a CONTAGEM DE USO por papel — o número que decide antes de mexer', async () => {
    // As duas recusas do backend vêm com contagem; ver o número antes evita a
    // pessoa tentar, levar 409 e não saber o tamanho do problema.
    await renderPage();

    expect(screen.getByTestId('chat-role-usage-PROVIDERS')).toHaveTextContent('232');
    expect(screen.getByTestId('chat-role-usage-HEALTH_PLAN')).toHaveTextContent('0');
  });

  it('marca visualmente o papel desativado', async () => {
    listPatientChatRoles.mockResolvedValue({
      roles: [spec('OLD', { isActive: false })],
      usage: { OLD: 0 },
    });
    await renderPage();

    expect(screen.getByTestId('chat-role-status-OLD')).toHaveTextContent(
      ptBR.admin.patientChatRoles.inactive,
    );
  });

  it('quem não tem `patient:read` (engine ON) é mandado embora da rota', async () => {
    comEnforcement([], 'on');
    render(<PatientChatRolesPage />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
  });

  it('com `patient:read` (engine ON) a rota não redireciona', async () => {
    comEnforcement(['patient:read'], 'on');
    await renderPage();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('engine OFF sem célula nenhuma: a rota não redireciona', async () => {
    comEnforcement([], 'off');
    await renderPage();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('fechar a modal pelo backdrop não grava nada', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-new-btn'));
    expect(screen.getByTestId('chat-role-form-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-role-form-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('chat-role-form-modal')).not.toBeInTheDocument());
    expect(createPatientChatRole).not.toHaveBeenCalled();
  });

  it('criar: manda o corpo inteiro e recarrega a lista', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-new-btn'));

    fireEvent.change(screen.getByTestId('chat-role-code-input'), { target: { value: 'management' } });
    fireEvent.change(screen.getByTestId('chat-role-label-es-input'), { target: { value: 'Gestión' } });
    fireEvent.change(screen.getByTestId('chat-role-label-pt-input'), { target: { value: 'Gestão' } });
    fireEvent.change(screen.getByTestId('chat-role-keywords-input'), { target: { value: 'gestion, gestao' } });
    fireEvent.click(screen.getByTestId('chat-role-save'));

    await waitFor(() => expect(createPatientChatRole).toHaveBeenCalledWith({
      // o campo força MAIÚSCULA enquanto se digita — a forma é a do banco
      code: 'MANAGEMENT',
      labelEs: 'Gestión',
      labelPtBr: 'Gestão',
      isExclusive: true,
      displayOrder: 0,
      matchKeywords: ['gestion', 'gestao'],
    }));
    expect(listPatientChatRoles).toHaveBeenCalledTimes(2);
  });

  it('não deixa salvar sem os DOIS rótulos', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-new-btn'));

    fireEvent.change(screen.getByTestId('chat-role-code-input'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('chat-role-label-es-input'), { target: { value: 'Solo es' } });

    expect(screen.getByTestId('chat-role-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('chat-role-save'));
    expect(createPatientChatRole).not.toHaveBeenCalled();
  });

  it('acusa código fora da forma ANTES do round-trip', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-new-btn'));

    fireEvent.change(screen.getByTestId('chat-role-code-input'), { target: { value: 'HEALTH PLAN' } });

    expect(screen.getByTestId('chat-role-code-error')).toHaveTextContent(
      ptBR.admin.patientChatRoles.codeInvalid,
    );
    expect(screen.getByTestId('chat-role-save')).toBeDisabled();
  });

  it('editar: o CÓDIGO é imutável e não vai no corpo', async () => {
    // Trocá-lo renomearia a chave de join da auditoria sem ninguém perceber.
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-edit-FAMILY'));

    expect(screen.getByTestId('chat-role-code-input')).toBeDisabled();
    fireEvent.change(screen.getByTestId('chat-role-label-es-input'), { target: { value: 'Nuevo' } });
    fireEvent.click(screen.getByTestId('chat-role-save'));

    await waitFor(() => expect(updatePatientChatRole).toHaveBeenCalled());
    const [code, payload] = updatePatientChatRole.mock.calls[0];
    expect(code).toBe('FAMILY');
    expect(payload).not.toHaveProperty('code');
    expect(payload.labelEs).toBe('Nuevo');
  });

  it('avisa ANTES de tentar virar um papel compartilhado em exclusivo', async () => {
    listPatientChatRoles.mockResolvedValue({
      roles: [spec('HEALTH_PLAN', { isExclusive: false })],
      usage: { HEALTH_PLAN: 236 },
    });
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-edit-HEALTH_PLAN'));

    expect(screen.queryByTestId('chat-role-exclusive-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-role-exclusive-checkbox'));

    const aviso = screen.getByTestId('chat-role-exclusive-warning');
    expect(aviso).toHaveTextContent('236');
    expect(aviso).toHaveAttribute('role', 'alert');
  });

  it('a RECUSA do backend chega TRADUZIDA e COM a contagem', async () => {
    // As duas metades importam: a frase no idioma de quem opera (o servidor
    // responde em inglês, o painel é es-AR/pt-BR) e o NÚMERO, que é o que diz à
    // pessoa se ela resolve na mão ou desiste.
    updatePatientChatRole.mockRejectedValue(
      new PatientApiError('Chat role is in use by 21 patient(s)', 409, {
        code: 'CHAT_ROLE_IN_USE',
        details: { code: 'FAMILY', patientCount: 21, operation: 'deactivate' },
      }),
    );
    await renderPage();

    fireEvent.click(screen.getByTestId('chat-role-toggle-FAMILY'));

    const erro = await screen.findByTestId('chat-roles-action-error');
    expect(erro).toHaveTextContent('21');
    expect(erro).toHaveTextContent('Não dá');
    expect(erro).not.toHaveTextContent('Chat role is in use');
    expect(erro).toHaveAttribute('role', 'alert');
  });

  it('o conflito de exclusividade diz QUANTOS grupos e QUANTOS pacientes', async () => {
    updatePatientChatRole.mockRejectedValue(
      new PatientApiError('Cannot make HEALTH_PLAN exclusive', 409, {
        code: 'CHAT_ROLE_EXCLUSIVITY_CONFLICT',
        details: { code: 'HEALTH_PLAN', groupCount: 3, patientCount: 7 },
      }),
    );
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-toggle-FAMILY'));

    const erro = await screen.findByTestId('chat-roles-action-error');
    expect(erro).toHaveTextContent('3 grupo(s)');
    expect(erro).toHaveTextContent('7 pacientes');
  });

  it('código de erro DESCONHECIDO cai na mensagem do servidor — nunca some', async () => {
    // Uma recusa nova do backend não pode virar tela em branco só porque a
    // tradução ainda não existe.
    updatePatientChatRole.mockRejectedValue(
      new PatientApiError('Something entirely new happened', 409, { code: 'BRAND_NEW_CODE' }),
    );
    await renderPage();
    fireEvent.click(screen.getByTestId('chat-role-toggle-FAMILY'));

    expect(await screen.findByTestId('chat-roles-action-error')).toHaveTextContent(
      'Something entirely new happened',
    );
  });

  it('desativar manda isActive=false; reativar manda true', async () => {
    listPatientChatRoles.mockResolvedValue({
      roles: [spec('FAMILY'), spec('OLD', { isActive: false })],
      usage: { FAMILY: 0, OLD: 0 },
    });
    await renderPage();

    fireEvent.click(screen.getByTestId('chat-role-toggle-FAMILY'));
    await waitFor(() => expect(updatePatientChatRole).toHaveBeenCalledWith('FAMILY', { isActive: false }));

    fireEvent.click(screen.getByTestId('chat-role-toggle-OLD'));
    await waitFor(() => expect(updatePatientChatRole).toHaveBeenCalledWith('OLD', { isActive: true }));
  });

  it('apagar pede confirmação MOSTRANDO quantos pacientes usam', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();

    fireEvent.click(screen.getByTestId('chat-role-delete-FAMILY'));

    expect(confirm.mock.calls[0][0]).toContain('15');
    await waitFor(() => expect(deletePatientChatRole).toHaveBeenCalledWith('FAMILY'));
    confirm.mockRestore();
  });

  it('cancelar a confirmação não apaga nada', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage();

    fireEvent.click(screen.getByTestId('chat-role-delete-FAMILY'));

    expect(deletePatientChatRole).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('409 no apagar aparece na tela e a lista não muda', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deletePatientChatRole.mockRejectedValue(new Error('Chat role is in use by 15 patient(s)'));
    await renderPage();

    fireEvent.click(screen.getByTestId('chat-role-delete-FAMILY'));

    await screen.findByTestId('chat-roles-action-error');
    expect(screen.getByTestId('chat-role-row-FAMILY')).toBeInTheDocument();
    vi.mocked(window.confirm).mockRestore();
  });

  it('catálogo vazio mostra o estado vazio, não uma tabela em branco', async () => {
    listPatientChatRoles.mockResolvedValue({ roles: [], usage: {} });
    render(<PatientChatRolesPage />);

    await screen.findByTestId('chat-roles-empty');
    expect(screen.queryByTestId('chat-roles-table')).toBeNull();
  });

  it('falha ao carregar aparece na tela', async () => {
    listPatientChatRoles.mockRejectedValue(new Error('connection refused'));
    render(<PatientChatRolesPage />);

    expect(await screen.findByTestId('chat-roles-load-error')).toHaveTextContent('connection refused');
  });

  it('falha ao carregar SEM Error (rejeição crua) ainda vira texto na tela', async () => {
    listPatientChatRoles.mockRejectedValue('sem message');
    render(<PatientChatRolesPage />);

    expect(await screen.findByTestId('chat-roles-load-error')).toHaveTextContent('sem message');
  });

  it('resposta sem `usage` não quebra — cai em objeto vazio', async () => {
    listPatientChatRoles.mockResolvedValue({ roles: ROLES, usage: undefined });
    await renderPage();

    // sem entrada de uso, a contagem cai no fallback 0
    expect(screen.getByTestId('chat-role-usage-FAMILY')).toHaveTextContent('0');
  });

  it('papel sem entrada no mapa de uso mostra contagem 0 (apagar, linha e modal de edição)', async () => {
    const semUso = spec('NEW_ROLE', { displayOrder: 4 });
    listPatientChatRoles.mockResolvedValue({ roles: [...ROLES, semUso], usage: USAGE });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();

    expect(screen.getByTestId('chat-role-usage-NEW_ROLE')).toHaveTextContent('0');

    fireEvent.click(screen.getByTestId('chat-role-edit-NEW_ROLE'));
    expect(screen.getByTestId('chat-role-save')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-role-delete-NEW_ROLE'));
    await waitFor(() => expect(deletePatientChatRole).toHaveBeenCalledWith('NEW_ROLE'));
    vi.mocked(window.confirm).mockRestore();
  });

  it('nada renderiza chave de i18n crua', async () => {
    await renderPage();
    expect(screen.queryByText(/admin\.patientChatRoles/)).toBeNull();
  });
});

// ── D269 — write-gate (POST/PATCH/DELETE /patient-chat-roles → patient:write) ──
// "Nuevo rol" é o atom `Button` → vira `ActionButton`. As três ações de linha
// (editar/(des)ativar/apagar) são `<button>` cru → `useActionGate` esconde a
// `<div>` inteira das três de uma vez.

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('PatientChatRolesPage — write-gate (D269)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sem contrato = engine desligado: a tela abre como sempre abriu.
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listPatientChatRoles.mockResolvedValue({ roles: ROLES, usage: USAGE });
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('🔴 enforcement=on, sem patient:write: chat-role-new-btn e as ações de linha SOMEM', async () => {
    comEnforcement(['patient:read'], 'on');
    render(<PatientChatRolesPage />);
    await screen.findByTestId('chat-roles-table');

    expect(screen.queryByTestId('chat-role-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-role-edit-FAMILY')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-role-toggle-FAMILY')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-role-delete-FAMILY')).not.toBeInTheDocument();
  });

  it('enforcement=on, com patient:write: chat-role-new-btn e as ações de linha existem', async () => {
    comEnforcement(['patient:read', 'patient:write'], 'on');
    render(<PatientChatRolesPage />);
    await screen.findByTestId('chat-roles-table');

    expect(screen.getByTestId('chat-role-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('chat-role-edit-FAMILY')).toBeInTheDocument();
    expect(screen.getByTestId('chat-role-toggle-FAMILY')).toBeInTheDocument();
    expect(screen.getByTestId('chat-role-delete-FAMILY')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): tudo existe mesmo sem célula', async () => {
    render(<PatientChatRolesPage />);
    await screen.findByTestId('chat-roles-table');

    expect(screen.getByTestId('chat-role-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('chat-role-edit-FAMILY')).toBeInTheDocument();
  });
});
