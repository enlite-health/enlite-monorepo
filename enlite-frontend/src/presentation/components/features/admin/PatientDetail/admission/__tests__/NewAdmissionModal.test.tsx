/**
 * NewAdmissionModal — "Nueva agenda" (spec 049, F7). Aceite A7-3: responsável sem vínculo `linked` aparece
 * DESABILITADO com "Sin Tactiq vinculado" e não é selecionável. Mais: padrão = quem está logado (se vinculado),
 * hora de parede sem fuso/`Date` no payload, janela 8h-22h, horário futuro e os erros 409/422 do servidor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@infrastructure/http/ApiError';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { INPUT_SIZE_CONFIG } from '@presentation/components/atoms/Input/inputClasses';
import { i18nMock, host, NOW, tEs } from './admissionTestKit';

vi.mock('react-i18next', () => i18nMock);
const api = vi.hoisted(() => ({ listHosts: vi.fn(), bookAppointment: vi.fn() }));
vi.mock('@infrastructure/http/AdminAdmissionApiService', () => ({ AdminAdmissionApiService: api }));

import { NewAdmissionModal } from '../NewAdmissionModal';

const HOSTS = [
  host({ email: 'ana@example.test', displayName: 'Ana Prueba' }),
  host({ email: 'beto@example.test', displayName: 'Beto Prueba', linked: false, linkState: 'missing' }),
  host({ email: 'caro@example.test', displayName: null, linked: false, linkState: 'wrong_account' }),
  host({ email: 'dani@example.test', displayName: 'Dani Prueba' }),
];
const now = () => NOW; // 12/10/2026 15:00Z = 12/10 12:00 em Buenos Aires

function setMe(email: string | null): void {
  useAdminAuthStore.setState({ adminProfile: email ? ({ email } as never) : null });
}

function renderModal(props: Partial<React.ComponentProps<typeof NewAdmissionModal>> = {}) {
  const onBooked = vi.fn();
  const onClose = vi.fn();
  render(<NewAdmissionModal patientId="p1" country="AR" now={now} onBooked={onBooked} onClose={onClose} {...props} />);
  return { onBooked, onClose };
}

function fill(date: string, time: string): void {
  fireEvent.change(screen.getByTestId('admission-date-input'), { target: { value: date } });
  fireEvent.change(screen.getByTestId('admission-time-input'), { target: { value: time } });
}

beforeEach(() => {
  api.listHosts.mockReset().mockResolvedValue(HOSTS);
  api.bookAppointment.mockReset();
  setMe('dani@example.test');
});
afterEach(() => setMe(null));

describe('A7-3 — responsável sem vínculo', () => {
  it('aparece desabilitado com "Sin Tactiq vinculado" e não é selecionável', async () => {
    renderModal();
    const radio = await screen.findByTestId('admission-host-radio-beto@example.test');
    expect(radio).toBeDisabled();
    expect(screen.getByTestId('admission-host-beto@example.test')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('admission-host-reason-beto@example.test')).toHaveTextContent('Sin Tactiq vinculado');
    // Clique de verdade (user-event respeita `disabled`; o `fireEvent` do jsdom marca um radio desabilitado).
    await userEvent.click(radio);
    expect(radio).not.toBeChecked();
    expect(screen.getByTestId('admission-host-radio-dani@example.test')).toBeChecked(); // a escolha anterior não mudou
    await userEvent.click(screen.getByText('Beto Prueba'));
    expect(radio).not.toBeChecked();
    expect(screen.getByTestId('admission-host-radio-dani@example.test')).toBeChecked();
  });

  it('o motivo acompanha o estado do vínculo (conta errada diz por quê); vinculados não têm motivo', async () => {
    renderModal();
    await screen.findByTestId('admission-host-radio-caro@example.test');
    expect(screen.getByTestId('admission-host-reason-caro@example.test')).toHaveTextContent('la cuenta vinculada no corresponde');
    expect(screen.queryByTestId('admission-host-reason-ana@example.test')).not.toBeInTheDocument();
  });

  it('o padrão é quem está logado, se estiver no roster e vinculado; não pisa na escolha depois', async () => {
    renderModal();
    expect(await screen.findByTestId('admission-host-radio-dani@example.test')).toBeChecked();
    fireEvent.click(screen.getByTestId('admission-host-radio-ana@example.test'));
    expect(screen.getByTestId('admission-host-radio-ana@example.test')).toBeChecked();
    expect(screen.getByTestId('admission-host-radio-dani@example.test')).not.toBeChecked();
  });

  it('logado SEM vínculo (ou fora do roster): nenhum padrão — a pessoa escolhe', async () => {
    setMe('beto@example.test');
    renderModal();
    await screen.findByTestId('admission-host-radio-ana@example.test');
    expect(screen.getByTestId('admission-host-radio-ana@example.test')).not.toBeChecked();
    expect(screen.getByTestId('admission-host-radio-beto@example.test')).not.toBeChecked();
    expect(screen.getByTestId('admission-new-submit')).toBeDisabled();
  });

  it('o país pedido ao servidor é o do paciente', async () => {
    renderModal({ country: 'BR' });
    await screen.findByTestId('admission-host-list');
    expect(api.listHosts).toHaveBeenCalledWith('BR');
  });

  it('falha ao carregar responsáveis: erro + tentar de novo (e roster vazio é dito)', async () => {
    api.listHosts.mockRejectedValueOnce(new Error('x'));
    renderModal();
    expect(await screen.findByTestId('admission-hosts-error')).toBeInTheDocument();
    api.listHosts.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId('admission-hosts-retry'));
    expect(await screen.findByTestId('admission-hosts-empty')).toBeInTheDocument();
  });
});

describe('tamanho dos campos', () => {
  it('data e hora usam o tamanho compact do painel (h-12), não o default de 60px', async () => {
    renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    for (const id of ['admission-date-input', 'admission-time-input']) {
      const classes = screen.getByTestId(id).className.split(' ');
      expect(classes).toContain(INPUT_SIZE_CONFIG.compact.height);
      expect(classes).not.toContain(INPUT_SIZE_CONFIG.default.height);
    }
  });
});

describe('agendar', () => {
  it('manda a HORA DE PAREDE digitada, sem fuso e sem Date, e avisa quem chamou', async () => {
    api.bookAppointment.mockResolvedValue({ admissionCode: 'ADM-1' });
    const { onBooked } = renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    fill('2026-10-14', '09:30');
    fireEvent.click(screen.getByTestId('admission-new-submit'));
    await waitFor(() => expect(onBooked).toHaveBeenCalledTimes(1));
    expect(api.bookAppointment).toHaveBeenCalledWith('p1', { hostEmail: 'dani@example.test', slotStartISO: '2026-10-14T09:30' });
  });

  it('botão travado até ter responsável, data e hora válidos', async () => {
    renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    expect(screen.getByTestId('admission-new-submit')).toBeDisabled();
    fill('2026-10-14', '09:30');
    expect(screen.getByTestId('admission-new-submit')).not.toBeDisabled();
  });

  it('fora da janela 8h-22h e horário passado são recusados na tela (e dizem por quê)', async () => {
    renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    fill('2026-10-14', '07:00');
    expect(screen.getByTestId('admission-slot-problem')).toHaveTextContent('entre las 08:00 y las 21:00');
    expect(screen.getByTestId('admission-new-submit')).toBeDisabled();
    fill('2026-10-14', '21:30');
    expect(screen.getByTestId('admission-new-submit')).toBeDisabled();
    // agora são 12:00 em Buenos Aires: 09:00 de hoje já passou
    fill('2026-10-12', '09:00');
    expect(screen.getByTestId('admission-slot-problem')).toHaveTextContent('horario futuro');
    expect(screen.getByTestId('admission-new-submit')).toBeDisabled();
    fill('2026-10-12', '13:00');
    expect(screen.queryByTestId('admission-slot-problem')).not.toBeInTheDocument();
    expect(screen.getByTestId('admission-new-submit')).not.toBeDisabled();
  });

  it.each([
    [409, 'SLOT_TAKEN', 'slotTaken'],
    [409, 'TACTIQ_LINK_REQUIRED', 'tactiqLinkRequired'],
    [422, 'SLOT_IN_PAST', 'slotInPast'],
    [422, 'HOST_NOT_IN_ROSTER', 'hostNotInRoster'],
  ])('%s %s: mensagem própria, o modal fica aberto e o botão volta', async (status, code, key) => {
    api.bookAppointment.mockRejectedValue(new ApiError({ success: false, error: 'dado@example.test', code }, status));
    const { onBooked, onClose } = renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    fill('2026-10-14', '09:30');
    fireEvent.click(screen.getByTestId('admission-new-submit'));
    const msg = await screen.findByTestId('admission-book-error');
    expect(msg).toHaveTextContent(tEs(`admin.patients.detail.admissionTab.errors.${key}`));
    expect(msg).not.toHaveTextContent('dado@example.test'); // nunca ecoa o texto do servidor
    expect(onBooked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('admission-new-submit')).not.toBeDisabled();
  });

  it('erro desconhecido cai na mensagem genérica; Esc e "Volver" fecham', async () => {
    api.bookAppointment.mockRejectedValue(new Error('rede'));
    const { onClose } = renderModal();
    await screen.findByTestId('admission-host-radio-dani@example.test');
    fill('2026-10-14', '09:30');
    fireEvent.click(screen.getByTestId('admission-new-submit'));
    expect(await screen.findByTestId('admission-book-error')).toHaveTextContent(tEs('admin.patients.detail.admissionTab.errors.bookFailed'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('admission-new-cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
