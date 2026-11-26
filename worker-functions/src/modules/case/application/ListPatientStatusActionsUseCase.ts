import { ACAO_NAMES, ACOES, acaoDisponivelDe, exigenciasDe, type Acao, type Exigencia } from '../domain/acoesDeEstado';
import { blockingCodesForStatusChange, type PatientCompletenessCode } from '../domain/PatientCompleteness';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import { ACTIVE_ALLOCATION_BLOCK, type ViaDaTroca } from '../domain/enums/PatientStatusBlock';
import { avaliarTroca, escopoDaTroca } from './PatientStatusWriter';
import type {
  CompletenessReaderPort,
  HorasDoItinerarioPort,
  LiveAllocationPort,
  TransactionRunnerPort,
  TransitionCatalogPort,
} from './ports/patientStatusPorts';

/**
 * ListPatientStatusActionsUseCase — a LISTA de ações humanas que o servidor aceitaria para este paciente e este ator (F3), no molde
 * da lista de destinos da spec 051. NÃO tem regra própria: cada ação passa por `avaliarTroca` (a MESMA função do escritor), pela mesma
 * completude (`blockingCodesForStatusChange`) e pela mesma trava de alocação viva — lista e escrita nunca têm duas implementações.
 * Só ports. Ação que o escritor recusaria por permissão ou por transição NÃO é oferecida ("nem a mais, nem a menos").
 */

export interface PatientStatusActionOption {
  acao: Acao;
  /** Onde a ação vai dar. Para retomar/reativar é o estado RE-DERIVADO pelo itinerário (a tela só o mostra; o cliente não o envia). */
  destino: PatientStatus;
  via: ViaDaTroca;
  /** O que a tela coleta antes de pedir (motivo fechado; nunca texto clínico). */
  exige: readonly Exigencia[];
  /** Por que ESTA ação está bloqueada agora: completude que falta e/ou alocação viva; ausente quando nada bloqueia. */
  blockedBy?: Array<PatientCompletenessCode | typeof ACTIVE_ALLOCATION_BLOCK>;
}

export interface PatientStatusActions {
  current: PatientStatus | null;
  actions: PatientStatusActionOption[];
}

export interface ListPatientStatusActionsPorts {
  transaction: TransactionRunnerPort;
  horas: HorasDoItinerarioPort;
  catalog: TransitionCatalogPort;
  completeness: CompletenessReaderPort;
  allocation: LiveAllocationPort;
  clock?: () => Date;
}

const VIA_DA_AVALIACAO = { dentro_do_fluxo: 'fluxo', fora_do_fluxo_permitida: 'permissao' } as const;

export class ListPatientStatusActionsUseCase {
  constructor(private readonly ports: ListPatientStatusActionsPorts) {}

  execute(input: { patientId: string; cells: readonly string[] | null }): Promise<PatientStatusActions> {
    const now = (this.ports.clock ?? (() => new Date()))();
    return this.ports.transaction.run(async (tx) => {
      const horas = await this.ports.horas.load(tx, input.patientId, now);
      if (!horas) throw new Error(`Patient not found: ${input.patientId}`);
      const current = horas.status as PatientStatus | null;
      const naFsm = new Set(await this.ports.catalog.destinosDe(tx, current));

      const aceitas = ACAO_NAMES.filter((acao) => acaoDisponivelDe(acao, current)).flatMap((acao) => {
        const def = ACOES[acao];
        const destino = def.destino({ horas });
        const avaliacao = avaliarTroca({ from: current, to: destino, naFsm: naFsm.has(destino), cells: input.cells, changeSource: def.origem });
        const via = VIA_DA_AVALIACAO[avaliacao.resultado as keyof typeof VIA_DA_AVALIACAO];
        return via ? [{ acao, destino, via, exige: exigenciasDe(acao, current) }] : [];
      });

      // D489/D530: com alocação viva o escritor recusa TODA troca humana — toda ação sai bloqueada e a completude nem é lida.
      const vivas = await this.ports.allocation.countLive(tx, input.patientId);
      const exigeCompletude = (a: (typeof aceitas)[number]): readonly PatientCompletenessCode[] =>
        blockingCodesForStatusChange(a.destino, current);
      // O escopo vem da tabela de origem da ação (dono único: `escopoDaTroca`, o MESMO do escritor); 1 leitura por escopo distinto.
      const leituras = new Map<string, Promise<PatientCompletenessCode[]>>();
      const missingDe = (acao: Acao): Promise<PatientCompletenessCode[]> => {
        const escopo = escopoDaTroca({ changeSource: ACOES[acao].origem });
        const chave = JSON.stringify(escopo);
        const lida = leituras.get(chave) ?? this.ports.completeness.missingFor(tx, input.patientId, escopo);
        leituras.set(chave, lida);
        return lida;
      };
      const actions: PatientStatusActionOption[] = [];
      for (const a of aceitas) {
        const exigidos = exigeCompletude(a);
        const missing = vivas === 0 && exigidos.length > 0 ? await missingDe(a.acao) : [];
        const blockedBy: PatientStatusActionOption['blockedBy'] = vivas > 0 ? [ACTIVE_ALLOCATION_BLOCK] : exigidos.filter((c) => missing.includes(c));
        actions.push(blockedBy.length > 0 ? { ...a, blockedBy } : a);
      }
      return { current, actions };
    });
  }
}
