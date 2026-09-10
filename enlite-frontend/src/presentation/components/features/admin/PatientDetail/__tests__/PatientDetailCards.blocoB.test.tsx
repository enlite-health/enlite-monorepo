/**
 * Cards da ficha — ramos do bloco B (spec 012) e os que a régua de 100% do arquivo tocado cobra:
 * fechar/salvar os drawers abertos pelos cards (onClose/onSaved), fallbacks de campo nulo,
 * as faixas etárias e a data de início do serviço.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from './patientDetailFixture';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return typeof opts === 'object' && opts ? cur.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => opts[k] ?? _) : cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: 'x' }) }));
const api = { updatePatientSection: vi.fn(), listInsuranceProviders: vi.fn(), createPatientAddress: vi.fn(), updatePatientAddressLogistics: vi.fn() };
vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: {
  updatePatientSection: (...a: unknown[]) => api.updatePatientSection(...a),
  listInsuranceProviders: (...a: unknown[]) => api.listInsuranceProviders(...a),
  createPatientAddress: (...a: unknown[]) => api.createPatientAddress(...a),
  updatePatientAddressLogistics: (...a: unknown[]) => api.updatePatientAddressLogistics(...a),
} }));
vi.mock('@presentation/components/molecules/ServiceAreaMap', () => ({ ServiceAreaMap: () => <div data-testid="map-stub" /> }));

import { CoberturaMedicaCard } from '../CoberturaMedicaCard';
import { LocalizacoesCard } from '../LocalizacoesCard';
import { FamiliaresCard } from '../FamiliaresCard';
import { PatientGeneralInfoCard } from '../PatientGeneralInfoCard';
import { DiagnosticoCard } from '../DiagnosticoCard';

beforeEach(() => {
  api.updatePatientSection.mockReset().mockResolvedValue({ id: 'x' });
  api.listInsuranceProviders.mockReset().mockResolvedValue([]);
  api.createPatientAddress.mockReset().mockResolvedValue({ id: 'new' });
  api.updatePatientAddressLogistics.mockReset().mockResolvedValue({ id: 'addr1' });
});

describe('CoberturaMedicaCard — drawer', () => {
  it('fechar pelo backdrop → drawer some (onClose); salvar com mudança → onSaved; codes ausentes caem no escalar', async () => {
    const onSaved = vi.fn();
    render(<CoberturaMedicaCard patient={{ ...patientDetailFixture, insuranceVerified: 'Plan cru', insuranceVerifiedCodes: undefined as never }} onSaved={onSaved} />);
    expect(screen.getByTestId('coverage-verified')).toHaveTextContent('Plan cru');
    fireEvent.click(screen.getByTestId('edit-coverage-btn'));
    fireEvent.click(screen.getByTestId('patient-coverage-edit-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('patient-coverage-edit-drawer')).toBeNull(), { timeout: 1500 });
    fireEvent.click(screen.getByTestId('edit-coverage-btn'));
    fireEvent.change(screen.getByTestId('pcv-affiliate'), { target: { value: 'AF-9' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('CoberturaMedicaCard — contatos de emergência da cobertura (417, D301.3b)', () => {
  it('lista tipo traduzido, nome e telefone com o BLOCO mascarado para o Clarity (lex C2.1); sem contatos ou sem célula (`null`) mostra "—"', () => {
    const { unmount } = render(<CoberturaMedicaCard patient={{ ...patientDetailFixture, coverageEmergencyContacts: [
      { id: 'c1', kind: 'AMBULANCE', name: 'Ambulancia OSDE', phone: '0800-1', sortOrder: 0 },
      { id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dra. Pérez', phone: '11-5555', sortOrder: 1 },
    ] }} />);
    const row = screen.getByTestId('coverage-emergency-contacts');
    expect(row).toHaveTextContent(`${t('admin.patients.detail.coverageCard.emergencyContactKinds.AMBULANCE')}: Ambulancia OSDE · 0800-1`);
    expect(row).toHaveTextContent(`${t('admin.patients.detail.coverageCard.emergencyContactKinds.DIRECT_PROFESSIONAL')}: Dra. Pérez · 11-5555`);
    const bloco = row.querySelector('[data-clarity-mask="True"]') as HTMLElement;
    expect(bloco).not.toBeNull();
    expect(bloco.textContent).toContain('Dra. Pérez'); // o NOME também está dentro da máscara
    expect(screen.queryByTestId('coverage-direct-professional-redacted')).toBeNull();
    unmount();
    render(<CoberturaMedicaCard patient={{ ...patientDetailFixture, coverageEmergencyContacts: null }} />);
    expect(screen.getByTestId('coverage-emergency-contacts')).toHaveTextContent('—');
  });

  it('lex C3 / D167 — profissional retido: aviso junto da lista; leitura indisponível: aviso âmbar, nunca "—"', () => {
    const { unmount } = render(<CoberturaMedicaCard patient={{ ...patientDetailFixture, coverageEmergencyContacts: [
      { id: 'c1', kind: 'AMBULANCE', name: 'Ambulancia OSDE', phone: '0800-1', sortOrder: 0 },
    ], coverageDirectProfessionalRedacted: true }} />);
    expect(screen.getByTestId('coverage-direct-professional-redacted')).toHaveTextContent(t('admin.patients.detail.coverageCard.directProfessionalRedacted'));
    expect(screen.getByTestId('coverage-emergency-contacts')).toHaveTextContent('Ambulancia OSDE');
    unmount();
    render(<CoberturaMedicaCard patient={{ ...patientDetailFixture, coverageEmergencyContacts: [], coverageEmergencyContactsUnavailable: true }} />);
    expect(screen.getByTestId('coverage-emergency-contacts-unavailable')).toHaveTextContent(t('admin.patients.detail.coverageCard.emergencyContactsUnavailable'));
    expect(screen.getByTestId('coverage-emergency-contacts').querySelectorAll('li')).toHaveLength(0); // nem lista, nem o "—" de vazio
    // LISTA A3: campo AUSENTE (backend anterior à 417) = "não li", como o PDF — nunca "—".
    const { coverageEmergencyContacts: _c, ...semCampo } = patientDetailFixture as typeof patientDetailFixture & { coverageEmergencyContacts?: unknown };
    render(<CoberturaMedicaCard patient={semCampo as typeof patientDetailFixture} />);
    expect(screen.getAllByTestId('coverage-emergency-contacts-unavailable')).toHaveLength(2);
  });
});

describe('LocalizacoesCard — drawer', () => {
  /**
   * Desde 10/09 o endereço só nasce de uma ESCOLHA na lista do Google (PEND-06 + lex C4):
   * digitar à mão não grava mais. Este stub encena o gesto da operadora — sem ele o teste
   * ficava esperando um `onSaved` que, corretamente, não vem.
   */
  let placeChanged: Array<() => void> = [];
  const escolhido = {
    formatted_address: 'Rua Nova 1',
    geometry: { location: { lat: () => -34.6, lng: () => -58.4 } },
  };
  function stubGooglePlaces(): void {
    placeChanged = [];
    class AutocompleteFake {
      addListener(evento: string, cb: () => void): void { if (evento === 'place_changed') placeChanged.push(cb); }
      getPlace(): typeof escolhido { return escolhido; }
    }
    vi.stubGlobal('google', {
      maps: { places: { Autocomplete: AutocompleteFake, PlacesServiceStatus: { OK: 'OK' } }, event: { clearInstanceListeners: vi.fn() } },
    });
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
  }

  it('criar pelo drawer → onSaved; Escape → onClose (drawer some)', async () => {
    stubGooglePlaces();
    const onSaved = vi.fn();
    render(<LocalizacoesCard addresses={[]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('new-address-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => { placeChanged.forEach((cb) => cb()); });
    expect(screen.getByTestId('pad-address')).toHaveValue('Rua Nova 1');
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('patient-address-drawer')).toBeNull(), { timeout: 1500 });
    render(<LocalizacoesCard addresses={[]} patientId="p2" />);
    fireEvent.click(screen.getAllByTestId('new-address-btn')[1]);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('patient-address-drawer')).toBeNull(), { timeout: 1500 });
  });
});

describe('FamiliaresCard — ramos', () => {
  const nulls = { id: 'r0', firstName: null, lastName: null, relationship: null, phone: null, email: null, documentType: null, documentNumber: null, isPrimary: false, displayOrder: 1, source: 'clickup' };

  it('responsibles ausente → vazio; linha com tudo nulo → traços; parentesco fora do enum → cru', () => {
    render(<FamiliaresCard responsibles={undefined as never} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
    render(<FamiliaresCard responsibles={[{ ...nulls, id: 'r1', relationship: 'MOM' }, nulls]} />);
    expect(screen.getByText('MOM')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(6);
    for (const btn of screen.getAllByTestId('edit-support-btn')) expect(btn).toBeDisabled();
  });

  it('com patientId: abre o drawer, Escape fecha (onClose), salvar → onSaved; sem onSaved não quebra', async () => {
    const onSaved = vi.fn();
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-support-btn'));
    expect(screen.getByTestId('patient-support-edit-drawer')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('patient-support-edit-drawer')).toBeNull(), { timeout: 1500 });
    fireEvent.click(screen.getByTestId('edit-support-btn'));
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p2" />);
    fireEvent.click(screen.getAllByTestId('edit-support-btn')[1]);
    fireEvent.click(screen.getAllByTestId('psn-save').slice(-1)[0] as HTMLElement);
    await waitFor(() => expect(api.updatePatientSection).toHaveBeenCalledTimes(2));
  });
});

describe('PatientGeneralInfoCard — idade, faixas, início do serviço, drawer', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-03T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['2024-12-01T00:00:00Z', '1 anos', '0-2'],     // mês de nascimento à frente (m < 0)
    ['2020-09-10T00:00:00Z', '5 anos', '3-12'],    // mesmo mês, dia ainda não chegou
    ['2010-01-01T00:00:00Z', '16 anos', '13-17'],
    ['2000-01-01T00:00:00Z', '26 anos', '18-29'],
    ['1980-01-01T00:00:00Z', '46 anos', '30-59'],
    ['1950-01-01T00:00:00Z', '76 anos', '60+'],
  ])('%s → %s / faixa %s', (birthDate, age, bracket) => {
    render(<PatientGeneralInfoCard patient={{ ...patientDetailFixture, birthDate }} />);
    expect(screen.getByText(age)).toBeInTheDocument();
    expect(screen.getByText(bracket)).toBeInTheDocument();
  });

  it('início do serviço formatado (US-B9); sem data → —; formatação que lança cai no ISO', () => {
    render(<PatientGeneralInfoCard patient={{ ...patientDetailFixture, serviceStartDate: '2026-09-01T00:00:00Z' }} />);
    expect(screen.getByText(/Início do serviço/)).toBeInTheDocument();
    expect(screen.getAllByText(/2026|1\/9\/2026|01\/09\/2026/).length).toBeGreaterThan(0);
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => { throw new RangeError('locale'); });
    try {
      render(<PatientGeneralInfoCard patient={{ ...patientDetailMinimal, birthDate: '1999-05-05T00:00:00Z' }} />);
      expect(screen.getByText('1999-05-05T00:00:00Z')).toBeInTheDocument();
    } finally { spy.mockRestore(); }
  });

  it('drawer geral: Escape fecha (onClose); salvar com mudança → onSaved; sem onSaved não quebra', async () => {
    vi.useRealTimers();
    const onSaved = vi.fn();
    render(<PatientGeneralInfoCard patient={patientDetailFixture} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-general-btn'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('patient-general-edit-drawer')).toBeNull(), { timeout: 1500 });
    fireEvent.click(screen.getByTestId('edit-general-btn'));
    fireEvent.change(screen.getByTestId('pge-lastName'), { target: { value: 'Outro' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    fireEvent.click(screen.getAllByTestId('edit-general-btn')[1]);
    fireEvent.change(screen.getAllByTestId('pge-lastName').slice(-1)[0] as HTMLElement, { target: { value: 'Outro2' } });
    fireEvent.click(screen.getAllByTestId('pge-save').slice(-1)[0] as HTMLElement);
    await waitFor(() => expect(api.updatePatientSection).toHaveBeenCalledTimes(2));
  });
});

describe('DiagnosticoCard — dispositivos', () => {
  it('lista traduzida; código fora do catálogo cai no cru; ausente → —', () => {
    // 06/09 (variante B): cada dispositivo virou um CHIP — a lista deixou de ser uma string
    // juntada por vírgula, mas a regra continua a mesma (traduz o do catálogo, cru o de fora).
    render(<DiagnosticoCard patient={{ ...patientDetailFixture, deviceTypes: ['HOME', 'CODIGO_NOVO'] }} />);
    expect(screen.getByText('Domiciliar')).toBeInTheDocument();
    expect(screen.getByText('CODIGO_NOVO')).toBeInTheDocument();
    render(<DiagnosticoCard patient={{ ...patientDetailMinimal, deviceTypes: undefined as never }} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText(/ICHOM|Especialidade/)).not.toBeInTheDocument();
  });
});
