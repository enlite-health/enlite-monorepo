/**
 * LocalizacoesCard — remover Localización (spec 044, D4).
 *
 * A lixeira `delete-address-<id>`: desabilitada com o motivo nos 2 casos (vaga/serviço apontando; Principal
 * com outro endereço ativo), habilitada no livre. Confirmar abre um diálogo do design system (nunca
 * `window.confirm`), chama `AdminApiService.deletePatientAddress` e recarrega. 409 mostra a mensagem e
 * recarrega. Endereços de ficção.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') {
    return typeof opts === 'object' && opts !== null
      ? cur.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(opts[k] ?? _))
      : cur;
  }
  if (typeof opts === 'string') return opts;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const deletePatientAddress = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    deletePatientAddress: (...a: unknown[]) => deletePatientAddress(...a),
    updatePatientAddressLogistics: vi.fn(),
  },
}));
const confirmSpy = vi.spyOn(window, 'confirm');

import { LocalizacoesCard } from '../LocalizacoesCard';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';

const addr = (over: Partial<PatientAddressDetail>): PatientAddressDetail => ({
  id: 'x', addressType: 'casa_madre', addressTypeOther: null, addressFormatted: 'Calle Falsa 1, Ciudad Ficticia', addressRaw: null,
  complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: false, neighborhood: null, logisticsCorridor: null,
  accessNotes: null, country: 'AR', city: null, state: null, vacancyRefCount: 0, serviceRefCount: 0, ...over,
});
const PRINCIPAL = addr({ id: 'principal', isPrimary: true });
const LIVRE = addr({ id: 'livre' });
const COM_VAGA = addr({ id: 'comvaga', vacancyRefCount: 2, serviceRefCount: 1 });
const COM_SERVICO = addr({ id: 'comservico', serviceRefCount: 3 });
const btn = (id: string) => screen.getByTestId(`delete-address-${id}`) as HTMLButtonElement;

describe('LocalizacoesCard — lixeira (spec 044)', () => {
  const onSaved = vi.fn();
  beforeEach(() => { deletePatientAddress.mockReset().mockResolvedValue(undefined); onSaved.mockReset(); confirmSpy.mockClear(); });

  it('desabilitada com vaga/serviço apontando, com o motivo e as contagens no title', () => {
    render(<LocalizacoesCard addresses={[PRINCIPAL, COM_VAGA, COM_SERVICO]} patientId="p1" onSaved={onSaved} />);
    expect(btn('comvaga')).toBeDisabled();
    expect(btn('comvaga')).toHaveAttribute('title', 'Tem 2 vagas / 1 serviços associados');
    expect(btn('comservico')).toBeDisabled();
    expect(btn('comservico')).toHaveAttribute('title', 'Tem 0 vagas / 3 serviços associados');
  });

  it('desabilitada no Principal com outro endereço ativo ("marque outro como principal primeiro")', () => {
    render(<LocalizacoesCard addresses={[PRINCIPAL, LIVRE]} patientId="p1" onSaved={onSaved} />);
    expect(btn('principal')).toBeDisabled();
    expect(btn('principal')).toHaveAttribute('title', 'Marque outro endereço como principal primeiro');
  });

  it('vaga/serviço tem precedência sobre o motivo do Principal quando os dois valem', () => {
    render(<LocalizacoesCard addresses={[addr({ id: 'p', isPrimary: true, vacancyRefCount: 1 }), LIVRE]} patientId="p1" />);
    expect(btn('p')).toHaveAttribute('title', 'Tem 1 vagas / 0 serviços associados');
  });

  it('habilitada no livre; o Principal SOZINHO também pode ser excluído (o último endereço é permitido)', () => {
    const { unmount } = render(<LocalizacoesCard addresses={[PRINCIPAL, LIVRE]} patientId="p1" />);
    expect(btn('livre')).not.toBeDisabled();
    unmount();
    render(<LocalizacoesCard addresses={[PRINCIPAL]} patientId="p1" />);
    expect(btn('principal')).not.toBeDisabled();
  });

  it('contagens ausentes (API antiga) contam 0: habilitada', () => {
    render(<LocalizacoesCard addresses={[addr({ id: 'velho', vacancyRefCount: undefined, serviceRefCount: undefined })]} patientId="p1" />);
    expect(btn('velho')).not.toBeDisabled();
  });

  it('o title de desabilitada também está num <span> pai (botão desabilitado não recebe hover em todo navegador)', () => {
    render(<LocalizacoesCard addresses={[COM_VAGA]} patientId="p1" />);
    expect(btn('comvaga').parentElement).toHaveAttribute('title', 'Tem 2 vagas / 1 serviços associados');
  });

  it('sem patientId não há lixeira (a coluna de ações some junto)', () => {
    render(<LocalizacoesCard addresses={[LIVRE]} />);
    expect(screen.queryByTestId('delete-address-livre')).toBeNull();
  });

  it('clicar abre o diálogo do design system (NUNCA window.confirm) e não chama o service ainda', () => {
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    expect(screen.getByTestId('delete-address-confirm')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deletePatientAddress).not.toHaveBeenCalled();
  });

  it('cancelar fecha o diálogo sem chamar o service', () => {
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-cancel'));
    expect(screen.queryByTestId('delete-address-confirm')).toBeNull();
    expect(deletePatientAddress).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('confirmar chama o service com paciente + endereço, fecha o diálogo e recarrega o detalhe', async () => {
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    await waitFor(() => expect(deletePatientAddress).toHaveBeenCalledWith('p1', 'livre'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('delete-address-confirm')).toBeNull();
    expect(screen.queryByTestId('address-delete-error')).toBeNull();
  });

  it('409 ADDRESS_IN_USE: mostra a mensagem com as contagens do servidor e recarrega a lista', async () => {
    deletePatientAddress.mockRejectedValueOnce(new PatientApiError('ADDRESS_IN_USE', 409, { details: { vacancies: 1, services: 2 } }));
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    const err = await screen.findByTestId('address-delete-error');
    expect(err).toHaveTextContent('Não foi possível excluir: agora ela tem 1 vagas / 2 serviços associados.');
    expect(err).toHaveAttribute('role', 'alert');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('409 ADDRESS_IN_USE sem details no corpo: cai em 0/0, nunca quebra', async () => {
    deletePatientAddress.mockRejectedValueOnce(new PatientApiError('ADDRESS_IN_USE', 409));
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    expect(await screen.findByTestId('address-delete-error')).toHaveTextContent('0 vagas / 0 serviços');
  });

  it('409 PRIMARY_WITH_OTHERS: mostra a mensagem do Principal e recarrega', async () => {
    deletePatientAddress.mockRejectedValueOnce(new PatientApiError('PRIMARY_WITH_OTHERS', 409));
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    expect(await screen.findByTestId('address-delete-error')).toHaveTextContent('marque outro endereço como principal primeiro');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('outro erro (404, 500, rede, não-PatientApiError): mensagem genérica, sem recarregar e sem eco do servidor', async () => {
    deletePatientAddress.mockRejectedValueOnce(new PatientApiError('pg: detalhe interno', 500));
    const { unmount } = render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    const err = await screen.findByTestId('address-delete-error');
    expect(err).toHaveTextContent('Não foi possível excluir a localização. Tente de novo.');
    expect(err).not.toHaveTextContent('detalhe interno');
    expect(onSaved).not.toHaveBeenCalled();
    unmount();

    deletePatientAddress.mockRejectedValueOnce(new Error('rede caiu'));
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    expect(await screen.findByTestId('address-delete-error')).toHaveTextContent('Tente de novo');
  });

  it('confirmar sem onSaved também não quebra (ramo opcional)', async () => {
    render(<LocalizacoesCard addresses={[LIVRE]} patientId="p1" />);
    fireEvent.click(btn('livre'));
    fireEvent.click(screen.getByTestId('delete-address-confirm-btn'));
    await waitFor(() => expect(deletePatientAddress).toHaveBeenCalled());
  });
});
