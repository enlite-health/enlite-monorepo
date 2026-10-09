/**
 * AdmissionTab — a lista, os selos, o link do Meet, as células e as confirmações de cancelar/reenviar (spec 049, F7).
 * Aceites: A7-2 (sem `:write` não há "Nueva agenda"), A7-4 (Meet só em reunião futura), A7-5 (reenviar só quando falhou).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '@infrastructure/http/ApiError';
import { i18nMock, setCells, appt, sealed, NOW, tEs } from './admissionTestKit';

vi.mock('react-i18next', () => i18nMock);
const api = vi.hoisted(() => ({
  listAppointments: vi.fn(),
  listHosts: vi.fn(),
  bookAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  resendMessage: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminAdmissionApiService', () => ({ AdminAdmissionApiService: api }));

import { AdmissionTab } from '../AdmissionTab';

const ALL = ['patient_admission:read', 'patient_admission:write', 'patient_admission:resend_message'];
const now = () => NOW;
const renderTab = (props: Partial<React.ComponentProps<typeof AdmissionTab>> = {}) =>
  render(<AdmissionTab patientId="p1" country="AR" now={now} {...props} />);

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listHosts.mockResolvedValue([]);
  setCells(ALL);
});
afterEach(() => setCells(null));

describe('lista', () => {
  it('estados: carregando, erro (nunca lista vazia) e vazio', async () => {
    api.listAppointments.mockReturnValueOnce(new Promise(() => {}));
    const first = renderTab();
    expect(screen.getByTestId('admission-loading')).toBeInTheDocument();
    first.unmount();

    api.listAppointments.mockRejectedValueOnce(new Error('boom'));
    const second = renderTab();
    expect(await screen.findByTestId('admission-load-error')).toHaveTextContent(tEs('admin.patients.detail.admissionTab.loadError'));
    expect(screen.queryByTestId('admission-empty')).not.toBeInTheDocument();
    second.unmount();

    api.listAppointments.mockResolvedValueOnce([]);
    renderTab();
    expect(await screen.findByTestId('admission-empty')).toBeInTheDocument();
  });

  it('mostra as reuniões na ordem em que o servidor mandou (mais recente primeiro), com código e origem "site"', async () => {
    api.listAppointments.mockResolvedValue([
      appt({ id: 'novo', admissionCode: 'ADM-0002', createdVia: 'site' }),
      appt({ id: 'velho', admissionCode: 'ADM-0001', slotStart: '2026-10-01T15:00:00.000Z', slotEnd: '2026-10-01T16:00:00.000Z' }),
    ]);
    renderTab();
    const rows = await screen.findAllByTestId(/^admission-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['admission-row-novo', 'admission-row-velho']);
    expect(screen.getByTestId('admission-via-site-novo')).toBeInTheDocument();
    expect(screen.queryByTestId('admission-via-site-velho')).not.toBeInTheDocument();
    expect(screen.getByTestId('admission-code-novo')).toHaveTextContent('ADM-0002');
  });

  it('mostra os quatro selos com o estado por escrito', async () => {
    api.listAppointments.mockResolvedValue([
      appt({
        seals: sealed({
          confirmation: { seal: 'no_consent', attempt: 0, canResend: false },
          reminder: { seal: 'failed', attempt: 0, canResend: true },
          import: 'waiting',
          document: { id: 'doc-9' },
        }),
      }),
    ]);
    renderTab({ onOpenDocuments: vi.fn() });
    expect(await screen.findByTestId('admission-seal-confirmation-chip-a1')).toHaveTextContent('Sin consentimiento');
    expect(screen.getByTestId('admission-seal-reminder-chip-a1')).toHaveTextContent('Falló');
    expect(screen.getByTestId('admission-seal-reminder-chip-a1')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('admission-seal-import-chip-a1')).toHaveTextContent('Esperando');
    expect(screen.getByTestId('admission-document-link-a1')).toHaveTextContent('Ver resumen');
  });

  it('selo Documento: com resumo vira atalho para a aba Documentos; sem resumo é só texto', async () => {
    const open = vi.fn();
    api.listAppointments.mockResolvedValue([
      appt({ id: 'com', seals: sealed({ document: { id: 'd1' } }) }),
      appt({ id: 'sem', seals: sealed({ document: null }) }),
    ]);
    renderTab({ onOpenDocuments: open });
    fireEvent.click(await screen.findByTestId('admission-document-link-com'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('admission-document-none-sem')).toHaveTextContent('Sin resumen');
  });
});

describe('A7-4 — link do Meet só em reunião futura', () => {
  it('futura e agendada: link com target seguro; passada ou cancelada: sem link, mesmo que a API o mande', async () => {
    api.listAppointments.mockResolvedValue([
      appt({ id: 'futura' }),
      appt({ id: 'passada', slotStart: '2026-10-01T15:00:00.000Z', slotEnd: '2026-10-01T16:00:00.000Z', status: 'completed' }),
      appt({ id: 'cancelada', status: 'cancelled' }),
    ]);
    renderTab();
    const link = await screen.findByTestId('admission-meet-futura');
    expect(link).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByTestId('admission-meet-passada')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admission-meet-cancelada')).not.toBeInTheDocument();
  });

  it('o limite é o término da reunião: em andamento ainda mostra, acabada não', async () => {
    api.listAppointments.mockResolvedValue([
      appt({ id: 'andamento', slotStart: '2026-10-12T14:30:00.000Z', slotEnd: '2026-10-12T15:30:00.000Z' }),
      appt({ id: 'acabou', slotStart: '2026-10-12T14:00:00.000Z', slotEnd: '2026-10-12T15:00:00.000Z' }),
    ]);
    renderTab();
    expect(await screen.findByTestId('admission-meet-andamento')).toBeInTheDocument();
    expect(screen.queryByTestId('admission-meet-acabou')).not.toBeInTheDocument();
  });
});

describe('fuso do país do paciente', () => {
  it('entrega ao Intl o timeZone do país (BR → São Paulo, AR → Buenos Aires), nunca o do navegador', async () => {
    api.listAppointments.mockResolvedValue([appt()]);
    const Real = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return new Real(locales, options);
    } as unknown as typeof Intl.DateTimeFormat);
    try {
      renderTab({ country: 'BR' });
      await screen.findByTestId('admission-when-a1');
      const zones = new Set(spy.mock.calls.map((c) => (c[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone).filter(Boolean));
      expect(zones.has('America/Sao_Paulo')).toBe(true);
      expect(zones.has('America/Argentina/Buenos_Aires')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('A7-2 — células', () => {
  it('sem patient_admission:write não há "Nueva agenda" nem "Cancelar"; com write há', async () => {
    api.listAppointments.mockResolvedValue([appt()]);
    setCells(['patient_admission:read']);
    const a = renderTab();
    await screen.findByTestId('admission-row-a1');
    expect(screen.queryByTestId('admission-new-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admission-cancel-a1')).not.toBeInTheDocument();
    a.unmount();

    setCells(['patient_admission:read', 'patient_admission:write']);
    renderTab();
    await screen.findByTestId('admission-row-a1');
    expect(screen.getByTestId('admission-new-button')).toBeInTheDocument();
    expect(screen.getByTestId('admission-cancel-a1')).toBeInTheDocument();
  });

  it('engine desligado (sem contrato): tudo aparece, como no resto do painel', async () => {
    api.listAppointments.mockResolvedValue([appt()]);
    setCells(null);
    renderTab();
    await screen.findByTestId('admission-row-a1');
    expect(screen.getByTestId('admission-new-button')).toBeInTheDocument();
  });
});

describe('A7-5 — reenviar só quando falhou', () => {
  const failed = (over: Partial<ReturnType<typeof sealed>> = {}) =>
    sealed({ confirmation: { seal: 'failed', attempt: 0, canResend: true }, reminder: { seal: 'delivered', attempt: 0, canResend: false }, ...over });

  it('botão só no selo com canResend; ausente em entregue', async () => {
    api.listAppointments.mockResolvedValue([appt({ seals: failed() })]);
    renderTab();
    expect(await screen.findByTestId('admission-resend-confirmation-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('admission-resend-reminder-a1')).not.toBeInTheDocument();
  });

  it('sem a célula resend_message o botão some mesmo com canResend', async () => {
    api.listAppointments.mockResolvedValue([appt({ seals: failed() })]);
    setCells(['patient_admission:read', 'patient_admission:write']);
    renderTab();
    await screen.findByTestId('admission-row-a1');
    expect(screen.queryByTestId('admission-resend-confirmation-a1')).not.toBeInTheDocument();
  });

  it('confirmar chama a rota com o kind certo e recarrega; o diálogo abre com foco em "Volver"', async () => {
    api.listAppointments.mockResolvedValue([appt({ seals: failed({ reminder: { seal: 'failed', attempt: 0, canResend: true } }) })]);
    api.resendMessage.mockResolvedValue({ outcome: 'sent' });
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-resend-reminder-a1'));
    const dialog = screen.getByTestId('admission-resend-dialog');
    expect(within(dialog).getByTestId('admission-resend-dialog-back')).toHaveFocus();
    fireEvent.click(screen.getByTestId('admission-resend-dialog-confirm'));
    await waitFor(() => expect(api.resendMessage).toHaveBeenCalledWith('p1', 'a1', 'reminder_30min'));
    await waitFor(() => expect(screen.queryByTestId('admission-resend-dialog')).not.toBeInTheDocument());
    expect(api.listAppointments).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('admission-notice')).toHaveTextContent('Mensaje reenviado.');
  });

  it.each([
    ['RESEND_NOT_ALLOWED', 'resendNotAllowed'],
    ['RESEND_LIMIT_REACHED', 'resendLimitReached'],
    ['RESEND_IN_PROGRESS', 'resendInProgress'],
  ])('409 %s: o diálogo mostra o motivo e a lista recarrega (o botão pode sumir)', async (code, key) => {
    api.listAppointments.mockResolvedValueOnce([appt({ seals: failed() })]);
    api.listAppointments.mockResolvedValueOnce([appt({ seals: sealed({ confirmation: { seal: 'delivered', attempt: 0, canResend: false } }) })]);
    api.resendMessage.mockRejectedValue(new ApiError({ success: false, error: 'x', code }, 409));
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-resend-confirmation-a1'));
    fireEvent.click(screen.getByTestId('admission-resend-dialog-confirm'));
    expect(await screen.findByTestId('admission-resend-dialog-error')).toHaveTextContent(tEs(`admin.patients.detail.admissionTab.errors.${key}`));
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('admission-resend-confirmation-a1')).not.toBeInTheDocument();
  });

  it('o envio que falha de novo NÃO é erro de HTTP: avisa "não foi enviado" e recarrega', async () => {
    api.listAppointments.mockResolvedValue([appt({ seals: failed() })]);
    api.resendMessage.mockResolvedValue({ outcome: 'send_failed' });
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-resend-confirmation-a1'));
    fireEvent.click(screen.getByTestId('admission-resend-dialog-confirm'));
    expect(await screen.findByTestId('admission-notice')).toHaveTextContent('no pudo enviarse');
  });
});

describe('cancelar', () => {
  it('confirmar cancela a reunião certa e recarrega; "Volver" não chama nada', async () => {
    api.listAppointments.mockResolvedValue([appt()]);
    api.cancelAppointment.mockResolvedValue(undefined);
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-cancel-a1'));
    fireEvent.click(screen.getByTestId('admission-cancel-dialog-back'));
    expect(api.cancelAppointment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admission-cancel-a1'));
    fireEvent.click(screen.getByTestId('admission-cancel-dialog-confirm'));
    await waitFor(() => expect(api.cancelAppointment).toHaveBeenCalledWith('p1', 'a1'));
    await waitFor(() => expect(screen.queryByTestId('admission-cancel-dialog')).not.toBeInTheDocument());
    expect(api.listAppointments).toHaveBeenCalledTimes(2);
  });

  it('409 (já não dá para cancelar) mostra o motivo e recarrega', async () => {
    api.listAppointments.mockResolvedValue([appt()]);
    api.cancelAppointment.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'APPOINTMENT_NOT_CANCELLABLE' }, 409));
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-cancel-a1'));
    fireEvent.click(screen.getByTestId('admission-cancel-dialog-confirm'));
    expect(await screen.findByTestId('admission-cancel-dialog-error')).toHaveTextContent(tEs('admin.patients.detail.admissionTab.errors.cancelNotAllowed'));
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
  });

  it('só reunião agendada e futura tem "Cancelar"', async () => {
    api.listAppointments.mockResolvedValue([
      appt({ id: 'ok' }),
      appt({ id: 'cancelada', status: 'cancelled' }),
      appt({ id: 'passada', slotStart: '2026-10-01T15:00:00.000Z', slotEnd: '2026-10-01T16:00:00.000Z' }),
    ]);
    renderTab();
    await screen.findByTestId('admission-row-ok');
    expect(screen.getByTestId('admission-cancel-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('admission-cancel-cancelada')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admission-cancel-passada')).not.toBeInTheDocument();
  });
});
