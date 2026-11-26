/**
 * Origem de uma mudança de status do paciente (`patient_status_history.change_source`, via
 * `app.change_source`). DONO ÚNICO da política por origem (estado-automatico-do-paciente, design §4):
 * a união, as listas de origem MANUAL/INTERNA, o que a rota HTTP aceita, quem pode tirar o paciente do
 * funil para `SEARCHING` e o escopo em que a completude é medida saem TODOS desta tabela. Nenhum `if`
 * por origem fora daqui — o escritor, o zod da rota e `decidirTrocaForaDoFluxo` leem dela.
 */

/** Onde a completude do destino é medida: o paciente inteiro ou só o serviço contratado clicado (D2). */
export type EscopoDaCompletudeDaOrigem = 'paciente' | 'servico';

export interface PoliticaDeOrigem {
  /** Decisão de uma PESSOA (exige motivo de saída de SUSPENDED, respeita a trava de alocação viva, pode virar `*_override`). */
  readonly humana: boolean;
  /** O zod da rota HTTP aceita esta origem no corpo. */
  readonly aceitaNaRota: boolean;
  /** Pode tirar o paciente do funil de admissão para `SEARCHING` (D469 / D1). */
  readonly saiDoFunilParaSearching: boolean;
  /** Escopo da completude de `SEARCHING`/`ACTIVE`/`REPLACEMENT` para esta origem (D2). */
  readonly escopoDaCompletude: EscopoDaCompletudeDaOrigem;
}

export const POLITICA_POR_ORIGEM = {
  // O foguete mede o SERVIÇO clicado (D2): o gate dele já mediu o mesmo serviço, então a recusa do escritor é inalcançável.
  recruitment_activation: { humana: false, aceitaNaRota: false, saiDoFunilParaSearching: true, escopoDaCompletude: 'servico' },
  system: { humana: false, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' },
  admin_panel: { humana: true, aceitaNaRota: true, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' },
  // F1-F4: o arrasto ainda sai do funil (D469); a F5 tira.
  kanban: { humana: true, aceitaNaRota: true, saiDoFunilParaSearching: true, escopoDaCompletude: 'paciente' },
  // retomar e reativar (F3, E3): decisão de uma PESSOA (motivo de saída de SUSPENDED, trava de alocação viva), mas o servidor a
  // põe — o corpo do PUT nunca a aceita. O destino é re-derivado pelo itinerário, nunca escolhido.
  resume: { humana: true, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' },
  // Origem só de LEITURA da trilha antiga (linhas gravadas pelo gancho do lançamento, que deixou de mover — D1).
  vacancy_launch: { humana: false, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' },
  activate: { humana: false, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' },
} as const satisfies Record<string, PoliticaDeOrigem>;

export type PatientChangeSource = keyof typeof POLITICA_POR_ORIGEM;

type OrigemCom<K extends keyof PoliticaDeOrigem> = {
  [S in PatientChangeSource]: (typeof POLITICA_POR_ORIGEM)[S][K] extends true ? S : never;
}[PatientChangeSource];

export type ManualChangeSource = OrigemCom<'humana'>;
/** Origens que o zod da rota HTTP aceita (a tabela diz quais) — subconjunto das humanas. */
export type OrigemDaRota = OrigemCom<'aceitaNaRota'>;
export type InternalChangeSource = Exclude<PatientChangeSource, ManualChangeSource>;

export const CHANGE_SOURCES = Object.keys(POLITICA_POR_ORIGEM) as PatientChangeSource[];

/** Origens que são decisão de uma PESSOA no painel — as únicas que a rota HTTP aceita (a tabela diz quais). */
export const MANUAL_CHANGE_SOURCES = CHANGE_SOURCES.filter(
  (s) => POLITICA_POR_ORIGEM[s].humana,
) as unknown as readonly [ManualChangeSource, ...ManualChangeSource[]];

/** Origens aceitas no corpo/query da rota HTTP: `aceitaNaRota` na tabela (nunca `resume`, que o servidor põe). */
export const ROTA_CHANGE_SOURCES = CHANGE_SOURCES.filter(
  (s) => POLITICA_POR_ORIGEM[s].aceitaNaRota,
) as unknown as readonly [OrigemDaRota, ...OrigemDaRota[]];

/** Origens internas (use cases, derivação): o zod da rota HTTP NÃO as aceita. */
export const INTERNAL_CHANGE_SOURCES = CHANGE_SOURCES.filter(
  (s) => !POLITICA_POR_ORIGEM[s].humana,
) as unknown as readonly [InternalChangeSource, ...InternalChangeSource[]];

export const isOrigemDaRota = (value: unknown): value is OrigemDaRota =>
  typeof value === 'string' && (ROTA_CHANGE_SOURCES as readonly string[]).includes(value);

export const isManualChangeSource = (value: unknown): value is ManualChangeSource =>
  typeof value === 'string' && (MANUAL_CHANGE_SOURCES as readonly string[]).includes(value);

/** D469/D1: esta origem pode tirar o paciente do funil para `SEARCHING`? Lê a tabela. */
export const saiDoFunilParaSearching = (origem: PatientChangeSource): boolean =>
  POLITICA_POR_ORIGEM[origem].saiDoFunilParaSearching;

/** Escopo da completude desta origem (D2). */
export const escopoDaCompletudeDe = (origem: PatientChangeSource): EscopoDaCompletudeDaOrigem =>
  POLITICA_POR_ORIGEM[origem].escopoDaCompletude;
