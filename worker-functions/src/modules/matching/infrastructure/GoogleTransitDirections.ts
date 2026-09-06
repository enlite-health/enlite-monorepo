/**
 * GoogleTransitDirections — a chamada à **Routes API** do Google, modo TRANSIT.
 *
 * ⚖️ Esta é a fronteira externa. O que sai daqui são DUAS coordenadas de
 * domicílio na mesma requisição. O parecer do `lex` (05/09) deu PARE nisto; o
 * Gabriel decidiu prosseguir assumindo a responsabilidade — ver
 * `.claude/docs/autorizacao-google-directions.md` e a D264. Quem for mexer
 * aqui: leia aquele documento antes, porque o que este arquivo faz não é um
 * detalhe de implementação, é a decisão.
 *
 * ⚠️ **Routes API, e não a Directions clássica.** Medido em 05/09: o SDK
 * `@googlemaps/google-maps-services-js` chama a API legada, que responde
 * `REQUEST_DENIED — You're calling a legacy API, which is not enabled for your
 * project`. O Google aposentou aquele produto. Por isso aqui é `fetch` direto
 * contra `routes.googleapis.com`, com `X-Goog-FieldMask` — que é obrigatório:
 * sem ele a API recusa o pedido.
 *
 * O que este arquivo garante, e que não custa nada:
 *   - a chamada sai do SERVIDOR. Nunca do navegador do staff — assim não vão
 *     junto os cookies da conta Google dele nem o referrer do painel, e a chave
 *     não fica exposta no bundle;
 *   - chave PRÓPRIA (`GOOGLE_DIRECTIONS_API_KEY`), restrita à Routes API. A
 *     chave do browser é de referrer e o Google a RECUSA vindo de servidor
 *     (`requests from referer <empty> are blocked`) — o que é a postura certa;
 *   - sem chave configurada, o serviço não chama nada e devolve vazio. É o
 *     interruptor: em qualquer ambiente onde a variável não exista, nenhuma
 *     coordenada sai.
 */
import { logger } from '@shared/logging';
import type { RawRoute } from '../domain/transitRoute';

export interface LatLng { lat: number; lng: number }

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Só os campos que o parser lê. O FieldMask é obrigatório na Routes API — e
 * pedir menos também é minimização: o Google não devolve polilinha, tarifa nem
 * horário absoluto porque não pedimos.
 */
const FIELD_MASK = [
  'routes.duration',
  'routes.legs.duration',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.transitDetails',
].join(',');

const TIMEOUT_MS = 8000;

export class GoogleTransitDirections {
  /**
   * Chave DEDICADA. O fallback para `GOOGLE_MAPS_API_KEY` existe só para
   * ambiente de desenvolvimento; em produção a do browser não funciona aqui
   * (é restrita a referrer), então na prática o fallback é inerte.
   */
  private readonly apiKey = process.env.GOOGLE_DIRECTIONS_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? '';

  /** Está configurado para chamar? Sem isto, nada sai do perímetro. */
  get enabled(): boolean {
    return this.apiKey !== '';
  }

  async transit(origin: LatLng, destination: LatLng): Promise<RawRoute[]> {
    if (!this.enabled) {
      logger.info({ msg: 'directions.skipped', reason: 'no_api_key' });
      return [];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
          destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
          travelMode: 'TRANSIT',
          computeAlternativeRoutes: true,
          languageCode: 'es',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // ⚠️ O corpo do erro do Google ECOA as coordenadas enviadas. Só o
        // status entra no log.
        logger.info({ msg: 'directions.denied', status: res.status });
        return [];
      }

      const data = (await res.json()) as { routes?: RawRoute[] };
      // Sem rota é resposta legítima ("não há trajeto"), não erro: a Routes API
      // devolve 200 com o corpo vazio.
      if (!data.routes?.length) {
        logger.info({ msg: 'directions.no_route' });
        return [];
      }
      return data.routes;
    } catch (err: unknown) {
      // Idem: a mensagem pode carregar a URL/corpo. Só o tipo.
      logger.info({ msg: 'directions.failed', kind: err instanceof Error ? err.name : 'unknown' });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
