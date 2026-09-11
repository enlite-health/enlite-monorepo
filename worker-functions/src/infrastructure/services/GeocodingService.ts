import { Client, GeocodeResult, Status } from '@googlemaps/google-maps-services-js';

/**
 * Decide se um resultado do Geocoding é específico o suficiente pra ser
 * persistido. Rejeita:
 *   - Resultados cujo top-level type é country/admin_area_level_1/level_2
 *     (Google retornou centroide quando não achou o endereço).
 *   - location_type APPROXIMATE combinado com types administrativos coarse.
 * Aceita:
 *   - ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER em qualquer types.
 *   - APPROXIMATE em locality/sublocality (centro do bairro é aceitável).
 */
function isPreciseEnough(result: GeocodeResult, allowCoarse = false): boolean {
  const types = (result.types ?? []) as string[];
  const locType = (result.geometry?.location_type ?? '') as string;

  // Centroide de país nunca serve (é o fallback do Google quando não achou nada).
  if (types.length > 0 && types[0] === 'country') return false;

  // Nível provincia/partido: rejeitado por padrão (endereço de paciente precisa
  // de ponto preciso), mas ACEITO em allowCoarse — usado só pelo backfill de
  // ZONA de worker, onde provincia/localidad já é o suficiente.
  const adminCoarseTypes = new Set([
    'administrative_area_level_1',
    'administrative_area_level_2',
  ]);
  if (!allowCoarse && types.length > 0 && adminCoarseTypes.has(types[0])) return false;

  if (locType === 'APPROXIMATE') {
    const allowedApprox = new Set(['locality', 'sublocality', 'sublocality_level_1', 'neighborhood']);
    if (allowCoarse) {
      allowedApprox.add('administrative_area_level_1');
      allowedApprox.add('administrative_area_level_2');
    }
    return types.some((t) => allowedApprox.has(t));
  }

  return true;
}

/** Raw Google address_components entry — subset consumed by locationHelpers. */
export interface GeocodedAddressComponent {
  long_name: string;
  short_name?: string;
  types: string[];
}

export interface GeocodedAddress {
  formattedAddress: string;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number;
  longitude: number;
  placeId: string;
  /**
   * Raw address_components from the Google Geocoding response. Optional —
   * populated by `geocode()`/`geocodeBatch()`. Kept alongside the already
   * `city`/`state` heuristic parse (which uses coarse
   * locality/administrative_area_level_2) so callers that need the finer
   * Argentina-specific extraction (province canonicalization, postal-code
   * stripping, neighborhood) can re-derive it via
   * `locationHelpers.extractStateFromLocationStrict` and friends instead of
   * duplicating Google address parsing. Used by the Fase 1 patient-address
   * location backfill (`scripts/backfill-patient-addresses-location.ts`).
   */
  addressComponents?: GeocodedAddressComponent[];
  /**
   * Google's own "this wasn't quite the address you asked for" flag — true
   * when the geocoder had to relax part of the query to find a match (e.g.
   * dropped a street number, or matched a different street). Surfaced so the
   * Fase 1 patient-address backfill can treat these as UNRESOLVED instead of
   * silently writing a guessed location — see
   * `backfillPatientAddressLocation.classifyBackfillUnresolved`.
   */
  partialMatch?: boolean;
}

export class GeocodingService {
  private client: Client;
  private apiKey: string;

  constructor() {
    this.client = new Client({});
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY || '';

    if (!this.apiKey) {
      console.warn('⚠️  GOOGLE_MAPS_API_KEY não configurada - geocodificação desabilitada');
    }
  }

  /**
   * Geocodifica um endereço usando Google Maps Geocoding API.
   * Retorna null para endereços não encontrados (ZERO_RESULTS) ou quando
   * o Google só conseguiu resolver no nível de país/região (centroide
   * fallback que distorce match por proximidade).
   * Lança erro para problemas de API (REQUEST_DENIED, OVER_QUERY_LIMIT).
   */
  async geocode(
    address: string,
    country = 'AR',
    opts: { allowCoarse?: boolean } = {},
  ): Promise<GeocodedAddress | null> {
    if (!this.apiKey) return null;
    if (!address || address.trim().length < 3) return null;

    const response = await this.client.geocode({
      params: {
        address: address.trim(),
        region: country.toLowerCase(),
        // Rótulos em espanhol — evita "Buenos Aires Province"/"Córdoba Province"
        // (inglês) que fragmentam provincia no dropdown/analytics.
        language: 'es',
        key: this.apiKey,
      },
      timeout: 5000,
      // Desativa retry automático do SDK — rate limit é tratado em geocodeBatch
      raxConfig: { retry: 0 },
    });

    const status = response.data.status as Status;

    if (status === Status.ZERO_RESULTS) return null;

    if (status !== Status.OK) {
      throw new Error(`Geocoding API error: ${status} — ${response.data.error_message ?? ''}`);
    }

    const top = response.data.results[0];

    // Reject country-level / region-level fallback results — quando o Google
    // não acha o endereço específico ele retorna o centroide do país/província
    // com types=['country',...] e location_type=APPROXIMATE. Isso quebra
    // qualquer match por proximidade no banco — preferimos NULL.
    if (!isPreciseEnough(top, opts.allowCoarse)) return null;

    return this.parseGeocodeResult(top, country);
  }

  /**
   * Geocodifica múltiplos endereços em batch com rate limiting e retry em caso
   * de OVER_QUERY_LIMIT (aguarda 1s e tenta mais uma vez antes de desistir).
   */
  async geocodeBatch(
    addresses: string[],
    country = 'AR',
    delayMs = 200,
    opts: { allowCoarse?: boolean } = {},
  ): Promise<(GeocodedAddress | null)[]> {
    const results: (GeocodedAddress | null)[] = [];

    for (let i = 0; i < addresses.length; i++) {
      let result: GeocodedAddress | null = null;
      try {
        result = await this.geocode(addresses[i], country, opts);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('OVER_QUERY_LIMIT') || msg.includes('REQUEST_DENIED')) {
          // Espera 1s e tenta uma vez mais antes de desistir
          await new Promise(r => setTimeout(r, 1000));
          try {
            result = await this.geocode(addresses[i], country, opts);
          } catch {
            // PII: nunca logar o endereço (dado pessoal do paciente/worker). Índice,
            // tamanho e o status da API bastam pra achar o item na lista e diagnosticar.
            console.warn(`  ⚠ Geocoding falhou definitivamente: index=${i} length=${addresses[i].length} status=${msg}`);
          }
        } else {
          console.warn(`  ⚠ Geocoding erro: index=${i} length=${addresses[i].length} status=${msg}`);
        }
      }
      results.push(result);

      if (delayMs > 0 && i < addresses.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return results;
  }

  private parseGeocodeResult(result: GeocodeResult, defaultCountry: string): GeocodedAddress {
    const components = result.address_components;
    const city    = this.findComponent(components, ['locality', 'administrative_area_level_2']);
    const state   = this.findComponent(components, ['administrative_area_level_1']);
    const country = this.findComponent(components, ['country']) || defaultCountry;

    return {
      formattedAddress: result.formatted_address,
      city,
      state,
      country,
      latitude:  result.geometry.location.lat,
      longitude: result.geometry.location.lng,
      placeId:   result.place_id,
      addressComponents: components as unknown as GeocodedAddressComponent[],
      partialMatch: result.partial_match === true,
    };
  }

  private findComponent(components: GeocodeResult['address_components'], types: string[]): string | null {
    for (const type of types) {
      const component = components.find((c: any) => c.types.includes(type));
      if (component) return component.long_name;
    }
    return null;
  }

  normalizeZone(zone: string, country = 'AR'): string {
    const normalized = zone.trim().toUpperCase();
    const zoneMap: Record<string, string> = {
      'CABA':           'Ciudad Autónoma de Buenos Aires, Argentina',
      'CAPITAL':        'Ciudad Autónoma de Buenos Aires, Argentina',
      'CAPITAL FEDERAL':'Ciudad Autónoma de Buenos Aires, Argentina',
      'GBA':            'Gran Buenos Aires, Argentina',
      'ZONA NORTE':     'Zona Norte, Gran Buenos Aires, Argentina',
      'ZONA SUR':       'Zona Sur, Gran Buenos Aires, Argentina',
      'ZONA OESTE':     'Zona Oeste, Gran Buenos Aires, Argentina',
    };
    return zoneMap[normalized] ?? `${zone}, ${country === 'AR' ? 'Argentina' : country}`;
  }
}
