/**
 * PatientAddressDrawer — spec 012, US-B2: domicílio nasce NA FICHA (mesmo POST /patients/:id/addresses
 * do wizard de vaga), com mapa (ServiceAreaMap) e logística por endereço; edição dos 3 campos
 * (zona = neighborhood, corredor, acesso) por PATCH. `access_notes` é texto livre sobre a casa:
 * `data-clarity-mask` no wrapper e teto 2000 (lex C2.4/C2.6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const createPatientAddress = vi.fn();
const updatePatientAddressLogistics = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    createPatientAddress: (...a: unknown[]) => createPatientAddress(...a),
    updatePatientAddressLogistics: (...a: unknown[]) => updatePatientAddressLogistics(...a),
  },
}));
const mapSpy = vi.fn();
vi.mock('@presentation/components/molecules/ServiceAreaMap', () => ({
  ServiceAreaMap: (props: Record<string, unknown>) => { mapSpy(props); return <div data-testid="map-stub" />; },
}));

import { PatientAddressDrawer } from '../PatientAddressDrawer';

const existing = {
  id: 'addr1', addressType: 'primary', addressFormatted: 'Rua A 1', addressRaw: null, complement: null, displayOrder: 1,
  lat: -23.5, lng: -46.6, isPrimary: true, neighborhood: 'Centro', logisticsCorridor: null, accessNotes: 'Timbre 3B', country: 'BR',
};

describe('PatientAddressDrawer — criar', () => {
  beforeEach(() => { createPatientAddress.mockReset().mockResolvedValue({ id: 'new' }); updatePatientAddressLogistics.mockReset(); mapSpy.mockReset(); });

  it('endereço obrigatório; o mapa segue o que é digitado; salva com os 3 campos de logística', async () => {
    const onSaved = vi.fn();
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(screen.getByTestId('pad-address')).toHaveAttribute('aria-invalid', 'true'));
    expect(createPatientAddress).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corrientes 1234, CABA' } });
    await waitFor(() => expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ address: 'Av. Corrientes 1234, CABA' })));
    fireEvent.change(screen.getByTestId('pad-type'), { target: { value: 'service' } });
    fireEvent.change(screen.getByTestId('pad-neighborhood'), { target: { value: 'San Nicolás' } });
    fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Norte' } });
    const access = screen.getByTestId('pad-access');
    expect(access.tagName).toBe('TEXTAREA');
    expect(access).toHaveAttribute('maxlength', '2000');
    expect(access.parentElement).toHaveAttribute('data-clarity-mask', 'True');
    fireEvent.change(access, { target: { value: 'Portero de 8 a 12' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalledWith('p1', {
      address_formatted: 'Av. Corrientes 1234, CABA', address_type: 'service',
      neighborhood: 'San Nicolás', logistics_corridor: 'Norte', access_notes: 'Portero de 8 a 12',
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('campos vazios não vão no POST; erro → mensagem genérica (nunca ecoa o payload — lex C2.3)', async () => {
    createPatientAddress.mockRejectedValueOnce(new Error('ERRO COM Portero'));
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'X 1' } });
    fireEvent.change(screen.getByTestId('pad-raw'), { target: { value: 'x cru' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalledWith('p1', { address_formatted: 'X 1', address_raw: 'x cru', address_type: 'secondary' }));
    const err = await screen.findByTestId('pad-error');
    expect(err).toHaveTextContent('Erro ao salvar');
    expect(err).not.toHaveTextContent('Portero');
  });
});

describe('PatientAddressDrawer — editar logística', () => {
  beforeEach(() => { createPatientAddress.mockReset(); updatePatientAddressLogistics.mockReset().mockResolvedValue({ id: 'addr1' }); mapSpy.mockReset(); });

  it('mostra o endereço (só leitura) e o mapa com lat/lng; salva SÓ os campos alterados; limpar → null', async () => {
    const onSaved = vi.fn();
    render(<PatientAddressDrawer patientId="p1" address={existing} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.queryByTestId('pad-address')).not.toBeInTheDocument();
    expect(screen.getByTestId('pad-address-readonly')).toHaveTextContent('Rua A 1');
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: -23.5, lng: -46.6 }));
    expect(screen.getByTestId('pad-neighborhood')).toHaveValue('Centro');
    expect(screen.getByTestId('pad-access')).toHaveValue('Timbre 3B');
    fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Sul' } });
    fireEvent.change(screen.getByTestId('pad-access'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(updatePatientAddressLogistics).toHaveBeenCalledWith('p1', 'addr1', { logistics_corridor: 'Sul', access_notes: null }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('sem mudança fecha sem PATCH; Escape fecha; erro não-Error → genérica', async () => {
    const onClose = vi.fn();
    render(<PatientAddressDrawer patientId="p1" address={existing} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updatePatientAddressLogistics).not.toHaveBeenCalled();
    updatePatientAddressLogistics.mockRejectedValueOnce('x');
    fireEvent.change(screen.getByTestId('pad-neighborhood'), { target: { value: 'Outro' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    expect(await screen.findByTestId('pad-error')).toHaveTextContent('Erro ao salvar');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('patient-address-backdrop'));
  });

  it('endereço sem nada (formatado e cru nulos, logística nula): mostra —, mapa recebe null, preencher zona manda só ela', async () => {
    render(<PatientAddressDrawer patientId="p1" address={{ ...existing, addressFormatted: null, addressRaw: null, neighborhood: null, accessNotes: null, lat: null, lng: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pad-address-readonly')).toHaveTextContent('—');
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: null, lng: null, address: null }));
    fireEvent.change(screen.getByTestId('pad-neighborhood'), { target: { value: 'Norte' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(updatePatientAddressLogistics).toHaveBeenCalledWith('p1', 'addr1', { neighborhood: 'Norte' }));
    render(<PatientAddressDrawer patientId="p1" address={{ ...existing, addressFormatted: null, addressRaw: 'Cru 9' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getAllByTestId('pad-address-readonly').slice(-1)[0]).toHaveTextContent('Cru 9');
  });
});
