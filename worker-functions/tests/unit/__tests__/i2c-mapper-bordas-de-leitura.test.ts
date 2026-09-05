/**
 * I2/I4 — as BORDAS de `ClickUpPatientMapper` que o piso de cobertura exige (100/100/100/100).
 *
 * Este arquivo não repete o que as suítes de comportamento já provam; ele exercita os ramos
 * que só aparecem quando a origem manda uma forma torta — e que, justamente por não terem
 * teste, foram onde os defeitos I2 e I4 moraram. Cada `it` diz QUAL ramo cobre e por que ele
 * importa em produção.
 *
 * ⚠️ Nada aqui é dado real: nomes, endereços e rótulos são sintéticos, prefixo `I2C`.
 */
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';

const CAMPOS_LABELS = new Set(['Cobertura Verificada', 'Tipo de Dispositivo']);

/**
 * O catálogo declara TODO campo com um tipo que o leitor entende (o preflight da 1.11 passa),
 * mas NENHUMA opção resolve. É a "opção renomeada/recriada no ClickUp": `readable:false` com
 * `reason='options_unresolved'` — o estado que não pode virar "vazio".
 */
function resolverSemOpcoes(): ClickUpFieldResolver {
  return {
    getFieldType: (f: string) => (CAMPOS_LABELS.has(f) ? 'labels' : 'drop_down'),
    resolveDropdown: () => null,
    resolveLabel:   () => null,
    resolveLabels:  () => [],
    dropdownFieldNames: [], labelsFieldNames: [],
    getDropdownOptions: () => ({}), getLabelsOptions: () => ({}),
  } as unknown as ClickUpFieldResolver;
}

function tarefa(nome: string, campos: Array<{ name: string; value: unknown }>): ClickUpTask {
  return {
    id: 'task-i2c-bordas',
    name: nome,
    parent: null,
    status: { status: 'admisión' },
    custom_fields: campos.map((c, i) => ({ id: `cf-${i}`, name: c.name, value: c.value })),
  } as unknown as ClickUpTask;
}

let mapper: ClickUpPatientMapper;

beforeAll(() => { mapper = new ClickUpPatientMapper(resolverSemOpcoes()); });
beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('I2 — leitura ILEGÍVEL propaga `*Readable: false` em TODOS os campos de catálogo', () => {
  it('as 6 bandeiras saem `false` e os derivados saem `null` (nada será escrito por cima)', () => {
    const out = mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',    value: 'I2C' },
      { name: 'Apellido del Paciente', value: 'QA' },
      // Toda opção referenciada existe na tarefa e NENHUMA resolve no catálogo.
      { name: 'Dependencia',                          value: 7 },
      { name: 'Sexo Asignado al Nacer (Uso Clínico)', value: 7 },
      { name: 'Tipo de Documento Paciente',           value: 7 },
      { name: 'Servicio',                             value: 7 },
      { name: 'Segmentos Clínicos',                   value: 7 },
      { name: 'Cobertura Verificada',                 value: ['uuid-desconhecido'] },
      { name: 'Tipo de Dispositivo',                  value: ['uuid-desconhecido'] },
    ]))!;

    expect(out).toMatchObject({
      dependencyLevel: null,   dependencyLevelReadable: false,
      sex: null,               sexReadable: false,
      documentType: null,      documentTypeReadable: false,
      serviceType: null,       serviceTypeReadable: false,
      clinicalSpecialty: null, clinicalSpecialtyReadable: false,
      insuranceVerified: null, insuranceVerifiedReadable: false,
    });
    // As listas viram RECUSA, nunca lista vazia — lista vazia apagaria a tabela.
    expect(out.insuranceVerifiedLabels).toMatchObject({ readable: false });
    expect(out.deviceTypeLabels).toMatchObject({ readable: false });
  });
});

describe('bordas de identidade e endereço', () => {
  it('só o SOBRENOME veio: `firstName` cai no fallback vazio e o paciente ainda é mapeado', () => {
    const out = mapper.map(tarefa('', [{ name: 'Apellido del Paciente', value: 'SóSobrenome I2C' }]))!;
    expect(out.firstName).toBe('');
    expect(out.lastName).toBe('SóSobrenome I2C');
  });

  it('só o sobrenome do RESPONSÁVEL: mesma borda, no bloco do responsável', () => {
    const out = mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',       value: 'I2C' },
      { name: 'Apellido del Paciente',    value: 'QA' },
      { name: 'Apellido del Responsable', value: 'ResponsávelI2C' },
    ]))!;
    expect(out.responsibles![0]).toMatchObject({ firstName: '', lastName: 'ResponsávelI2C' });
  });

  it('campo de TEXTO que vem como número é descartado — nunca vira string fabricada', () => {
    // A API do ClickUp já devolveu número onde se esperava texto. `asString` só aceita string:
    // o resto vira `null`, e `null` aqui é "não veio", não "veio o número 12345678".
    const out = mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',            value: 'I2C' },
      { name: 'Apellido del Paciente',         value: 'QA' },
      { name: 'Número de Documento Paciente',  value: 12345678 },
      { name: 'Comentarios Adicionales Paciente', value: true },
    ]))!;
    expect(out.documentNumber).toBeNull();
    expect(out.additionalComments).toBeNull();
  });

  it('título VAZIO e sem nome em custom field → a tarefa não vira paciente (nunca lança)', () => {
    expect(mapper.map(tarefa('', []))).toBeNull();
  });

  it('endereço só com o texto informado (sem objeto de localização) → `addressFormatted` ausente', () => {
    const out = mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',    value: 'I2C' },
      { name: 'Apellido del Paciente', value: 'QA' },
      { name: 'Domicilio Informado Paciente 1', value: 'RUA SINTETICA I2C 123' },
    ]))!;
    expect(out.addresses).toHaveLength(1);
    expect(out.addresses![0].addressFormatted).toBeUndefined();
    expect(out.addresses![0].addressRaw).toBe('RUA SINTETICA I2C 123');
  });

  it('`formatted_address` que não é string é DESCARTADO (nunca vira endereço fabricado)', () => {
    const out = mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',    value: 'I2C' },
      { name: 'Apellido del Paciente', value: 'QA' },
      { name: 'Domicilio 1 Principal Paciente', value: { formatted_address: 12345, lat: -34.6, lng: -58.4 } },
      { name: 'Domicilio Informado Paciente 1', value: 'RUA SINTETICA I2C 456' },
    ]))!;
    expect(out.addresses![0].addressFormatted).toBeUndefined();
  });
});

describe('`Fecha de Nacimiento` — toda forma que NÃO vira data devolve null, nunca uma data inventada', () => {
  const nascimento = (value: unknown): Date | null | undefined =>
    mapper.map(tarefa('QA, I2C', [
      { name: 'Nombre de Paciente',    value: 'I2C' },
      { name: 'Apellido del Paciente', value: 'QA' },
      { name: 'Fecha de Nacimiento',   value },
    ]))!.birthDate;

  it('epoch em ms VÁLIDO (o formato de produção) → Date', () => {
    expect(nascimento('828086400000')).toEqual(new Date(828086400000));
  });

  it('número NaN → null (o `isNaN` do ramo numérico)', () => {
    expect(nascimento(NaN)).toBeNull();
  });

  it('string de dígitos FORA do alcance de Date → null (o `isNaN` do ramo epoch-string)', () => {
    expect(nascimento('99999999999999999999')).toBeNull();
  });

  it('string que não é data → null (o `isNaN` do ramo ISO)', () => {
    expect(nascimento('NAO-E-DATA-I2C')).toBeNull();
  });

  it('booleano (forma que a API já devolveu onde se esperava data) → null', () => {
    expect(nascimento(true)).toBeNull();
  });
});
