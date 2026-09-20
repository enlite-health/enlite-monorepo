/**
 * Contrato de CONTEÚDO do payload de `GET /analytics/dashboard/management`
 * (PR-9, `lex` #9, L9-1, FR-733): só números e rótulos de enum. O teste
 * percorre o JSON INTEIRO e reprova:
 *   - qualquer string que não esteja na lista de enums conhecidos do payload
 *     (código de país, 'ALL', coluna do Kanban, recorte fixo);
 *   - qualquer UUID (regex v4-ish, mas também pega os ids sintéticos usados
 *     em teste — o formato com hifens em 4 grupos de 4/8/4/4/12);
 *   - qualquer chave `name|firstName|lastName|email|phone` (drill-down de pessoa);
 *   - qualquer chave terminada em `Ids`/`ids` (lista de ids = drill-down).
 *
 * Sabotagem que derruba este teste: acrescentar `patientIds: [...]` (ou
 * qualquer id/nome) ao payload — ver o teste "acusa sabotagem" no fim.
 */
import { managementDashboardSchema, type ManagementDashboardData } from '../managementDashboardSchema';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const FUNNEL_COLUMNS = [
  'INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS',
  'COMPLETED', 'CONFIRMED', 'SELECTED', 'REJECTED',
] as const;

const FUNNEL_LEGADO_KEYS = [
  'invitados', 'bloqueados', 'preScreening', 'completos', 'agendados', 'seleccionados', 'rechazados',
] as const;

/** Vocabulário FECHADO de valores de string que o payload tem permissão de carregar. */
const ALLOWED_STRING_VALUES = new Set<string>([
  'AR', 'BR', 'ALL',
  'vagas-vivas',
  ...FUNNEL_COLUMNS,
]);

const FORBIDDEN_KEY_RE = /^(name|firstName|lastName|email|phone)$/i;
const DRILLDOWN_KEY_RE = /ids$/i;

interface Violation {
  path: string;
  reason: string;
}

/** Anda o objeto inteiro (chaves e valores) e junta toda violação achada. */
function walk(value: unknown, path: string, violations: Violation[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    if (UUID_RE.test(value)) {
      violations.push({ path, reason: `UUID no payload: "${value}"` });
      return;
    }
    if (!ALLOWED_STRING_VALUES.has(value)) {
      violations.push({ path, reason: `string fora do vocabulário fechado de enum: "${value}"` });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, violations));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(key)) {
        violations.push({ path: `${path}.${key}`, reason: `chave de dado pessoal proibida: "${key}"` });
        continue;
      }
      if (DRILLDOWN_KEY_RE.test(key)) {
        violations.push({ path: `${path}.${key}`, reason: `chave de drill-down (lista de ids) proibida: "${key}"` });
        continue;
      }
      walk(v, `${path}.${key}`, violations);
    }
  }
}

/** Um payload completo e válido, no molde do que `GetManagementDashboardUseCase` produz. */
function fullValidPayload(): ManagementDashboardData {
  const columns = Object.fromEntries(FUNNEL_COLUMNS.map((c) => [c, 3])) as Record<
    (typeof FUNNEL_COLUMNS)[number],
    number
  >;
  return managementDashboardSchema.parse({
    scope: { countries: ['AR', 'BR'], requested: 'ALL' },
    bigNumbers: {
      equiposArmados: 1,
      equiposPorArmar: 2,
      pacientesActivos: 193,
      vacantesAbiertas: 5,
      vacantesPausadas: 1,
    },
    equipoArmada: {
      armados: 1,
      porArmar: 2,
      semConfig: 1,
      pendenteClasificacao: 1,
      pctRespostaRapidaArmado: { num: 1, den: 2, excluidos: 2, pct: 50 },
    },
    pacientes: {
      activos: 193,
      ubicacionesActivas: 339,
      solicitudes: 2,
      entrevistaAgendada: 1,
      enAdmision: 5,
      enBusca: 112,
      sobrepoe: true,
    },
    horas: {
      totais: 10,
      aPreencher: 6,
      ativas: 4,
      ativasConSchedule: 1,
      ativasSinSchedule: 1,
      coberturaConSchedule: 2,
      coberturaSinSchedule: 2,
    },
    prioridades: {
      completosEsperandoAgendamiento: 569,
      registrosIncompletos: 6632,
      bloqueadosAlPostularse: 405,
    },
    funnelPorPrestador: {
      total: 2,
      recorte: 'vagas-vivas',
      periodoDias: 30,
      bloqueados: 405,
      porEtapa: { somavel: false, colunas: columns },
      consolidado: { somavel: true, colunas: columns },
    },
    funnel: Object.fromEntries(FUNNEL_LEGADO_KEYS.map((k) => [k, 3])),
    encuadres: {
      agendadosEstaSemana: 8,
      semDataRegistrada: 0,
      pctCapacidadeSemana: { agendados: 8, capacidade: 30, pct: 26.7 },
    },
    cadastros: {
      leads: 6882,
      completos: 250,
      alocados: 10,
      alocadosActivos: 7,
      alocadosCubriendoGuardias: 3,
      incompletos: 6632,
      nuevosCompletosMes: 14,
    },
  });
}

describe('contrato de conteúdo — GET /analytics/dashboard/management (L9-1, FR-733)', () => {
  it('o payload real (todos os blocos) não carrega string livre, UUID nem chave de drill-down', () => {
    const violations: Violation[] = [];
    walk(fullValidPayload(), 'data', violations);
    expect(violations).toEqual([]);
  });

  it('acusa sabotagem: um `patientIds` (lista de ids) no payload é reprovado', () => {
    const sabotaged = { ...fullValidPayload(), patientIds: ['a', 'b', 'c'] };
    const violations: Violation[] = [];
    walk(sabotaged, 'data', violations);
    expect(violations).toEqual([{ path: 'data.patientIds', reason: expect.stringContaining('drill-down') }]);
  });

  it('acusa sabotagem: um UUID solto em qualquer campo é reprovado', () => {
    const sabotaged = { ...fullValidPayload(), debugCaseId: '11111111-2222-4333-8444-555555555555' };
    const violations: Violation[] = [];
    walk(sabotaged, 'data', violations);
    expect(violations.some((v) => v.reason.includes('UUID'))).toBe(true);
  });

  it('acusa sabotagem: uma chave `phone`/`name`/`email` em qualquer profundidade é reprovada', () => {
    const sabotaged = {
      ...fullValidPayload(),
      pacientes: { ...fullValidPayload().pacientes, contactPreview: { name: 'Fulano', phone: '+54911...' } },
    };
    const violations: Violation[] = [];
    walk(sabotaged, 'data', violations);
    const reasons = violations.map((v) => v.reason).join(' | ');
    expect(reasons).toContain('name');
    expect(reasons).toContain('phone');
  });

  it('acusa sabotagem: uma string fora do vocabulário fechado (ex.: um nome de zona solto) é reprovada', () => {
    const sabotaged = { ...fullValidPayload(), zonaDestaque: 'Palermo' };
    const violations: Violation[] = [];
    walk(sabotaged, 'data', violations);
    expect(violations).toEqual([
      { path: 'data.zonaDestaque', reason: expect.stringContaining('fora do vocabulário') },
    ]);
  });

  it('`scope.countries` nunca inclui Portugal nem qualquer código fora de AR|BR (FR-734)', () => {
    const payload = fullValidPayload();
    for (const c of payload.scope.countries) {
      expect(['AR', 'BR']).toContain(c);
    }
  });
});
