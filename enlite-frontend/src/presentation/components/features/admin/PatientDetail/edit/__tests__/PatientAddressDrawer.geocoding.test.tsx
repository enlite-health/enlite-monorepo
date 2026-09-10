/**
 * A prova da condição C3 do `lex`: digitar o domicílio de um paciente NÃO fala com o Google.
 *
 * Por que este arquivo existe separado do `PatientAddressDrawer.test.tsx`: lá o
 * `ServiceAreaMap` é um dublê, e um dublê nunca chamaria o Geocoder — a asserção passaria
 * sozinha e não mediria nada (D170: a prova é o espião na FRONTEIRA, com o instrumento
 * mostrando que sabe contar). Aqui o mapa é o de verdade e o espião está em
 * `google.maps.Geocoder`, que é por onde o endereço sairia.
 *
 * O que esta tela fazia até 10/09/2026: `ServiceAreaMap` recebia o texto do campo e o efeito
 * era chaveado nele, sem debounce — 19 letras digitadas, 19 geocodificações do domicílio de
 * um paciente (D289). O controle POSITIVO abaixo é o que impede este arquivo de virar
 * teatro: ele prova que o mesmo espião DISPARA quando um endereço textual chega ao mapa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { createPatientAddress: vi.fn(), updatePatientAddressLogistics: vi.fn() },
}));

// ⚠️ `ServiceAreaMap` NÃO é mockado aqui — é o objeto sob medição.
import { PatientAddressDrawer } from '../PatientAddressDrawer';

/** Toda ida ao Google que sairia deste drawer. */
let geocode: ReturnType<typeof vi.fn>;
let placeChanged: Array<() => void>;
let placeDevolvido: Partial<google.maps.places.PlaceResult> | undefined;

const ESCOLHIDO: Partial<google.maps.places.PlaceResult> = {
  formatted_address: 'Av. Corrientes 1234, C1043 CABA, Argentina',
  geometry: { location: { lat: () => -34.6037, lng: () => -58.3816 } } as google.maps.places.PlaceResult['geometry'],
};

beforeEach(() => {
  geocode = vi.fn().mockResolvedValue({ results: [] });
  placeChanged = [];
  placeDevolvido = undefined;

  class AutocompleteFake {
    addListener(evento: string, cb: () => void): void { if (evento === 'place_changed') placeChanged.push(cb); }
    getPlace(): Partial<google.maps.places.PlaceResult> | undefined { return placeDevolvido; }
  }

  vi.stubGlobal('google', {
    maps: {
      places: { Autocomplete: AutocompleteFake, PlacesServiceStatus: { OK: 'OK' } },
      event: { clearInstanceListeners: vi.fn() },
      Geocoder: class { geocode = geocode; },
      Map: class { setCenter = vi.fn(); },
      Marker: class { setPosition = vi.fn(); },
    },
  });
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function assentar(ms = 60): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe('PatientAddressDrawer — o que sai para o Google ao digitar (lex C3)', () => {
  it('digitar o domicílio letra a letra NÃO gera geocodificação nenhuma', async () => {
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();
    const campo = screen.getByTestId('pad-address');

    // O gesto real: o texto cresce a cada tecla, e cada valor intermediário é um endereço
    // parcial de paciente. Antes, cada um destes era uma chamada ao Geocoder.
    const alvo = 'Av. Corrientes 1234';
    for (let i = 1; i <= alvo.length; i += 1) {
      fireEvent.change(campo, { target: { value: alvo.slice(0, i) } });
    }
    await assentar();

    expect(geocode).toHaveBeenCalledTimes(0);
  });

  it('escolher da lista também não geocodifica: a coordenada já veio no Place Details', async () => {
    render(<PatientAddressDrawer patientId="p1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await assentar();

    placeDevolvido = ESCOLHIDO;
    await act(async () => { placeChanged.forEach((cb) => cb()); });
    await assentar();

    expect(screen.getByTestId('pad-address')).toHaveValue(ESCOLHIDO.formatted_address);
    expect(geocode).toHaveBeenCalledTimes(0);
  });

  it('CONTROLE POSITIVO: o mesmo espião dispara quando um endereço textual chega ao mapa', async () => {
    // Linha legada, sem coordenada gravada: o modo edição ainda recupera o pino
    // geocodificando UMA vez o endereço já persistido. Se este caso não acusasse, os dois
    // zeros acima significariam "não olhei", não "não foi".
    render(
      <PatientAddressDrawer
        patientId="p1"
        address={{
          id: 'addr1', addressType: 'primary', addressFormatted: 'Rua Legada 9', addressRaw: null,
          complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true,
          neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR',
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await assentar();

    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledWith(expect.objectContaining({ address: 'Rua Legada 9' }));
  });
});
