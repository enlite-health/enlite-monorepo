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

    // In test mode, if the ClickUp API call fails (e.g. fake token), return an
    // empty resolver instead of throwing. This allows the webhook route to mount
    // in E2E test stacks without a real ClickUp token. All dropdown fields will
    // resolve to null (acceptable — text-only fields still work).
    const isTestMode = process.env.NODE_ENV === 'test';

    const doFetch = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${CLICKUP_API_BASE}/list/${listId}/field`, {
        headers: { Authorization: token },
      });
    } catch (err) {
      if (isTestMode) {
        console.warn('[ClickUpFieldResolver] API unreachable in test mode — using empty resolver:', err);
        return new ClickUpFieldResolver({}, {}, {});
      }
      throw err;
    }
    if (!res.ok) {
      if (isTestMode) {
        console.warn(`[ClickUpFieldResolver] API returned HTTP ${res.status} in test mode — using empty resolver`);
        return new ClickUpFieldResolver({}, {}, {});
      }
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
    if (value === null || value === undefined || value === '') return null;
    const map = this.dropdowns[fieldName];
    if (!map) return null;
    const key = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(key)) return null;
    return map[key] ?? null;
  }

  resolveLabel(fieldName: string, id: string | null | undefined): string | null {
    if (!id) return null;
    const map = this.labels[fieldName];
    if (!map) return null;
    return map[id] ?? null;
  }

  resolveLabels(fieldName: string, ids: readonly string[] | null | undefined): string[] {
    if (!ids || ids.length === 0) return [];
    const map = this.labels[fieldName];
    if (!map) return [];
    const out: string[] = [];
    for (const id of ids) {
      const label = map[id];
      if (label) out.push(label);
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
