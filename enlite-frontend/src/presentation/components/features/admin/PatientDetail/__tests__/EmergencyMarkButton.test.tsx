/**
 * EmergencyMarkButton — spec 018, PR-2, US-8, D-A. Sem enforcement ligado (default dos testes,
 * `useActionGate` devolve `{allowed:true}`), o `ActionButton` sempre renderiza — aqui cobrimos o
 * toggle mark/unmark e a chamada certa da API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const translations = ptBR as Record<string, any>;
function t(key: string): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  return typeof cur === 'string' ? cur : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const mockMark = vi.fn();
const mockUnmark = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    markEmergencyContact: (...a: unknown[]) => mockMark(...a),
    unmarkEmergencyContact: (...a: unknown[]) => mockUnmark(...a),
  },
}));

import { EmergencyMarkButton } from '../EmergencyMarkButton';

describe('EmergencyMarkButton', () => {
  beforeEach(() => { mockMark.mockReset().mockResolvedValue({}); mockUnmark.mockReset().mockResolvedValue({}); });

  it('não marcado: sirene vazada; clicar chama markEmergencyContact com {kind, id} e dispara onChanged', async () => {
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('emergency-mark-RESPONSIBLE-r1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockMark).toHaveBeenCalledWith('p1', { kind: 'RESPONSIBLE', id: 'r1' });
    expect(mockUnmark).not.toHaveBeenCalled();
  });

  it('marcado: sirene preenchida; clicar chama unmarkEmergencyContact(patientId) e dispara onChanged', async () => {
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="EXTERNAL" contactId="x1" isMarked onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('emergency-mark-EXTERNAL-x1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockUnmark).toHaveBeenCalledWith('p1');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('onChanged NÃO é chamado se a API rejeitar (o botão não finge sucesso); alerta genérico, sem eco de payload', async () => {
    mockMark.mockRejectedValueOnce(new Error('boom'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('emergency-mark-RESPONSIBLE-r1'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(t('admin.patients.editDrawer.markEmergencyContactError')));
    expect(onChanged).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  // Botão compacto: só ícone; o rótulo longo foi para title + aria-label.
  it('NÃO marcado: botão só-ícone (sem texto visível), title e aria-label = "marcar", formato quadrado p-2, ícone sirene', () => {
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={vi.fn()} />);
    const btn = screen.getByTestId('emergency-mark-RESPONSIBLE-r1');
    expect(btn.textContent).toBe('');
    expect(btn).toHaveAttribute('title', t('admin.patients.editDrawer.markEmergencyContact'));
    expect(btn).toHaveAttribute('aria-label', t('admin.patients.editDrawer.markEmergencyContact'));
    expect(btn.className).toContain('p-2');
    expect(btn.querySelector('svg.lucide-siren')).not.toBeNull();
    expect(btn.querySelector('svg')).toHaveClass('w-4', 'h-4');
  });

  it('MARCADO: MESMO botão-ícone de sirene, preenchido (primary), aria-pressed=true, title e aria-label = "quitar", mesmo tamanho (p-2), sem texto', () => {
    const { unmount } = render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={vi.fn()} />);
    const vazado = screen.getByTestId('emergency-mark-RESPONSIBLE-r1');
    expect(vazado).toHaveAttribute('aria-pressed', 'false');
    expect(vazado.className).toContain('border-2');
    expect(vazado.className).not.toMatch(/(^| )bg-primary( |$)/);
    unmount();
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked onChanged={vi.fn()} />);
    const btn = screen.getByTestId('emergency-mark-RESPONSIBLE-r1');
    expect(btn.textContent).toBe('');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('title', t('admin.patients.editDrawer.unmarkEmergencyContact'));
    expect(btn).toHaveAttribute('aria-label', t('admin.patients.editDrawer.unmarkEmergencyContact'));
    expect(btn.querySelector('svg.lucide-siren')).not.toBeNull();
    expect(btn.querySelector('svg.lucide-x')).toBeNull();
    expect(btn.className).toMatch(/(^| )bg-primary( |$)/);
    expect(btn.className).toContain('p-2');
    expect(btn.className).toContain('h-8');
  });

  it.each([false, true])('carregando (isMarked=%s): NÃO vira texto "Cargando…"; fica desabilitado, aria-busy e ícone girando; segundo clique é ignorado', async (isMarked) => {
    let release: (v: unknown) => void = () => {};
    (isMarked ? mockUnmark : mockMark).mockReturnValueOnce(new Promise((r) => { release = r; }));
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={isMarked} onChanged={vi.fn()} />);
    const btn = screen.getByTestId('emergency-mark-RESPONSIBLE-r1');
    expect(btn).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg.animate-spin')).not.toBeNull();
    fireEvent.click(btn);
    expect(mockMark.mock.calls.length + mockUnmark.mock.calls.length).toBe(1);
    release({});
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});

describe('EmergencyMarkButton — gate patient_family:update (modo hide)', () => {
  afterEach(() => { useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }); });
  const comEnforcement = (permissions: string[]) => useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });

  it.each([false, true])('sem patient_family:update (isMarked=%s) o botão SOME do DOM', (isMarked) => {
    comEnforcement(['patient_family:read']);
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={isMarked} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('emergency-mark-RESPONSIBLE-r1')).not.toBeInTheDocument();
  });

  it('com patient_family:update o botão existe', () => {
    comEnforcement(['patient_family:update']);
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={vi.fn()} />);
    expect(screen.getByTestId('emergency-mark-RESPONSIBLE-r1')).toBeInTheDocument();
  });
});
