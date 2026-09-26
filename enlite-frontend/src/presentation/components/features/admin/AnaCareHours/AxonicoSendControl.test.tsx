/**
 * `AxonicoSendControl` — wiring do modal de documento (decisão do Gabriel, 19/09: "se o paciente
 * NÃO TIVER DNI, ao clicar em Enviar, perguntar e registrar; depois disso não perguntar mais").
 * MESMO padrão de `DayGroup.test.tsx` (render direto, serviços mockados via factory).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AxonicoSendControl } from './AxonicoSendControl';
import type { AxonicoComprobanteService, EnviarComprobanteAxonicoResult } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService, RegisterAnaCarePatientDocumentResult } from './AnaCarePatientDocumentService';
import { AnaCarePatientDocumentServiceError } from './AnaCarePatientDocumentService';
import type { AxonicoBlockReason } from './selectors';
import type { AuthzContract } from '@domain/entities/Authz';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }),
}));

/** Contrato ABAC pronto, com o engine LIGADO (D268/D269) e só as células listadas — mesmo molde de `TherapeuticProjectDrawer.test.tsx`. */
function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement'] = 'on'): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

const COMMAND = { documentNumber: '', documentType: undefined, serviceDate: '2026-08-14', hours: 8 };
const RECORD: RegisterAnaCarePatientDocumentResult['record'] = {
  id: 'doc-1',
  anaCarePatientId: 'ac-paciente-1',
  documentNumber: '30111222',
  documentType: 'DNI',
  registeredBy: 'uid-staff-1',
  createdAt: '2026-09-19T00:00:00Z',
  updatedAt: '2026-09-19T00:00:00Z',
};

function eligibility(reasons: AxonicoBlockReason[]): { eligible: boolean; reasons: AxonicoBlockReason[] } {
  return { eligible: reasons.length === 0, reasons };
}

function makeAxonicoService(overrides: Partial<AxonicoComprobanteService> = {}): AxonicoComprobanteService {
  return { enviarComprobante: vi.fn(), ...overrides };
}

function makePatientDocumentService(overrides: Partial<AnaCarePatientDocumentService> = {}): AnaCarePatientDocumentService {
  return { registerDocument: vi.fn(), ...overrides };
}

describe('AxonicoSendControl — modal de documento', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('POSITIVO — motivo missingDocument sozinho: botão HABILITADO, clique abre o modal (não envia direto)', () => {
    const enviarComprobante = vi.fn();
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['missingDocument'])}
        command={COMMAND}
        disableActions={false}
      />,
    );

    expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));

    expect(screen.getByTestId('anacare-hours-axonico-document-modal')).toBeInTheDocument();
    expect(enviarComprobante).not.toHaveBeenCalled();
  });

  it('NEGATIVO — outra razão de bloqueio presente: botão continua DESABILITADO mesmo com missingDocument junto, clique não abre o modal', () => {
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['notValidated', 'missingDocument'])}
        command={COMMAND}
        disableActions={false}
      />,
    );

    expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
    expect(screen.queryByTestId('anacare-hours-axonico-document-modal')).not.toBeInTheDocument();
  });

  it('POSITIVO — sem missingDocument: clique envia direto, sem passar pelo modal', () => {
    const enviarComprobante = vi.fn<[], Promise<EnviarComprobanteAxonicoResult>>().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));

    expect(enviarComprobante).toHaveBeenCalledWith({ documentNumber: '30111222', documentType: undefined, serviceDate: '2026-08-14', hours: 8 });
    expect(screen.queryByTestId('anacare-hours-axonico-document-modal')).not.toBeInTheDocument();
  });

  it('POSITIVO — confirmar no modal REGISTRA o documento e, só depois, ENVIA com o documento recém-digitado, e chama onDocumentRegistered', async () => {
    const registerDocument = vi.fn<[], Promise<RegisterAnaCarePatientDocumentResult>>().mockResolvedValue({ status: 'registrado', record: RECORD });
    const enviarComprobante = vi.fn<[], Promise<EnviarComprobanteAxonicoResult>>().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-9', codAutorizacion: 'A-9' });
    const onDocumentRegistered = vi.fn();

    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService({ registerDocument })}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['missingDocument'])}
        command={COMMAND}
        disableActions={false}
        onDocumentRegistered={onDocumentRegistered}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    fireEvent.change(screen.getByTestId('anacare-hours-axonico-document-modal-input'), { target: { value: '30111222' } });
    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-confirm'));

    await waitFor(() => expect(registerDocument).toHaveBeenCalledWith({ anaCarePatientId: 'ac-paciente-1', documentNumber: '30111222' }));
    await waitFor(() => expect(enviarComprobante).toHaveBeenCalledWith({ ...COMMAND, documentNumber: '30111222' }));
    await waitFor(() => expect(onDocumentRegistered).toHaveBeenCalledTimes(1));
    // O envio encadeado fecha o modal (a tela some, o comprovante do envio assume).
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-axonico-document-modal')).not.toBeInTheDocument());
  });

  it('NEGATIVO — 409 (documento já registrado com número diferente) mostra o erro de CONFLITO no modal, sem enviar', async () => {
    const registerDocument = vi
      .fn()
      .mockRejectedValueOnce(new AnaCarePatientDocumentServiceError('DocumentoJaRegistradoDivergenteError', 'Ya existe un documento distinto registrado.'));
    const enviarComprobante = vi.fn();

    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService({ registerDocument })}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['missingDocument'])}
        command={COMMAND}
        disableActions={false}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    fireEvent.change(screen.getByTestId('anacare-hours-axonico-document-modal-input'), { target: { value: '99999999' } });
    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-axonico-document-modal-error')).toHaveTextContent(
        'admin.anacareHours.dayGroup.axonico.documentModal.errorConflict',
      ),
    );
    expect(enviarComprobante).not.toHaveBeenCalled();
    expect(screen.getByTestId('anacare-hours-axonico-document-modal')).toBeInTheDocument();
  });

  it('NEGATIVO — documento inválido (422) mostra o erro GENÉRICO de documento inválido, distinto do de conflito', async () => {
    const registerDocument = vi.fn().mockRejectedValueOnce(new AnaCarePatientDocumentServiceError('DocumentoInvalidoError', 'Documento inválido.'));

    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService({ registerDocument })}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['missingDocument'])}
        command={COMMAND}
        disableActions={false}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    fireEvent.change(screen.getByTestId('anacare-hours-axonico-document-modal-input'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-axonico-document-modal-error')).toHaveTextContent(
        'admin.anacareHours.dayGroup.axonico.documentModal.errorInvalid',
      ),
    );
  });

  it('NEGATIVO — cancelar o modal fecha sem registrar nem enviar', () => {
    const registerDocument = vi.fn();
    const enviarComprobante = vi.fn();

    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService({ registerDocument })}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['missingDocument'])}
        command={COMMAND}
        disableActions={false}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-cancel'));

    expect(screen.queryByTestId('anacare-hours-axonico-document-modal')).not.toBeInTheDocument();
    expect(registerDocument).not.toHaveBeenCalled();
    expect(enviarComprobante).not.toHaveBeenCalled();
  });

  // ── Gate `integration:execute` (D116) — achado do gate de revisão: o "Enviar" chama a MESMA
  // rota (`POST /integrations/axonico/comprobante`) que o backend protege com
  // `perm.require('integration', 'execute')`; sem o gate no front, quem não tem a célula via o
  // botão normal e levava 403 cru. `ActionButton` mode='hide' default (D269): sem a célula, SOME.
  describe('🔒 gate `integration:execute` — "Enviar" some sem a célula (mesmo mecanismo do export de PR-7)', () => {
    it('engine LIGADO e sem a célula → o botão SOME (não fica cinza)', () => {
      comEnforcement([]);
      render(
        <AxonicoSendControl
          date="2026-08-14"
          service={makeAxonicoService()}
          patientDocumentService={makePatientDocumentService()}
          anaCarePatientId="ac-paciente-1"
          eligibility={eligibility([])}
          command={{ ...COMMAND, documentNumber: '30111222' }}
          disableActions={false}
        />,
      );

      expect(screen.queryByTestId('anacare-hours-send-day-2026-08-14')).not.toBeInTheDocument();
    });

    it('🔴 a célula do PAI (`anacare_hours:validate`) não vale — a permissão é do CONTAINER `integration`', () => {
      comEnforcement(['anacare_hours:validate']);
      render(
        <AxonicoSendControl
          date="2026-08-14"
          service={makeAxonicoService()}
          patientDocumentService={makePatientDocumentService()}
          anaCarePatientId="ac-paciente-1"
          eligibility={eligibility([])}
          command={{ ...COMMAND, documentNumber: '30111222' }}
          disableActions={false}
        />,
      );

      expect(screen.queryByTestId('anacare-hours-send-day-2026-08-14')).not.toBeInTheDocument();
    });

    it('com a célula `integration:execute` o botão existe e continua enviando normalmente', () => {
      comEnforcement(['integration:execute']);
      const enviarComprobante = vi.fn<[], Promise<EnviarComprobanteAxonicoResult>>().mockResolvedValue({
        status: 'enviado',
        numeroComprobante: 'C-1',
        codAutorizacion: 'A-1',
      });
      render(
        <AxonicoSendControl
          date="2026-08-14"
          service={makeAxonicoService({ enviarComprobante })}
          patientDocumentService={makePatientDocumentService()}
          anaCarePatientId="ac-paciente-1"
          eligibility={eligibility([])}
          command={{ ...COMMAND, documentNumber: '30111222' }}
          disableActions={false}
        />,
      );

      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      expect(enviarComprobante).toHaveBeenCalledWith({ documentNumber: '30111222', documentType: undefined, serviceDate: '2026-08-14', hours: 8 });
    });

    it('engine DESLIGADO: o botão existe mesmo sem célula nenhuma (freio de rollout, D268)', () => {
      comEnforcement([], 'off');
      render(
        <AxonicoSendControl
          date="2026-08-14"
          service={makeAxonicoService()}
          patientDocumentService={makePatientDocumentService()}
          anaCarePatientId="ac-paciente-1"
          eligibility={eligibility([])}
          command={{ ...COMMAND, documentNumber: '30111222' }}
          disableActions={false}
        />,
      );

      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeInTheDocument();
    });
  });
});

// change `axonico-envio-rastreavel` (24/09/2026, migration 473): `sent` é o dado PERSISTIDO do dia
// (sobrevive a reload) — ao contrário do `status`/`result` locais do hook, cobertos acima.
describe('AxonicoSendControl — sent (dado persistido, sobrevive a reload)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('POSITIVO — sent presente: mostra sentLabel + "Por: <nome> · <dd/MM>", SEM botão nem mensagens de reason', () => {
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility(['notValidated'])} // reasons não devem aparecer com `sent` presente
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
        sent={{ numeroComprobante: 'C-777', sentBy: { displayName: 'Elizabeth Soñez' }, sentAt: '2026-08-14T15:00:00.000Z' }}
      />,
    );

    expect(screen.getByTestId('anacare-hours-day-sent-2026-08-14')).toHaveTextContent('C-777');
    expect(screen.getByTestId('anacare-hours-day-sent-by-2026-08-14')).toHaveTextContent(
      'admin.anacareHours.dayGroup.axonico.sentBy|{"name":"Elizabeth Soñez","date":"14/08"}',
    );
    expect(screen.queryByTestId('anacare-hours-send-day-2026-08-14')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-axonico-reason-notValidated-2026-08-14')).not.toBeInTheDocument();
  });

  it('NEGATIVO — sent.sentBy.displayName null: mostra só a data, NUNCA "Por: null" no DOM', () => {
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
        sent={{ numeroComprobante: 'C-777', sentBy: { displayName: null }, sentAt: '2026-08-14T15:00:00.000Z' }}
      />,
    );

    const line = screen.getByTestId('anacare-hours-day-sent-by-2026-08-14');
    expect(line).toHaveTextContent('14/08');
    expect(line.textContent).not.toMatch(/null|undefined/i);
  });

  it('NEGATIVO — sent.sentBy null (tentativa anterior à migration 473): mostra só a data, NUNCA "Por: null"', () => {
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
        sent={{ numeroComprobante: 'C-777', sentBy: null, sentAt: '2026-08-14T15:00:00.000Z' }}
      />,
    );

    const line = screen.getByTestId('anacare-hours-day-sent-by-2026-08-14');
    expect(line).toHaveTextContent('14/08');
    expect(line.textContent).not.toMatch(/null|undefined/i);
  });

  it('POSITIVO — sem sent (comportamento antigo intacto): botão aparece normalmente', () => {
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService()}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
      />,
    );

    expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-day-sent-by-2026-08-14')).not.toBeInTheDocument();
  });

  it('POSITIVO — clique com sucesso (enviado) chama onSent, pra o pai refazer a busca e o dado persistido assumir', async () => {
    const enviarComprobante = vi.fn<[], Promise<EnviarComprobanteAxonicoResult>>().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
    const onSent = vi.fn();
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('POSITIVO — clique com resultado "duplicado" TAMBÉM chama onSent (já é uma tentativa persistida)', async () => {
    const enviarComprobante = vi.fn().mockResolvedValue({ status: 'duplicado', numeroComprobante: 'C-ORIGINAL', codAutorizacion: 'A-ORIGINAL', jaFaturado: true });
    const onSent = vi.fn();
    render(
      <AxonicoSendControl
        date="2026-08-14"
        service={makeAxonicoService({ enviarComprobante })}
        patientDocumentService={makePatientDocumentService()}
        anaCarePatientId="ac-paciente-1"
        eligibility={eligibility([])}
        command={{ ...COMMAND, documentNumber: '30111222' }}
        disableActions={false}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });
});
