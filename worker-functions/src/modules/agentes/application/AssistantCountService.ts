/**
 * AssistantCountService — cola as peças da contagem da Maria (change 085, spec §3/§6, DD2/DD7/DD10/DD11):
 * valida o pedido -> abre o contexto do ator (as três entidades, F-db-2) -> leitor (saída crua) ->
 * materializa zeros (DD10) -> supressão -> resposta de shape fechado com `scope` em espanhol.
 * Nada de linha, id nem nome passa por aqui: só agregados. Não loga corpo.
 */
import type { ActorContext } from '@shared/audit/actorSource';
import type { CountryCode } from '@shared/domain/countryCodes';
import { COUNT_MENU, CountEntity } from '../domain/assistantCountMenu';
import { CanonicalCountRequest, CountRequestError, validateCountRequest } from '../domain/countRequestValidation';
import { buildCountResponse, CountResponse } from '../domain/countResponseShape';
import { RawCountGroup, suppressResult } from '../domain/countSuppression';

/** Saída crua comum dos três leitores. */
export interface RawCountResult {
  total: number;
  groups?: Array<{ key: string; value: number }>;
  restricted_to_admission?: true;
}

export interface CountReaderPort {
  count(request: CanonicalCountRequest, countries: CountryCode[]): Promise<RawCountResult>;
}

/** Abre o `withActorContext` e entrega o leitor ligado ao client da transação. */
export type CountRunner = <T>(actor: ActorContext, fn: (readers: Record<CountEntity, CountReaderPort>) => Promise<T>) => Promise<T>;

export type CountOutcome =
  | { ok: true; response: CountResponse }
  | { ok: false; status: 400; error: CountRequestError };

/** DD11: o total é de prestadores distintos; a soma das zonas pode ser maior. */
const ZONE_OVERLAP_ES = 'con group_by=zone un prestador con áreas en varias zonas cuenta en cada una; el total (distintos) puede ser menor que la suma de los grupos';

export class AssistantCountService {
  constructor(private readonly run: CountRunner) {}

  async count(entity: string, rawQuery: { filters?: unknown; group_by?: unknown }, actor: ActorContext, countries: CountryCode[]): Promise<CountOutcome> {
    const v = validateCountRequest({ entity, filters: rawQuery.filters, group_by: rawQuery.group_by });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const req = v.request;

    const raw = await this.run(actor, (readers) => readers[req.entity].count(req, countries));
    const groups = req.group_by ? materializeZeros(req, raw.groups ?? []) : [];
    const sup = suppressResult(raw.total, groups);

    return {
      ok: true,
      response: buildCountResponse({
        entity: req.entity,
        filters: req.filters,
        group_by: req.group_by,
        total: sup.total,
        groups: sup.groups,
        scope: scopeEs(req, raw.restricted_to_admission === true),
        as_of: new Date().toISOString(),
      }),
    };
  }
}

/** DD10: todo valor do enum do `group_by` aparece (0 onde não houve linha); filtro no MESMO campo restringe a lista. */
function materializeZeros(req: CanonicalCountRequest, found: ReadonlyArray<{ key: string; value: number }>): RawCountGroup[] {
  const field = req.group_by!;
  const sameField = req.filters.find((f) => f.field === field);
  const universe = sameField ? sameField.values : COUNT_MENU[req.entity].fields[field].values;
  const byKey = new Map(found.map((g) => [g.key, g.value]));
  const out: RawCountGroup[] = universe.map((key) => ({ key, count: byKey.get(key) ?? 0 }));
  // chave que o leitor trouxe e o enum não tem: nunca descartar dado em silêncio
  for (const g of found) if (!universe.includes(g.key)) out.push({ key: g.key, count: g.value });
  return out;
}

function scopeEs(req: CanonicalCountRequest, restrictedToAdmission: boolean): string {
  const parts = [COUNT_MENU[req.entity].scope_es];
  if (restrictedToAdmission) parts.push('solo en admisión');
  if (req.entity === 'workers' && req.group_by === 'zone') parts.push(ZONE_OVERLAP_ES);
  const literal = (field: string): readonly string[] => req.filters.find((f) => f.field === field)?.literalValues ?? [];
  if (req.entity === 'workers' && literal('registration').includes('DISABLED')) parts.push('incluye bajas');
  if (req.entity === 'patients' && literal('stage').some((x) => x === 'ALTA' || x === 'DISCHARGED')) parts.push('incluye altas');
  return parts.join('; ');
}
