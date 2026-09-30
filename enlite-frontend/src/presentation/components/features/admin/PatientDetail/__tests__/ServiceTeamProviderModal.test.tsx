/**
 * ServiceTeamProviderModal — modal do prestador (Figma 11340:76413/76619, rodada 3).
 * `useServiceTeamContact` é dublê — a busca/gravação real tem suíte própria. Aqui cobre:
 * renderização por status, "Prestador de servicio" como campo com borda só-leitura, "Estado" como
 * SELECT com aplicação DIFERIDA (só ao "Guardar" — escolher a ação+motivo sozinho NÃO chama
 * onReject/onRevert), topo do PACIENTE (nome + WhatsApp condicional à célula), Historial, fechar por Esc/overlay
 * (sem X).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { ServiceTeamProviderModal } from '../ServiceTeamProviderModal';
import type { UseServiceTeamContactResult } from '@hooks/admin/useServiceTeamContact';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';

const mockUseServiceTeamContact = vi.fn<[], UseServiceTeamContactResult>();
vi.mock('@hooks/admin/useServiceTeamContact', () => ({
  useServiceTeamContact: (...args: unknown[]) => mockUseServiceTeamContact(...(args as [])),
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const MEMBER: ServiceTeamMember = { workerId: 'w-1', displayName: 'Marcel Araújo', vacancyId: 'v-1' };

function mockHook(partial: Partial<UseServiceTeamContactResult>): { register: ReturnType<typeof vi.fn> } {
  const register = vi.fn().mockResolvedValue(undefined);
  mockUseServiceTeamContact.mockReturnValue({
    contact: null,
    status: 'loading',
    register,
    saving: false,
    saveError: null,
    ...partial,
  });
  return { register };
}

function renderModal(overrides: Partial<Parameters<typeof ServiceTeamProviderModal>[0]> = {}) {
  const onClose = vi.fn();
  const onReject = vi.fn();
  const onRevert = vi.fn();
  render(
    <ServiceTeamProviderModal
      patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
      onClose={onClose} onReject={onReject} onRevert={onRevert}
      {...overrides}
    />,
  );
  return { onClose, onReject, onRevert };
}

describe('ServiceTeamProviderModal', () => {
  it('D447.3: topo = NOME e WhatsApp do PACIENTE (da ficha), com o ícone à esquerda; o prestador só no campo "Prestador de servicio", sem telefone', () => {
    mockHook({
      status: 'ok',
      contact: { workerId: 'w-1', displayName: 'Marcel Araújo', history: [] },
    });
    renderModal({ patientHeader: { name: 'Paciente Sintético Silva', phone: '+5511900000000' } });

    expect(screen.getByTestId('service-team-provider-modal-name')).toHaveTextContent('Paciente Sintético Silva');
    const phone = screen.getByTestId('service-team-provider-modal-phone');
    expect(phone).toHaveTextContent('+5511900000000');
    expect(phone).toHaveAttribute('href', 'https://wa.me/5511900000000');
    expect(phone.querySelector('img')).not.toBeNull();
    expect(phone.firstElementChild?.tagName).toBe('IMG'); // ícone à ESQUERDA do número
    expect(screen.getByTestId('service-team-provider-modal-name')).not.toHaveTextContent('Marcel');
    const providerField = screen.getByTestId('service-team-provider-modal-provider-field') as HTMLInputElement;
    expect(providerField.tagName).toBe('INPUT');
    expect(providerField).toBeDisabled();
    expect(providerField.value).toBe('Marcel Araújo');
  });

  it('sem a célula do paciente (phone null): a linha do WhatsApp SOME e nada do prestador ocupa o lugar', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel Araújo', history: [] } });
    renderModal({ patientHeader: { name: 'Paciente Sintético Silva', phone: null } });

    expect(screen.queryByTestId('service-team-provider-modal-phone')).not.toBeInTheDocument();
    expect(screen.getByTestId('service-team-provider-modal-name')).toHaveTextContent('Paciente Sintético Silva');
  });

  it('sem patientHeader (ficha redigida): sem nome de paciente e sem WhatsApp, painel abre normalmente', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel Araújo', history: [] } });
    renderModal();

    expect(screen.queryByTestId('service-team-provider-modal-phone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('service-team-provider-modal-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('service-team-provider-modal-save')).toBeInTheDocument();
  });

  it('"Guardar" chama register com contacted/eventDate/note; note vazia vira null (nunca string vazia gravada)', () => {
    const { register } = mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    renderModal();

    fireEvent.click(screen.getByTestId('service-team-provider-modal-contacted'));
    fireEvent.change(screen.getByTestId('service-team-provider-modal-contacted'), { target: { value: 'YES' } });
    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(register).toHaveBeenCalledTimes(1);
    const arg = register.mock.calls[0][0];
    expect(arg.contacted).toBe(true);
    expect(arg.note).toBeNull();
    expect(typeof arg.eventDate).toBe('string');
  });

  it('note preenchida: texto exato vai pro register (nunca truncado/alterado)', () => {
    const { register } = mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    renderModal();

    const noteField = screen.getByTestId('service-team-provider-modal-note');
    fireEvent.click(noteField);
    fireEvent.change(noteField, { target: { value: 'Ligou, sem resposta ainda' } });
    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(register.mock.calls[0][0].note).toBe('Ligou, sem resposta ainda');
  });

  it('Estado em SELECTED_FOR_SERVICE: escolher Rechazar SÓ abre o motivo — onReject NÃO é chamado antes de Guardar', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    const { onReject } = renderModal({ columnId: 'SELECTED_FOR_SERVICE' });

    fireEvent.change(screen.getByTestId('service-team-provider-modal-status'), { target: { value: 'REJECT' } });
    expect(screen.getByTestId('service-team-provider-modal-reject-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('service-team-provider-modal-reject-option-other'));
    fireEvent.click(screen.getByTestId('service-team-provider-modal-reject-confirm'));

    expect(screen.queryByTestId('service-team-provider-modal-reject-modal')).not.toBeInTheDocument();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Estado: motivo capturado + "Guardar" DISPARA onReject com o motivo e fecha o painel', async () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    const { onReject, onClose } = renderModal({ columnId: 'SELECTED_FOR_SERVICE' });

    fireEvent.change(screen.getByTestId('service-team-provider-modal-status'), { target: { value: 'REJECT' } });
    fireEvent.click(screen.getByTestId('service-team-provider-modal-reject-option-other'));
    fireEvent.click(screen.getByTestId('service-team-provider-modal-reject-confirm'));
    expect(onReject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith('w-1', 'OTHER');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Estado em REJECTED_FOR_SERVICE: a ação é Revertir; motivo+Guardar dispara onRevert', async () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    const { onRevert } = renderModal({ columnId: 'REJECTED_FOR_SERVICE' });

    fireEvent.change(screen.getByTestId('service-team-provider-modal-status'), { target: { value: 'REVERT' } });
    expect(screen.getByTestId('service-team-provider-modal-revert-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('service-team-provider-modal-revert-option-other'));
    fireEvent.click(screen.getByTestId('service-team-provider-modal-revert-confirm'));
    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(onRevert).toHaveBeenCalledWith('w-1', 'OTHER');
    await waitFor(() => expect(onRevert).toHaveBeenCalledTimes(1));
  });

  it('Estado em IN_SERVICE: select desabilitado, sem ação disponível (invariante 10)', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    renderModal({ columnId: 'IN_SERVICE' });

    expect(screen.getByTestId('service-team-provider-modal-status')).toBeDisabled();
  });

  it('sem ação pendente: "Guardar" grava o contato mas NÃO fecha o painel (Historial acabou de ganhar linha)', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    const { onClose } = renderModal();

    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('Historial: uma linha por registro (FECHA/NOTA/RESPUESTA); vazio mostra o texto de "sem registros"', () => {
    mockHook({
      status: 'ok',
      contact: {
        workerId: 'w-1', displayName: 'Marcel',
        history: [{ id: 'c-1', contacted: true, eventDate: '2026-09-20', note: 'Confirmou', createdAt: '2026-09-20T10:00:00Z' }],
      },
    });
    renderModal();

    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).toHaveTextContent('Confirmou');
    expect(screen.queryByTestId('service-team-provider-modal-history-empty')).not.toBeInTheDocument();
  });

  it('Historial: FECHA nunca rola pro dia anterior por fuso (achado medido: new Date("2026-09-29") + es-AR/UTC-3 virava "28/9/2026")', () => {
    mockHook({
      status: 'ok',
      contact: {
        workerId: 'w-1', displayName: 'Marcel',
        history: [{ id: 'c-1', contacted: true, eventDate: '2026-09-29', note: 'x', createdAt: '2026-09-29T10:00:00Z' }],
      },
    });
    renderModal();

    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).toHaveTextContent('29/09/2026');
    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).not.toHaveTextContent('28/09/2026');
  });

  it('Historial vazio: mostra o texto de "sin registros"', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    renderModal();

    expect(screen.getByTestId('service-team-provider-modal-history-empty')).toBeInTheDocument();
  });

  it('erro ao carregar: mensagem de erro (role=alert), sem quebrar e sem "sin registros" nem linhas fantasma', () => {
    mockHook({ status: 'error', contact: null });
    renderModal();

    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar el historial de contacto.');
    expect(screen.queryByTestId('service-team-provider-modal-history-empty')).not.toBeInTheDocument();
  });

  it('fechar: onClose chamado ao clicar no overlay, após a animação de 300 ms (sem X — o Figma não tem)', () => {
    vi.useFakeTimers();
    try {
      mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
      const { onClose } = renderModal();

      expect(screen.queryByTestId('service-team-provider-modal-close')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('service-team-provider-modal-backdrop'));
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fechar: onClose chamado ao apertar Esc, após a animação de 300 ms', () => {
    vi.useFakeTimers();
    try {
      mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
      const { onClose } = renderModal();

      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc no painel do Encuadre (casca única): NÃO fecha antes da animação e fecha UMA vez só depois dela', () => {
    vi.useFakeTimers();
    try {
      mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
      const { onClose } = renderModal();

      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => { vi.advanceTimersByTime(299); });
      expect(onClose).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(onClose).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('painel lateral: âncora à direita, altura cheia, cantos arredondados só à esquerda (molde do drawer de detalhe)', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', history: [] } });
    renderModal();

    const panel = screen.getByTestId('service-team-provider-modal');
    expect(panel.className).toContain('right-0');
    expect(panel.className).toContain('h-screen');
    expect(panel.className).toContain('rounded-tl-[32px]');
    expect(panel.className).toContain('rounded-bl-[32px]');
  });
});
