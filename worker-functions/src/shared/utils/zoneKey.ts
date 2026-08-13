/**
 * zoneKey — chave de deduplicação determinística para "zona geográfica",
 * usada por GetZoneAnalyticsUseCase para agregar worker×paciente na mesma
 * zona sem depender de rótulo cru.
 *
 * DECISÃO (2026-07-13, user): agregação é por PROVÍNCIA, não por
 * localidade/bairro. Motivo consciente: `worker_service_areas.city` tem
 * granularidade grossa e inconsistente (às vezes bairro, às vezes vazio,
 * às vezes texto livre em work_zone/interest_zone) — chavear por localidade
 * fragmentava "CABA" em dezenas de bairros e dependia de "primeiro rótulo
 * visto" pra decidir o label exibido (não-determinístico entre runs).
 * Província é o nível que sobrevive à granularidade ruim: worker com
 * state='Buenos Aires' e paciente com city='Barrio Norte' (sem state) caem
 * na MESMA zona (a província deles), que é o objetivo de negócio.
 *
 * Reusa o MESMO SSOT de:
 *   - canonicalProvince (normalizeLocationValue.ts) — o mesmo usado pelo
 *     filtro de Prestadores (dropdown de Provincia); aceita `city` como
 *     desambiguador quando `state` é o valor cru "Buenos Aires" (CABA vs PBA).
 *   - isJunkLocation (normalizeLocationValue.ts) — canonicalProvince NÃO
 *     retorna null para uma província desconhecida/lixo (CPA postal, ex.
 *     "B1748 AEJ"): a regra dela é "resto → inalterado" (devolve o state cru).
 *     Sem esse guard, um CPA sujo viraria uma "zona" fantasma. Aqui
 *     reaplicamos isJunkLocation sobre o resultado pra capturar esse caso e
 *     cair em "Não informado" corretamente.
 *   - normalizeSearch (lowercase + strip de acentos, já usado por
 *     BlindIndexService pra normalizar termos de busca) — resolve variantes
 *     de escrita da mesma província (ex.: "Córdoba" vs "CORDOBA" cru antes de
 *     canonicalProvince normalizar — defesa extra, canonicalProvince já
 *     normaliza a maioria dos casos conhecidos).
 *
 * Localidade (bairro/cidade) NÃO entra mais na chave nem no rótulo — isso é
 * uma mudança de comportamento consciente desta revisão (era locality-first
 * com fallback pra província; agora é só província), não uma regressão.
 */
import { canonicalProvince, isJunkLocation } from './normalizeLocationValue';
import { normalizeSearch } from './normalizeSearch';

/** Chave interna (não exibida) para o bucket de zonas não resolvíveis. */
export const UNRESOLVED_ZONE_KEY = '__unresolved__';

/** Rótulo exibido para o bucket de zonas não resolvíveis. */
export const UNRESOLVED_ZONE_LABEL = 'Não informado';

export interface ZoneKeyResult {
  /** Chave determinística lowercase+unaccent — usar para dedupe (Map/Set). */
  key: string;
  /** Rótulo human-readable para exibição — a própria província canônica. */
  label: string;
}

/**
 * Resolve a chave de zona canônica + rótulo de exibição a partir de
 * (state, city) crus. Chave e rótulo são SEMPRE a província canônica
 * (`canonicalProvince`, que já usa `city` para desambiguar quando precisa).
 * Bucket "Não informado" quando a província não resolve (state nulo/vazio)
 * OU quando o valor resolvido é lixo (CPA postal etc. — `isJunkLocation`,
 * já que `canonicalProvince` devolve o state cru para província desconhecida
 * em vez de null).
 */
export function resolveZoneKey(
  state: string | null | undefined,
  city: string | null | undefined,
): ZoneKeyResult {
  const province = canonicalProvince(state ?? null, city ?? null);

  if (!province || isJunkLocation(province)) {
    return { key: UNRESOLVED_ZONE_KEY, label: UNRESOLVED_ZONE_LABEL };
  }

  return { key: normalizeSearch(province), label: province };
}
