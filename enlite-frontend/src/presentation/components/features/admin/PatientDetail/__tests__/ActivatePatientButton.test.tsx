/**
 * Unit de `ActivatePatientButton` — "Activar paciente" (POST /patients/:id/activate).
 *
 * Mesmo padrão dos outros testes de PatientDetail: i18n resolvido contra o
 * pt-BR.json real, `AdminApiService` mockado, `PatientApiError` REAL (é dela
 * que vem o `status` que decide a mensagem de 422 sem endereço).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const activatePatient = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    activatePatient: (...a: unknown[]) => activatePatient(...a),
  },
}));

const { ActivatePatientButton } = await import('../ActivatePatientButton');

describe('ActivatePatientButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('status null: não renderiza nada', () => {
    const { container } = render(
      <ActivatePatientButton patientId="p1" status={null} onActivated={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('status ACTIVE (fora do conjunto ativável): não renderiza nada', () => {
    const { container } = render(
      <ActivatePatientButton patientId="p1" status="ACTIVE" onActivated={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('status ADMISSION: o botão existe', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });

  it('status PENDING_ADMISSION: o botão existe', () => {
    render(<ActivatePatientButton patientId="p1" status="PENDING_ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });

  it('clicar no botão abre o modal de confirmação', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    expect(screen.getByTestId('activate-confirm-modal')).toBeInTheDocument();
  });

  it('cancelar fecha o modal sem chamar a API', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-cancel'));
    expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument();
    expect(activatePatient).not.toHaveBeenCalled();
  });

  it('clicar no backdrop fecha o modal (não ocupado)', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm-backdrop'));
    expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument();
  });

  it('clicar no backdrop enquanto ocupado NÃO fecha o modal', async () => {
    let resolveActivate: (v: unknown) => void;
    activatePatient.mockReturnValue(new Promise((resolve) => { resolveActivate = resolve; }));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));

    fireEvent.click(screen.getByTestId('activate-confirm-backdrop'));
    expect(screen.getByTestId('activate-confirm-modal')).toBeInTheDocument();

    resolveActivate!({ createdVacancyIds: ['v1'] });
    await waitFor(() => expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument());
  });

  it('confirmar com sucesso: chama a API, fecha o modal e avisa o pai', async () => {
    activatePatient.mockResolvedValue({ createdVacancyIds: ['v1', 'v2'] });
    const onActivated = vi.fn();
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={onActivated} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));

    await waitFor(() => expect(activatePatient).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument());
    expect(onActivated).toHaveBeenCalled();
  });

  // ⚠️ ACHADO (fora do escopo D269, não corrigido aqui): `<Text>` (atom) não
  // repassa `data-testid` — a prop declarada em `ActivatePatientButton.tsx`
  // (`data-testid="activate-error"`) nunca chega ao DOM. Os testes abaixo
  // localizam a mensagem pelo TEXTO em vez do testid quebrado.

  it('confirmar com 422 (sem endereço): mostra a mensagem específica e mantém o modal aberto', async () => {
    activatePatient.mockRejectedValue(new PatientApiError('no address', 422));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));

    await screen.findByText(ptBR.admin.patients.activate.noAddress);
    expect(screen.getByTestId('activate-confirm-modal')).toBeInTheDocument();
  });

  it('confirmar com erro genérico: mostra a mensagem do Error', async () => {
    activatePatient.mockRejectedValue(new Error('falha de rede'));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));

    await screen.findByText('falha de rede');
  });

  it('confirmar com rejeição sem Error: cai na mensagem traduzida padrão', async () => {
    activatePatient.mockRejectedValue('sem message');
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));

    await screen.findByText(ptBR.admin.patients.activate.error);
  });

  it('reabrir o modal depois de um erro limpa a mensagem anterior', async () => {
    activatePatient.mockRejectedValue(new Error('falha de rede'));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    fireEvent.click(screen.getByTestId('activate-confirm'));
    await screen.findByText('falha de rede');

    fireEvent.click(screen.getByTestId('activate-cancel'));
    fireEvent.click(screen.getByTestId('activate-patient-btn'));
    expect(screen.queryByText('falha de rede')).not.toBeInTheDocument();
  });

  // ── D269 — POST /patients/:id/activate → patient:write ──────────────────────

  function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
      } as AuthzContract,
    });
  }

  it('🔴 enforcement=on, sem patient:write: activate-patient-btn SOME', () => {
    comEnforcement([], 'on');
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    expect(screen.queryByTestId('activate-patient-btn')).not.toBeInTheDocument();
  });

  it('enforcement=on, com patient:write: activate-patient-btn existe', () => {
    comEnforcement(['patient:write'], 'on');
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): activate-patient-btn existe mesmo sem célula', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });
});
