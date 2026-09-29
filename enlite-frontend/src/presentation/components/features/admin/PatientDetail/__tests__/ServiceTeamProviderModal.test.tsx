/**
 * ServiceTeamProviderModal — modal do prestador (Figma, rodada 2, decisão D). `useServiceTeamContact`
 * é dublê — a busca/gravação real tem suíte própria (`useServiceTeamContact` é fino o bastante pra
 * não precisar de teste próprio; a API client é testada por contrato). Aqui cobre: renderização por
 * status, "Guardar" chama `register` com os campos certos, "Estado" delega pro pai (nunca decide
 * sozinho), Historial lista as linhas.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('ServiceTeamProviderModal', () => {
  it('nome/telefone vêm do contact (já projetado pela API) — o modal nunca decide célula', () => {
    mockHook({
      status: 'ok',
      contact: { workerId: 'w-1', displayName: 'Marcel Araújo', phone: '+5511900000000', history: [] },
    });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.getByTestId('service-team-provider-modal-name')).toHaveTextContent('Marcel Araújo');
    expect(screen.getByTestId('service-team-provider-modal-phone')).toHaveTextContent('+5511900000000');
    expect(screen.getByTestId('service-team-provider-modal-provider-field')).toHaveTextContent('Marcel Araújo');
  });

  it('sem telefone (célula ausente, contact.phone null): sem link de WhatsApp, sem quebrar', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Contato restrito', phone: null, history: [] } });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('service-team-provider-modal-phone')).not.toBeInTheDocument();
  });

  it('"Guardar" chama register com contacted/eventDate/note; note vazia vira null (nunca string vazia gravada)', () => {
    const { register } = mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

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
    const { register } = mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    const noteField = screen.getByTestId('service-team-provider-modal-note');
    fireEvent.click(noteField);
    fireEvent.change(noteField, { target: { value: 'Ligou, sem resposta ainda' } });
    fireEvent.click(screen.getByTestId('service-team-provider-modal-save'));

    expect(register.mock.calls[0][0].note).toBe('Ligou, sem resposta ainda');
  });

  it('Estado em SELECTED_FOR_SERVICE: mostra botão Rechazar que delega pro pai (onRequestReject) — o modal não chama a API de rejeitar sozinho', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    const onRequestReject = vi.fn();
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={onRequestReject} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('service-team-provider-modal-revert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('service-team-provider-modal-reject'));
    expect(onRequestReject).toHaveBeenCalledTimes(1);
  });

  it('Estado em REJECTED_FOR_SERVICE: mostra botão Revertir, delega pro pai (onRequestRevert)', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    const onRequestRevert = vi.fn();
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="REJECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={onRequestRevert}
      />,
    );

    expect(screen.queryByTestId('service-team-provider-modal-reject')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('service-team-provider-modal-revert'));
    expect(onRequestRevert).toHaveBeenCalledTimes(1);
  });

  it('Estado em IN_SERVICE: nenhuma ação (invariante 10 — não dá pra rejeitar quem está alocado)', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="IN_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('service-team-provider-modal-reject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('service-team-provider-modal-revert')).not.toBeInTheDocument();
  });

  it('Historial: uma linha por registro (FECHA/NOTA/RESPUESTA); vazio mostra o texto de "sem registros"', () => {
    mockHook({
      status: 'ok',
      contact: {
        workerId: 'w-1', displayName: 'Marcel', phone: null,
        history: [{ id: 'c-1', contacted: true, eventDate: '2026-09-20', note: 'Confirmou', createdAt: '2026-09-20T10:00:00Z' }],
      },
    });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).toHaveTextContent('Confirmou');
    expect(screen.queryByTestId('service-team-provider-modal-history-empty')).not.toBeInTheDocument();
  });

  it('Historial: FECHA nunca rola pro dia anterior por fuso (achado medido: new Date("2026-09-29") + es-AR/UTC-3 virava "28/9/2026")', () => {
    mockHook({
      status: 'ok',
      contact: {
        workerId: 'w-1', displayName: 'Marcel', phone: null,
        history: [{ id: 'c-1', contacted: true, eventDate: '2026-09-29', note: 'x', createdAt: '2026-09-29T10:00:00Z' }],
      },
    });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).toHaveTextContent('29/09/2026');
    expect(screen.getByTestId('service-team-provider-modal-history-row-c-1')).not.toHaveTextContent('28/09/2026');
  });

  it('Historial vazio: mostra o texto de "sin registros"', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.getByTestId('service-team-provider-modal-history-empty')).toBeInTheDocument();
  });

  it('erro ao carregar: mensagem de erro (role=alert), sem quebrar e sem "sin registros" nem linhas fantasma', () => {
    mockHook({ status: 'error', contact: null });
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={vi.fn()} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar el historial de contacto.');
    expect(screen.queryByTestId('service-team-provider-modal-history-empty')).not.toBeInTheDocument();
  });

  it('fechar: onClose chamado pelo botão de fechar', () => {
    mockHook({ status: 'ok', contact: { workerId: 'w-1', displayName: 'Marcel', phone: null, history: [] } });
    const onClose = vi.fn();
    render(
      <ServiceTeamProviderModal
        patientId="p-1" serviceId="svc-1" member={MEMBER} columnId="SELECTED_FOR_SERVICE"
        onClose={onClose} onRequestReject={vi.fn()} onRequestRevert={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('service-team-provider-modal-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
