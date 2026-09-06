/**
 * I4 — `Equipo Tratante Multidisciplinario` é `drop_down`, e `is_team` tem de sair da OPÇÃO.
 *
 * ── O DEFEITO ───────────────────────────────────────────────────────────────
 * O mapper lia o campo como checkbox:
 *     `parseClickUpBoolean(v) || asString(v) === 'Sí'`
 * O campo, porém, é `drop_down` — declarado assim em `PATIENT_CATALOG_FIELDS` (linhas 96-100
 * do mapper) e confirmado pela foto do catálogo VIVO
 * (`tests/fixtures/clickup/catalogo-pacientes-fase0.ts:42`). O valor de um `drop_down` na API
 * do ClickUp é um ORDERINDEX (number): `parseClickUpBoolean` devolve `false` para `number` e
 * `asString` devolve `null` para não-string. Logo `is_team` era decidido pelo ACIDENTE DE
 * SERIALIZAÇÃO do payload, nunca pela opção que a operação escolheu.
 *
 * ── Por que os 2 testes que existiam não pegavam ────────────────────────────
 * Eles passavam `value: false` e `value: 'true'` — NENHUM dos dois é payload válido de
 * `drop_down`. O `expect(isTeam).toBe(true)` de `clickup-1.12-nomes-de-campo.test.ts` passava
 * por causa do ramo `asString(...) === 'true'`... que nem existe no ClickUp. Teste verde sobre
 * uma forma que não existe em produção (D154/D155: régua de FORMA não mede substância).
 *
 * Este arquivo mede a forma REAL: orderindex → rótulo → decisão.
 */
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import {
  CATALOGO_PACIENTES_FASE0,
  type ClickUpCatalogField,
} from '../../fixtures/clickup/catalogo-pacientes-fase0';

const CAMPO = 'Equipo Tratante Multidisciplinario';
/** As opções vivas do campo (mesma dupla usada por `clickup-2.3-mapper-alimenta-o-cru.test.ts`). */
const OPCOES_DO_EQUIPO: Record<number, string> = { 0: 'No', 1: 'Sí' };

/**
 * Resolver REAL (a classe de produção), alimentado com a FOTO do catálogo vivo — assim o tipo
 * de cada campo vem da medição, não de um dublê que responde `'drop_down'` para tudo.
 */
async function resolverDoCatalogoVivo(): Promise<ClickUpFieldResolver> {
  const resposta = {
    fields: CATALOGO_PACIENTES_FASE0.map((f: ClickUpCatalogField, i: number) => ({
      id: `cf-${i}`,
      name: f.name,
      type: f.type,
      type_config:
        f.name === CAMPO
          ? { options: Object.entries(OPCOES_DO_EQUIPO).map(([oi, nome]) => ({ id: `op-eq-${oi}`, name: nome, orderindex: Number(oi) })) }
          : f.type === 'drop_down' || f.type === 'labels'
            ? { options: [{ id: `op-${i}`, name: `OPCAO-SINTETICA-${i}`, orderindex: 1 }] }
            : {},
    })),
  };
  const fetchFalso = (async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => resposta })) as unknown as typeof fetch;
  return ClickUpFieldResolver.fromList('lista-sintetica', { token: 'token-sintetico', fetchImpl: fetchFalso });
}

function tarefa(valorDoEquipo: unknown): ClickUpTask {
  return {
    id: 'task-i2c-i4',
    name: 'QA I2C, Equipo',
    parent: null,
    status: { status: 'admisión' },
    custom_fields: [
      { id: 'cf-fn', name: 'Nombre de Paciente',    value: 'EquipoI2C' },
      { id: 'cf-ln', name: 'Apellido del Paciente', value: 'QA' },
      { id: 'cf-pr', name: 'Profesional Tratante Principal', value: 'Prof Sintetico' },
      { id: 'cf-eq', name: CAMPO,                   value: valorDoEquipo },
    ],
  } as unknown as ClickUpTask;
}

describe('I4 — `is_team` vem da OPÇÃO do drop_down, não da serialização', () => {
  let mapper: ClickUpPatientMapper;

  beforeAll(async () => {
    mapper = new ClickUpPatientMapper(await resolverDoCatalogoVivo());
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => jest.restoreAllMocks());

  it('CONTROLE DE AMBIENTE: o catálogo vivo declara o campo como `drop_down` (não checkbox)', () => {
    const declarado = CATALOGO_PACIENTES_FASE0.find(f => f.name === CAMPO);
    expect(declarado).toEqual({ name: CAMPO, type: 'drop_down' });
  });

  it('orderindex da opção "Sí" (payload REAL de drop_down) → isTeam = true', () => {
    const out = mapper.map(tarefa(1))!;
    expect(out.professionals![0].isTeam).toBe(true);
  });

  it('orderindex da opção "No" → isTeam = false', () => {
    const out = mapper.map(tarefa(0))!;
    expect(out.professionals![0].isTeam).toBe(false);
  });

  it('orderindex como STRING (a API também manda assim) → isTeam = true', () => {
    const out = mapper.map(tarefa('1'))!;
    expect(out.professionals![0].isTeam).toBe(true);
  });

  it('campo VAZIO (ninguém escolheu) → isTeam = false', () => {
    const out = mapper.map(tarefa(null))!;
    expect(out.professionals![0].isTeam).toBe(false);
  });

  it('as formas dos testes ANTIGOS (`false`, `"true"`) não são payload de drop_down → isTeam = false', () => {
    expect(mapper.map(tarefa(false))!.professionals![0].isTeam).toBe(false);
    expect(mapper.map(tarefa('true'))!.professionals![0].isTeam).toBe(false);
  });

  it('só o profissional do slot 1 carrega a bandeira (contrato preservado)', () => {
    const t = tarefa(1);
    (t.custom_fields as Array<{ id: string; name: string; value: unknown }>).push(
      { id: 'cf-pr2', name: 'Profesional Tratante 2', value: 'Prof Sintetico 2' },
    );
    const out = mapper.map(t)!;
    expect(out.professionals!.map(p => p.isTeam)).toEqual([true, false]);
  });
});
