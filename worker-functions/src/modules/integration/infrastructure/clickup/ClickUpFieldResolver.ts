/**
 * ClickUpFieldResolver — resolve ClickUp custom-field values to human labels.
 *
 * ClickUp returns enum-like values as opaque identifiers:
 *   - `drop_down` fields → orderindex (number)
 *   - `labels` fields     → option id (uuid)
 *
 * This resolver fetches field definitions once from the list and builds
 * lookup maps so callers can translate raw task values to labels.
 *
 * Usage:
 *   const resolver = await ClickUpFieldResolver.fromList(LIST_ID);
 *   resolver.resolveDropdown('Dependencia', 1);       // → 'MUY GRAVE'
 *   resolver.resolveLabel('Cobertura Verificada', '00469b61-...'); // → 'SANIDAD'
 *   resolver.resolveLabels('Tipo de Dispositivo', ['d4a...', '25c...']);
 */

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

interface ClickUpFieldOption {
  id: string;
  name?: string;
  label?: string;
  orderindex: number;
}

interface ClickUpFieldDefinition {
  id: string;
  name: string;
  type: string;
  type_config?: {
    options?: ClickUpFieldOption[];
  };
}

interface ClickUpFieldsResponse {
  fields: ClickUpFieldDefinition[];
}

type DropdownMap = Record<string, Record<number, string>>;
type LabelsMap = Record<string, Record<string, string>>;

export interface ClickUpFieldResolverOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

export class ClickUpFieldResolver {
  private constructor(
    private readonly dropdowns: DropdownMap,
    private readonly labels: LabelsMap,
    private readonly fieldTypes: Record<string, string>,
  ) {}

  static async fromList(
    listId: string,
    opts: ClickUpFieldResolverOptions = {},
  ): Promise<ClickUpFieldResolver> {
    const token = opts.token ?? process.env.CLICKUP_API_TOKEN;
    if (!token) {
      throw new Error('CLICKUP_API_TOKEN missing (set it in .env or pass via opts.token).');
    }

    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${CLICKUP_API_BASE}/list/${listId}/field`, {
      headers: { Authorization: token },
    });
    if (!res.ok) {
      throw new Error(`ClickUp /field API failed: HTTP ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json()) as ClickUpFieldsResponse;
    const dropdowns: DropdownMap = {};
    const labels: LabelsMap = {};
    const fieldTypes: Record<string, string> = {};

    for (const field of payload.fields) {
      fieldTypes[field.name] = field.type;
      const options = field.type_config?.options ?? [];

      if (field.type === 'drop_down') {
        const map: Record<number, string> = {};
        for (const opt of options) {
          map[opt.orderindex] = opt.name ?? opt.label ?? String(opt.orderindex);
        }
        dropdowns[field.name] = map;
      } else if (field.type === 'labels') {
        const map: Record<string, string> = {};
        for (const opt of options) {
          map[opt.id] = opt.label ?? opt.name ?? opt.id;
        }
        labels[field.name] = map;
      }
    }

    return new ClickUpFieldResolver(dropdowns, labels, fieldTypes);
  }

  resolveDropdown(fieldName: string, value: number | string | null | undefined): string | null {
    // Empty is legitimate: nobody filled the field in ClickUp. Everything below is NOT.
    if (value === null || value === undefined || value === '') return null;
    const map = this.dropdowns[fieldName];
    if (!map) {
      // Field renamed, removed, or no longer a drop_down — every task resolves to null from here.
      // C1/lex: the raw value NEVER goes into the log. `value` is typed `number | string`, so a
      // field switched to free text in ClickUp would put whatever a person typed in here.
      // The field name plus the value's type is all the diagnosis needs.
      console.warn('[ClickUpFieldResolver] Unknown drop_down field:', { field: fieldName, valueType: typeof value });
      return null;
    }
    const key = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(key)) {
      // C1/lex: same reason — a non-numeric value is exactly the free-text case. Type only.
      console.warn('[ClickUpFieldResolver] Non-numeric drop_down value:', { field: fieldName, valueType: typeof value });
      return null;
    }
    const label = map[key];
    if (label === undefined) {
      // Option added or reordered in ClickUp — the orderindex no longer resolves.
      // C1/lex: the orderindex is NOT logged. This line is on the live clinical path —
      // `Segmentos Clínicos`, `Sexo Asignado al Nacer (Uso Clínico)`, `Dependencia` and
      // `Servicio` are all drop_down today and all resolve through here — and the
      // orderindex IS the clinical value in coded form, decodable by anyone holding the
      // token (`/list/<id>/field`). Coding is not protecting. The alarm the operator needs
      // is "field X failed to resolve"; WHICH option is answered from the catalog (C2).
      // Unconditional on purpose: a per-field "is this clinical?" list would leak silently
      // the day a new clinical field is added.
      console.warn('[ClickUpFieldResolver] Unresolved drop_down value (orderindex withheld — C1/lex):', {
        field: fieldName,
        valueType: typeof value,
        isArray: Array.isArray(value),
      });
      return null;
    }
    return label;
  }

  resolveLabel(fieldName: string, id: string | null | undefined): string | null {
    // Empty is legitimate: nobody filled the field in ClickUp. Everything below is NOT.
    if (!id) return null;
    const map = this.labels[fieldName];
    if (!map) {
      // Field renamed, removed, or no longer a labels field — every task resolves to null from here.
      // C3/lex: the option id is NOT logged. See the block above `resolveLabels`.
      console.warn('[ClickUpFieldResolver] Unknown labels field (option id withheld — C1/C3/lex):', {
        field: fieldName,
        valueType: typeof id,
        isArray: Array.isArray(id),
      });
      return null;
    }
    const label = map[id];
    if (label === undefined) {
      // C3/lex: the option id is NOT logged — it IS the clinical value in coded form.
      console.warn('[ClickUpFieldResolver] Unknown labels option id (id withheld — C1/C3/lex):', {
        field: fieldName,
        valueType: typeof id,
        isArray: Array.isArray(id),
      });
      return null;
    }
    return label;
  }

  /**
   * C3 do parecer do `lex` (`parecer-lex-asindexable.md`) — BLOQUEIO DE ENTRADA DA FASE 2.
   *
   * Até aqui o caminho `labels` só era exercido por `Tipo de Dispositivo` e
   * `Cobertura Verificada`. A task 2.2 faz `Segmentos Clínicos` virar múltiplo, e a partir
   * daí ESTE laço passa a imprimir o uuid da opção de segmento clínico de um paciente — um
   * por item descartado. O uuid é o valor clínico em forma CODIFICADA, e o dicionário que o
   * decodifica (`/list/<id>/field`) é público para quem tem o token: codificar não é proteger
   * (Ley 25.326, art. 7º inc. 3 — registro que revele dado sensível ainda que INDIRETAMENTE).
   * O destino do `console.warn` é o bucket `_Default` global, sem restrição de acesso.
   *
   * Permitido por evento (C1): `{ field, valueType, isArray, length }`. Proibido na mesma
   * linha: o uuid da opção, o orderindex, o rótulo resolvido e o `task.id`.
   *
   * O alarme não perde nada: o operador precisa saber "o campo X descartou N valores nesta
   * rodada", não QUAL segmento. "Qual opção não mapeia" se responde do CATÁLOGO (C2), sem
   * paciente nenhum envolvido.
   *
   * Incondicional de propósito: uma lista "este campo é clínico?" vazaria em silêncio no dia
   * em que um campo clínico novo entrasse — que é exatamente o que a Fase 2 está fazendo.
   */
  resolveLabels(fieldName: string, ids: readonly string[] | null | undefined): string[] {
    // Empty is legitimate: nobody filled the field in ClickUp. Everything below is NOT.
    if (!ids || ids.length === 0) return [];
    const map = this.labels[fieldName];
    if (!map) {
      // Field renamed, removed, or no longer a labels field — every task resolves to [] from here.
      console.warn('[ClickUpFieldResolver] Unknown labels field:', { field: fieldName, requested: ids.length });
      return [];
    }
    const out: string[] = [];
    let dropped = 0;
    for (const id of ids) {
      const label = map[id];
      if (label) {
        out.push(label);
      } else {
        // Per-ITEM discard: the array comes back SHORTER and a short array looks complete.
        // One warning per call would not cover this — it has to be one per dropped id.
        // C3/lex: the id itself is withheld. What goes out is the RUNNING COUNT of discards
        // for this call — a count, which C1 allows explicitly ("o campo X descartou N
        // valores nesta rodada") and which no dictionary decodes back into a segment.
        dropped += 1;
        console.warn('[ClickUpFieldResolver] Unknown labels option id (value dropped; id withheld — C1/C3/lex):', {
          field: fieldName,
          valueType: typeof id,
          isArray: Array.isArray(id),
          droppedSoFar: dropped,
          requested: ids.length,
        });
      }
    }
    if (out.length !== ids.length) {
      console.warn('[ClickUpFieldResolver] labels partially resolved:', { field: fieldName, requested: ids.length, resolved: out.length });
    }
    return out;
  }

  getFieldType(fieldName: string): string | null {
    return this.fieldTypes[fieldName] ?? null;
  }

  /** Names of all drop_down fields (debug/inspection). */
  get dropdownFieldNames(): string[] {
    return Object.keys(this.dropdowns);
  }

  /** Names of all labels fields (debug/inspection). */
  get labelsFieldNames(): string[] {
    return Object.keys(this.labels);
  }

  /** Full dropdown map for a field (debug/inspection). */
  getDropdownOptions(fieldName: string): Readonly<Record<number, string>> {
    return this.dropdowns[fieldName] ?? {};
  }

  /** Full labels map for a field (debug/inspection). */
  getLabelsOptions(fieldName: string): Readonly<Record<string, string>> {
    return this.labels[fieldName] ?? {};
  }
}
