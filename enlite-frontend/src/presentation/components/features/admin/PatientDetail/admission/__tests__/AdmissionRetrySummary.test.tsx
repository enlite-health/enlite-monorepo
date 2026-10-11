/**
 * "Reintentar resumen" na aba Admissão (spec 050 F11, R-38). Aceites de tela: A11-4 (sem a célula `retry_summary` o botão não existe),
 * o modal com o custo ("hasta 3 llamadas pagas") quando esgotada, o "roda agora" quando não, o teto de 2 autorizações e o 409.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '@infrastructure/http/ApiError';
import { i18nMock, setCells, appt, NOW, tEs } from './admissionTestKit';

vi.mock('react-i18next', () => i18nMock);
const api = vi.hoisted(() => ({
  listAppointments: vi.fn(),
  listHosts: vi.fn(),
  bookAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  resendMessage: vi.fn(),
  retrySummary: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminAdmissionApiService', () => ({ AdminAdmissionApiService: api }));

import { AdmissionTab } from '../AdmissionTab';

const WITH = ['patient_admission:read', 'patient_admission:create', 'patient_admission:update', 'patient_admission:resend_message', 'patient_admission:retry_summary'];
const WITHOUT = WITH.filter((c) => c !== 'patient_admission:retry_summary');
const ta = (k: string): string => tEs(`admin.patients.detail.admissionTab.${k}`);
const exhausted = (left = 2) => appt({ summaryRetry: { exhausted: true, authorizationsLeft: left } });
const renderTab = () => render(<AdmissionTab patientId="p1" country="AR" now={() => NOW} />);

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listHosts.mockResolvedValue([]);
  setCells(WITH);
});
afterEach(() => setCells(null));

describe('A11-4 — o botão existe só com a célula e só com o que reprocessar', () => {
  it('esgotada e com a célula: botão presente; sem a célula: nem o botão nem o aviso de teto (controle: a linha está lá)', async () => {
    api.listAppointments.mockResolvedValue([exhausted()]);
    const a = renderTab();
    expect(await screen.findByTestId('admission-retry-summary-a1')).toHaveTextContent(ta('retry.button'));
    a.unmount();

    setCells(WITHOUT);
    renderTab();
    await screen.findByTestId('admission-row-a1');
    expect(screen.queryByTestId('admission-retry-summary-a1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admission-retry-limit-a1')).not.toBeInTheDocument();
  });

  it('sem nada a reprocessar (summaryRetry null ou ausente) o botão não aparece, mesmo com a célula', async () => {
    api.listAppointments.mockResolvedValue([appt({ id: 'nulo', summaryRetry: null }), appt({ id: 'ausente' })]);
    renderTab();
    await screen.findByTestId('admission-row-nulo');
    expect(screen.queryByTestId('admission-retry-summary-nulo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admission-retry-summary-ausente')).not.toBeInTheDocument();
  });

  it('teto de autorizações gasto: sem botão, com o aviso por escrito', async () => {
    api.listAppointments.mockResolvedValue([exhausted(0)]);
    renderTab();
    expect(await screen.findByTestId('admission-retry-limit-a1')).toHaveTextContent(ta('retry.limit'));
    expect(screen.queryByTestId('admission-retry-summary-a1')).not.toBeInTheDocument();
  });
});

describe('modal e confirmação', () => {
  it('esgotada: o modal diz o custo ("hasta 3 llamadas pagas"), abre com foco em "Volver" e "Volver" não chama nada', async () => {
    api.listAppointments.mockResolvedValue([exhausted()]);
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    const dialog = screen.getByTestId('admission-retry-dialog');
    expect(dialog).toHaveTextContent('hasta 3 llamadas pagas');
    expect(within(dialog).getByTestId('admission-retry-dialog-back')).toHaveFocus();
    fireEvent.click(screen.getByTestId('admission-retry-dialog-back'));
    expect(api.retrySummary).not.toHaveBeenCalled();
    expect(screen.queryByTestId('admission-retry-dialog')).not.toBeInTheDocument();
  });

  it('esgotada: confirmar chama a rota da reunião certa, avisa "nueva ronda autorizada" e recarrega a lista', async () => {
    api.listAppointments.mockResolvedValue([exhausted()]);
    api.retrySummary.mockResolvedValue({ appointmentId: 'a1', mode: 'authorized', authorizationsUsed: 1, authorizationsLeft: 1 });
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    fireEvent.click(screen.getByTestId('admission-retry-dialog-confirm'));
    await waitFor(() => expect(api.retrySummary).toHaveBeenCalledWith('p1', 'a1'));
    await waitFor(() => expect(screen.queryByTestId('admission-retry-dialog')).not.toBeInTheDocument());
    expect(api.listAppointments).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('admission-notice')).toHaveTextContent(ta('retry.authorized'));
  });

  it('não esgotada (prompt/catálogo): o modal NÃO fala de autorização nem de custo novo, e o "roda agora" avisa o resultado', async () => {
    api.listAppointments.mockResolvedValue([appt({ summaryRetry: { exhausted: false, authorizationsLeft: 2 } })]);
    api.retrySummary.mockResolvedValueOnce({ appointmentId: 'a1', mode: 'run_now', outcome: 'done', authorizationsUsed: 0, authorizationsLeft: 2 });
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    expect(screen.getByTestId('admission-retry-dialog')).toHaveTextContent(ta('retry.bodyNow'));
    expect(screen.getByTestId('admission-retry-dialog')).not.toHaveTextContent('llamadas pagas');
    fireEvent.click(screen.getByTestId('admission-retry-dialog-confirm'));
    expect(await screen.findByTestId('admission-notice')).toHaveTextContent(ta('retry.ranDone'));
  });

  it('o "roda agora" que não gerou o resumo NÃO é erro de HTTP: avisa que ainda não saiu', async () => {
    api.listAppointments.mockResolvedValue([appt({ summaryRetry: { exhausted: false, authorizationsLeft: 2 } })]);
    api.retrySummary.mockResolvedValue({ appointmentId: 'a1', mode: 'run_now', outcome: 'summary_failed', authorizationsUsed: 0, authorizationsLeft: 2 });
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    fireEvent.click(screen.getByTestId('admission-retry-dialog-confirm'));
    expect(await screen.findByTestId('admission-notice')).toHaveTextContent(ta('retry.ranNotDone'));
  });

  it.each([
    ['SUMMARY_RETRY_LIMIT_REACHED', 'retryLimitReached'],
    ['SUMMARY_RETRY_NOT_ALLOWED', 'retryNotAllowed'],
  ])('409 %s: o diálogo mostra o motivo e a lista recarrega', async (code, key) => {
    api.listAppointments.mockResolvedValueOnce([exhausted()]);
    api.listAppointments.mockResolvedValueOnce([exhausted(0)]);
    api.retrySummary.mockRejectedValue(new ApiError({ success: false, error: 'x', code }, 409));
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    fireEvent.click(screen.getByTestId('admission-retry-dialog-confirm'));
    expect(await screen.findByTestId('admission-retry-dialog-error')).toHaveTextContent(ta(`errors.${key}`));
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('admission-retry-limit-a1')).toBeInTheDocument();
  });

  it('erro sem código (rede) mostra a mensagem genérica e NÃO recarrega', async () => {
    api.listAppointments.mockResolvedValue([exhausted()]);
    api.retrySummary.mockRejectedValue(new Error('boom'));
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    fireEvent.click(screen.getByTestId('admission-retry-dialog-confirm'));
    expect(await screen.findByTestId('admission-retry-dialog-error')).toHaveTextContent(ta('errors.retryFailed'));
    expect(api.listAppointments).toHaveBeenCalledTimes(1);
  });

  it('segundo clique em "Reintentar" durante a chamada não manda uma 2ª requisição (botão travado enquanto ocupado)', async () => {
    api.listAppointments.mockResolvedValue([exhausted()]);
    api.retrySummary.mockReturnValue(new Promise(() => {}));
    renderTab();
    fireEvent.click(await screen.findByTestId('admission-retry-summary-a1'));
    const confirm = screen.getByTestId('admission-retry-dialog-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(confirm).toHaveTextContent(ta('retry.busy'));
    expect(api.retrySummary).toHaveBeenCalledTimes(1);
  });
});
