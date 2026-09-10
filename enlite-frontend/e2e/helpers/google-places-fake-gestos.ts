/**
 * google-places-fake-gestos.ts
 *
 * Um fake do widget de autocomplete do Google que reproduz o que foi MEDIDO no Chrome contra
 * o Google real em 10/09/2026, digitando "Av. Corrientes 1234" e variando só o gesto:
 *
 *   | gesto                    | `place_changed` | o que `getPlace()` devolve                     |
 *   |--------------------------|-----------------|------------------------------------------------|
 *   | digitar                  | NÃO dispara     | —                                              |
 *   | Enter SEM seta           | dispara         | **só `{ name }`** — sem formatted_address       |
 *   | ArrowDown + Enter        | dispara         | place completo (formatted_address + geometry)   |
 *   | clique na sugestão       | dispara         | place completo                                  |
 *
 * ⚠️ Por que não usar o `google-maps-fake.ts`: aquele dispara `place_changed` no evento
 * `input`, a partir de 4 caracteres. O widget real NÃO faz isso. Um teste que afirma
 * "digitar sem escolher não grava" passa lá só porque a string era curta demais para acordar
 * o fake — mede o limiar do dublê, não a regra do produto. Ele segue servindo ao fluxo do
 * prestador, onde a distinção não muda o veredito; aqui ela é o veredito.
 *
 * O `.pac-container` também é reproduzido — pendurado em `document.body`, como o Google faz
 * (medido: filho DIRETO do body, profundidade 0, fora de shadow root) — para que a máscara do
 * Clarity seja exercitada de verdade.
 */

import { type Page } from '@playwright/test';

/** O que o "Google" devolve quando o operador escolhe de fato. */
export interface PlaceFalso {
  formatted_address: string;
  lat: number;
  lng: number;
}

export const CABA_CORRIENTES: PlaceFalso = {
  formatted_address: 'Av. Corrientes 1234, C1043AAZ Cdad. Autónoma de Buenos Aires, Argentina',
  lat: -34.6037,
  lng: -58.3816,
};

export function scriptFakeDeGestos(place: PlaceFalso): string {
  return `
(() => {
  const PLACE = ${JSON.stringify(place)};
  const completo = () => ({
    formatted_address: PLACE.formatted_address,
    name: 'Av. Corrientes 1234',
    geometry: { location: { lat: () => PLACE.lat, lng: () => PLACE.lng } },
    address_components: [
      { long_name: 'Av. Corrientes', short_name: 'Av. Corrientes', types: ['route'] },
      { long_name: '1234', short_name: '1234', types: ['street_number'] },
      { long_name: 'Buenos Aires', short_name: 'CABA', types: ['locality'] },
      { long_name: 'Argentina', short_name: 'AR', types: ['country'] },
    ],
  });

  class Autocomplete {
    constructor(input) {
      this.input = input;
      this.cb = null;
      this.place = undefined;
      this.destacado = false;

      // O dropdown nasce COM o widget e mora no <body> — é o que faz a máscara do
      // Clarity ser exercitada de verdade neste teste.
      this.pac = document.createElement('div');
      this.pac.className = 'pac-container';
      this.pac.style.display = 'none';
      const item = document.createElement('div');
      item.className = 'pac-item';
      item.textContent = PLACE.formatted_address;
      item.addEventListener('mousedown', () => { this.place = completo(); this.input.value = PLACE.formatted_address; this.cb && this.cb(); });
      this.pac.appendChild(item);
      document.body.appendChild(this.pac);

      input.addEventListener('input', () => {
        // Digitar NÃO dispara place_changed — só mostra a lista, como o widget real.
        this.pac.style.display = input.value.length > 2 ? 'block' : 'none';
        this.destacado = false;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { this.destacado = true; return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (this.destacado) { this.place = completo(); input.value = PLACE.formatted_address; }
        // Enter SEM seta: o toco. Só \`name\`, exatamente como o Google devolve.
        else { this.place = { name: input.value }; }
        this.pac.style.display = 'none';
        this.cb && this.cb();
      });
    }
    addListener(ev, cb) { if (ev === 'place_changed') this.cb = cb; }
    getPlace() { return this.place; }
  }

  window.google = {
    maps: {
      places: {
        Autocomplete,
        PlacesServiceStatus: { OK: 'OK' },
        // Se alguma tela ainda adivinhar a 1ª predição, o teste VÊ: estes espiões contam.
        AutocompleteService: class { getPlacePredictions(_r, cb) { window.__placesPredictions = (window.__placesPredictions || 0) + 1; cb([{ place_id: 'p1' }], 'OK'); } },
        PlacesService: class { getDetails(_r, cb) { window.__placesDetails = (window.__placesDetails || 0) + 1; cb(completo(), 'OK'); } },
      },
      event: { clearInstanceListeners: () => {} },
      Geocoder: class { geocode() { window.__geocodes = (window.__geocodes || 0) + 1; return Promise.resolve({ results: [] }); } },
      Map: class { setCenter() {} },
      Marker: class { setPosition() {} },
    },
  };
  window.__placesPredictions = 0;
  window.__placesDetails = 0;
  window.__geocodes = 0;
})();
`;
}

/** Instala o fake antes de qualquer navegação. */
export async function instalarFakeDeGestos(page: Page, place: PlaceFalso = CABA_CORRIENTES): Promise<void> {
  await page.addInitScript(scriptFakeDeGestos(place));
}

/** Quantas idas ao Google a página fez — 0 é o esperado nos caminhos que não escolhem. */
export async function contarChamadasAoGoogle(page: Page): Promise<{ predictions: number; details: number; geocodes: number }> {
  return page.evaluate(() => ({
    predictions: (window as unknown as { __placesPredictions: number }).__placesPredictions ?? 0,
    details: (window as unknown as { __placesDetails: number }).__placesDetails ?? 0,
    geocodes: (window as unknown as { __geocodes: number }).__geocodes ?? 0,
  }));
}
