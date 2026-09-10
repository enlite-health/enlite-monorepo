/**
 * PatientAddressDrawer — spec 012, US-B2: domicílio nasce NA FICHA (mesmo POST /patients/:id/addresses
 * do wizard de vaga), com mapa (ServiceAreaMap) e logística por endereço; edição dos 3 campos
 * (zona = neighborhood, corredor, acesso) por PATCH. `access_notes` é texto livre sobre a casa:
 * `data-clarity-mask` no wrapper e teto 2000 (lex C2.4/C2.6).
 *
 * Autocomplete (PEND-06 da ata de 09/09/2026, parecer do `lex` de 10/09):
 * o endereço só nasce de uma ESCOLHA na lista do Google — texto digitado à mão não grava
 * (decisão do Gabriel, ramo "justificativa escrita" da condição C4). O que este arquivo trava:
 *  • C3 — o mapa recebe a coordenada da escolha e NUNCA o texto digitado (o geocoding por
 *    tecla morreu aqui); o espião no Geocoder vive em `PatientAddressDrawer.geocoding.test.tsx`.
 *  • C4 — digitar sem escolher é barrado, com mensagem própria (não é o erro de "campo vazio").
 *  • C5 — `place_id` não entra no payload.
 *  • C6 — nada do que se digita atravessa para `console.*` nem para o Clarity.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

/**
 * O widget do Google, de mentira. Guarda o handler de `place_changed` para que o teste
 * possa encenar o gesto real da operadora: escolher uma linha da lista.
 */
let placeChanged: Array<() => void>;
let placeDevolvido: Partial<google.maps.places.PlaceResult> | undefined;
let widgetsCriados: number;
/** Toda ida ao Places que sairia do drawer — o chute do Enter passaria por aqui. */
let getPlacePredictions: Mock;
let getDetails: Mock;

const ESCOLHIDO: Partial<google.maps.places.PlaceResult> = {
  formatted_address: 'Av. Corrientes 1234, C1043 CABA, Argentina',
  place_id: 'ChIJ-place-id-do-google',
  geometry: { location: { lat: () => -34.6037, lng: () => -58.3816 } } as google.maps.places.PlaceResult['geometry'],
};

function stubGoogle(): void {
  class AutocompleteFake {
    constructor() { widgetsCriados += 1; }
    addListener(evento: string, cb: () => void): void { if (evento === 'place_changed') placeChanged.push(cb); }
    getPlace(): Partial<google.maps.places.PlaceResult> | undefined { return placeDevolvido; }
  }
  getPlacePredictions = vi.fn((_req, cb: (p: unknown, s: string) => void) =>
    cb([{ place_id: 'chutado' }], 'OK'));
  getDetails = vi.fn((_req, cb: (d: unknown, s: string) => void) =>
    cb({ formatted_address: 'ENDEREÇO CHUTADO PELO GOOGLE', geometry: { location: { lat: () => 1, lng: () => 2 } } }, 'OK'));
  vi.stubGlobal('google', {
    maps: {
      places: {
        Autocomplete: AutocompleteFake,
        PlacesServiceStatus: { OK: 'OK' },
        AutocompleteService: class { getPlacePredictions = getPlacePredictions; },
        PlacesService: class { getDetails = getDetails; },
      },
      event: { clearInstanceListeners: vi.fn() },
    },
  });
}

/** Deixa o efeito assíncrono de inicialização do widget terminar. */
async function assentar(ms = 50): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** Encena a escolha de uma linha da lista de sugestões do Google. */
async function escolherDaLista(place = ESCOLHIDO): Promise<void> {
  placeDevolvido = place;
  await act(async () => { placeChanged.forEach((cb) => cb()); });
}

describe('PatientAddressDrawer — criar', () => {
  beforeEach(() => {
    createPatientAddress.mockReset().mockResolvedValue({ id: 'new' });
    updatePatientAddressLogistics.mockReset();
    mapSpy.mockReset();
    placeChanged = [];
    placeDevolvido = undefined;
    widgetsCriados = 0;
    stubGoogle();
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('escolher da lista preenche o campo, leva a COORDENADA ao mapa e salva com os 3 campos de logística', async () => {
    const onSaved = vi.fn();
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={onSaved} />);
    await assentar();

    // Campo vazio: barra, e a mensagem é a de "informe o endereço".
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(screen.getByTestId('pad-address')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText(t('admin.patients.detail.addressDrawer.addressRequired'))).toBeInTheDocument();
    expect(createPatientAddress).not.toHaveBeenCalled();

    // Digitar NÃO manda nada ao mapa: sem escolha não há coordenada, e o texto não é
    // geocodificado (lex C3). É o oposto do que esta tela fazia antes.
    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corr' } });
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: null, lng: null, address: null }));

    await escolherDaLista();
    expect(screen.getByTestId('pad-address')).toHaveValue(ESCOLHIDO.formatted_address);
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: -34.6037, lng: -58.3816, address: null }));

    fireEvent.change(screen.getByTestId('pad-type'), { target: { value: 'service' } });
    fireEvent.change(screen.getByTestId('pad-neighborhood'), { target: { value: 'San Nicolás' } });
    fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Norte' } });
    const access = screen.getByTestId('pad-access');
    expect(access.tagName).toBe('TEXTAREA');
    expect(access).toHaveAttribute('maxlength', '2000');
    expect(access.parentElement).toHaveAttribute('data-clarity-mask', 'True');
    fireEvent.change(access, { target: { value: 'Portero de 8 a 12' } });

    fireEvent.click(screen.getByTestId('pad-save'));
    // lex C5: as chaves são EXATAMENTE estas — `place_id` não entra.
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalledWith('p1', {
      address_formatted: ESCOLHIDO.formatted_address, address_type: 'service',
      neighborhood: 'San Nicolás', logistics_corridor: 'Norte', access_notes: 'Portero de 8 a 12',
    }));
    const enviado = createPatientAddress.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(enviado)).not.toContain('place_id');
    expect(JSON.stringify(enviado)).not.toContain('ChIJ-place-id-do-google');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('texto digitado à mão, sem escolher da lista, NÃO grava — e a mensagem é a própria (C4)', async () => {
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();

    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corrientes 1234' } });
    fireEvent.click(screen.getByTestId('pad-save'));

    await waitFor(() => expect(screen.getByText(t('admin.patients.detail.addressDrawer.addressNotPicked'))).toBeInTheDocument());
    // Não é o erro de campo vazio: a operadora precisa saber que o problema é OUTRO.
    expect(screen.queryByText(t('admin.patients.detail.addressDrawer.addressRequired'))).not.toBeInTheDocument();
    expect(createPatientAddress).not.toHaveBeenCalled();
  });

  it('digitar DEPOIS de escolher desfaz a escolha: volta a barrar e o mapa perde o pino', async () => {
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    await escolherDaLista();
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: -34.6037 }));

    // Uma tecla a mais e o texto já não corresponde à coordenada guardada. Gravar assim
    // mandaria o prestador para a porta de outro endereço.
    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: `${ESCOLHIDO.formatted_address} fundos` } });
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: null, lng: null }));
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(screen.getByText(t('admin.patients.detail.addressDrawer.addressNotPicked'))).toBeInTheDocument());
    expect(createPatientAddress).not.toHaveBeenCalled();
  });

  it('escolha da lista SEM `geometry` grava assim mesmo — "sem coordenada" não é "não escolheu"', async () => {
    // D302: se as duas perguntas dividissem um campo só, este endereço legítimo seria
    // barrado como se a operadora não tivesse escolhido nada. O mapa fica sem pino e o
    // servidor geocodifica no insert, como já fazia.
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    await escolherDaLista({ formatted_address: 'Ruta 9 km 42, Córdoba' });

    expect(screen.getByTestId('pad-address')).toHaveValue('Ruta 9 km 42, Córdoba');
    expect(mapSpy).toHaveBeenLastCalledWith(expect.objectContaining({ lat: null, lng: null, address: null }));
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalledWith('p1', {
      address_formatted: 'Ruta 9 km 42, Córdoba', address_type: 'secondary',
    }));
    expect(screen.queryByText(t('admin.patients.detail.addressDrawer.addressNotPicked'))).not.toBeInTheDocument();
  });

  it('erro do servidor → mensagem genérica, nunca o payload (lex C2.3)', async () => {
    createPatientAddress.mockRejectedValueOnce(new Error('ERRO COM Portero'));
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    await escolherDaLista();
    fireEvent.change(screen.getByTestId('pad-raw'), { target: { value: 'x cru' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalledWith('p1', {
      address_formatted: ESCOLHIDO.formatted_address, address_raw: 'x cru', address_type: 'secondary',
    }));
    const err = await screen.findByTestId('pad-error');
    expect(err).toHaveTextContent('Erro ao salvar');
    expect(err).not.toHaveTextContent('Portero');
  });

  it('lex C6: nada do que se digita atravessa para console nem para o Clarity', async () => {
    const espioes = {
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    };
    const clarity = vi.fn();
    vi.stubGlobal('clarity', clarity);

    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corrientes 1234' } });
    await escolherDaLista();
    fireEvent.change(screen.getByTestId('pad-access'), { target: { value: 'Portero de 8 a 12' } });
    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(createPatientAddress).toHaveBeenCalled());

    const colher = (): string => JSON.stringify([
      ...Object.values(espioes).flatMap((e) => e.mock.calls),
      ...clarity.mock.calls,
    ]);

    // 1) A asserção real, sobre TUDO que o DRAWER produziu — não sobre a chamada que eu
    //    lembrei de conferir (molde da D170).
    const atravessou = colher();
    expect(atravessou).not.toContain('Corrientes');
    expect(atravessou).not.toContain('Portero');
    expect(atravessou).not.toContain('ChIJ-place-id-do-google');

    // 2) ⚠️ CONTROLE POSITIVO, DEPOIS de medir — e ele existe porque o conjunto acima é
    //    VAZIO. Sem esta parte, `"[]".not.toContain(...)` passaria com os espiões desligados,
    //    com o nome errado no `spyOn` ou com o `JSON.stringify` mudando de forma: o zero
    //    significaria "não olhei" em vez de "não foi". Aqui planto um vazamento e exijo que o
    //    instrumento o veja, nas DUAS metades.
    console.warn('vazamento plantado:', 'Av. Corrientes 1234');
    clarity('set', 'endereco', 'Portero de 8 a 12');
    const comVazamentoPlantado = colher();
    expect(comVazamentoPlantado, 'o espião de console enxerga um vazamento').toContain('Corrientes');
    expect(comVazamentoPlantado, 'o espião do Clarity enxerga um vazamento').toContain('Portero');

    // ⚖️ Honestidade sobre o alcance: HOJE nenhum caminho do drawer chama `window.clarity` —
    //    o único uso em todo o `src/` é `identify`/`set` em `analytics/clarity.ts`, por
    //    `authStore`/`WorkerHome`. A metade "clarity" desta asserção não mede um risco vivo;
    //    ela é guarda de REGRESSÃO, para o dia em que alguém instrumentar esta tela. O risco
    //    vivo do Clarity nesta feature é outro e mora no DOM: a lista de sugestões do Google,
    //    coberta em `useGooglePlacesAutocomplete.test.tsx`.
  });

  it('Enter SEM escolher não grava, não preenche e NÃO gasta chamada ao Places', async () => {
    // Medido no Chrome contra o Google real (10/09): Enter sem seta dispara `place_changed`
    // com um place que só tem `name`. Antes deste conserto, o hook resolvia `predictions[0]`
    // e o drawer marcava como ESCOLHIDO — gravando um domicílio que ninguém viu, com cara de
    // validado. A escolha obrigatória era decorativa para quem usa teclado.
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();

    fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corrientes 1234' } });
    await escolherDaLista({ name: 'Av. Corrientes 1234' }); // o toco do Enter sem seta

    expect(screen.getByTestId('pad-address')).toHaveValue('Av. Corrientes 1234');
    expect(screen.getByTestId('pad-address')).not.toHaveValue('ENDEREÇO CHUTADO PELO GOOGLE');
    // Não é só "não gravou": nem sequer PERGUNTOU ao Google. Menos ida ao Places, e nenhum
    // endereço fabricado. Asserção na fronteira, no molde da D170.
    expect(getPlacePredictions).not.toHaveBeenCalled();
    expect(getDetails).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pad-save'));
    await waitFor(() => expect(screen.getByText(t('admin.patients.detail.addressDrawer.addressNotPicked'))).toBeInTheDocument());
    expect(createPatientAddress).not.toHaveBeenCalled();
  });

  it('Google fora do ar: a tela DIZ que o buscador caiu, em vez de exigir uma escolha impossível', async () => {
    // Com escolha obrigatória, buscador morto = nenhum endereço pode ser cadastrado. O pior
    // desfecho não é o erro: é a operadora tentando de novo sem entender por que "escolha da
    // lista" nunca é satisfeito. Ela precisa saber que o problema não é ela.
    vi.stubGlobal('google', undefined);
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();

    expect(await screen.findByTestId('pad-autocomplete-down')).toHaveTextContent(
      t('admin.patients.detail.addressDrawer.addressAutocompleteDown'),
    );
  });

  it('CONTROLE POSITIVO: com o Google no ar, o aviso de buscador caído NÃO aparece', async () => {
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    expect(screen.queryByTestId('pad-autocomplete-down')).not.toBeInTheDocument();
  });

  it('modo EDIÇÃO não cria widget nenhum: o campo nem está na tela', async () => {
    render(<PatientAddressDrawer patientId="p1" address={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    expect(widgetsCriados).toBe(0);
    // Controle POSITIVO: no modo criar, o mesmo stub CONTA 1 — sem isto, um zero aqui
    // significaria apenas "o stub não funciona".
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    expect(widgetsCriados).toBe(1);
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

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('SEM mudança → Escape fecha direto', async () => {
      const onClose = vi.fn();
      render(<PatientAddressDrawer patientId="p1" address={existing} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('COM mudança (corredor) → Escape abre confirmação; "Seguir editando" mantém o valor', () => {
      render(<PatientAddressDrawer patientId="p1" address={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Sul' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      expect(screen.getByTestId('pad-corridor')).toHaveValue('Sul');
    });

    it('"Descartar cambios" fecha de verdade', async () => {
      const onClose = vi.fn();
      render(<PatientAddressDrawer patientId="p1" address={existing} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Sul' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
    });

    it('modo CRIAR: digitar o endereço → backdrop abre confirmação', () => {
      render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pad-address'), { target: { value: 'Av. Corrientes 1234' } });
      fireEvent.click(screen.getByTestId('patient-address-backdrop'));
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    });

    it('SALVAR nunca pergunta, mesmo com mudança pendente', async () => {
      const onSaved = vi.fn();
      render(<PatientAddressDrawer patientId="p1" address={existing} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('pad-corridor'), { target: { value: 'Sul' } });
      fireEvent.click(screen.getByTestId('pad-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });
  });
});
