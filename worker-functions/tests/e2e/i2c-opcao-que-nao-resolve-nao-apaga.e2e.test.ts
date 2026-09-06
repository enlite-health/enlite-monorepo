/**
 * i2c-opcao-que-nao-resolve-nao-apaga.e2e.test.ts @integration — defeito I2.
 *
 * ── O DEFEITO, medido ───────────────────────────────────────────────────────
 * Quatro campos do `ClickUpPatientMapper` liam `resolver.resolveDropdown` CRU:
 *   `Dependencia`, `Sexo Asignado al Nacer (Uso Clínico)`, `Tipo de Documento Paciente` e
 *   `Servicio`.
 * Uma falha de OPÇÃO — o orderindex que a origem mandou e que o catálogo não traduz mais,
 * exatamente o caso que `ClickUpFieldResolver`/`resolveCatalogValue` existem para separar —
 * devolvia `null`, e o `null` era gravado como APAGAMENTO:
 *   `PatientClinicalRepository` fazia `push('dependency_level', null)` sem condição;
 *   `PatientIdentityRepository` fazia `sex = EXCLUDED.sex` / `document_type = EXCLUDED.document_type`
 *   sem pular coluna; `service_type` idem, pelo mesmo `push` incondicional.
 * Exposição medida (cabeçalho de `dropdownCatalogGuard.ts`): 348 linhas de `dependency_level`,
 * 185 de `sex`, 349 de `service_type`.
 *
 * A solução JÁ EXISTE neste PR — a flag `*Readable`, aplicada a `clinical_specialty` e a
 * `insurance_verified`. Este teste exige a MESMA distinção nos 4 irmãos.
 *
 * ⚠️ NÃO é COALESCE (D-E): "vazio de verdade" continua APAGANDO. O 3º teste é essa metade —
 * sem ela o conserto trocaria apagamento por congelamento, que é pior porque não aparece.
 *
 * Em processo contra o Postgres de e2e (o container `enlite-api` roda imagem anterior).
 */
import { Pool } from 'pg';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { PatientService } from '../../src/modules/case/application/PatientService';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TAG     = 'I2C-apaga-%';
const TASK_ID = 'I2C-apaga-4-campos';

/** Os 4 campos e a opção LEGÍTIMA de cada um, no orderindex 1. */
const OPCOES_VIVAS: Record<string, Record<number, string>> = {
  'Dependencia':                          { 1: 'MUY GRAVE',  2: 'LEVE' },
  'Sexo Asignado al Nacer (Uso Clínico)': { 1: 'Femenino',   2: 'Masculino' },
  'Tipo de Documento Paciente':           { 1: 'DNI',        2: 'Passaporte' },
  'Servicio':                             { 1: 'Cuidador (a)', 2: 'Acompañante Terapéutico' },
};

type Colunas = {
  dependency_level: string | null;
  sex: string | null;
  document_type: string | null;
  service_type: string[] | null;
};

/**
 * `catalogoVivo=false` = o catálogo AINDA declara os 4 campos como `drop_down` (o preflight da
 * 1.11 passa), mas NENHUMA das opções resolve: é a "opção renomeada/recriada no ClickUp",
 * `reason='options_unresolved'`. É o caso que o refresher de catálogo NÃO salva.
 */
function resolverCom(catalogoVivo: boolean): ClickUpFieldResolver {
  const mapa = catalogoVivo ? OPCOES_VIVAS : {};
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      return (mapa as Record<string, Record<number, string>>)[f]?.[Number(v)] ?? null;
    },
    resolveLabel: () => null,
    resolveLabels: () => [],
    dropdownFieldNames: Object.keys(mapa),
    labelsFieldNames: [],
    getDropdownOptions: (f: string) => (mapa as Record<string, Record<number, string>>)[f] ?? {},
    getLabelsOptions: () => ({}),
  } as unknown as ClickUpFieldResolver;
}

/** `orderindex=null` significa: o campo NÃO vem na tarefa — vazio LEGÍTIMO. */
function tarefa(orderindex: number | null): ClickUpTask {
  const custom_fields: Array<{ id: string; name: string; value: unknown }> = [
    { id: 'cf-fn', name: 'Nombre de Paciente',    value: 'ApagaI2C' },
    { id: 'cf-ln', name: 'Apellido del Paciente', value: 'Quatro QA' },
    { id: 'cf-wa', name: 'Número de WhatsApp Paciente', value: '+5491199887766' },
  ];
  if (orderindex !== null) {
    for (const nome of Object.keys(OPCOES_VIVAS)) {
      custom_fields.push({ id: `cf-${nome}`, name: nome, value: orderindex });
    }
  }
  return {
    id: TASK_ID,
    name: 'Quatro QA, ApagaI2C',
    parent: null,
    status: { status: 'admisión' },
    custom_fields,
  } as unknown as ClickUpTask;
}

async function sincroniza(catalogoVivo: boolean, orderindex: number | null): Promise<void> {
  const mapper = new ClickUpPatientMapper(resolverCom(catalogoVivo));
  const input  = mapper.map(tarefa(orderindex));
  expect(input).not.toBeNull();
  await new PatientService().upsertFromClickUp(input!, { onMissingContact: 'flag' });
}

describe('I2 — opção que NÃO resolve não apaga a coluna, nos 4 campos @integration', () => {
  let pool: Pool;

  const colunas = async (): Promise<Colunas> =>
    (await pool.query<Colunas>(
      'SELECT dependency_level, sex, document_type, service_type FROM patients WHERE clickup_task_id = $1',
      [TASK_ID],
    )).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
    // 1ª sincronização com o catálogo VIVO: os 4 campos ficam preenchidos.
    await sincroniza(true, 1);
    expect(await colunas()).toEqual({
      dependency_level: 'VERY_SEVERE',
      sex:              'FEMALE',
      document_type:    'DNI',
      service_type:     ['CAREGIVER'],
    });
  });

  it('A OPÇÃO DEIXA DE RESOLVER → NENHUMA das 4 colunas é tocada (D167/F41)', async () => {
    await sincroniza(false, 1);

    expect(await colunas()).toEqual({
      dependency_level: 'VERY_SEVERE',
      sex:              'FEMALE',
      document_type:    'DNI',
      service_type:     ['CAREGIVER'],
    });
  });

  it('CONTROLE POSITIVO — opção LEGÍTIMA diferente continua GRAVANDO nas 4 (a régua mede)', async () => {
    await sincroniza(true, 2);

    expect(await colunas()).toEqual({
      dependency_level: 'MILD',
      sex:              'MALE',
      document_type:    'PASSPORT',
      service_type:     ['AT'],
    });
  });

  it('VAZIO DE VERDADE continua APAGANDO — o conserto não é COALESCE (D-E)', async () => {
    await sincroniza(true, null);

    expect(await colunas()).toEqual({
      dependency_level: null,
      sex:              null,
      document_type:    null,
      service_type:     null,
    });
  });
});
