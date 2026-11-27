import { ACOES, acaoDisponivelDe, type Acao } from '../domain/acoesDeEstado';
import type { OnHoldReason } from '../domain/enums/OnHoldReason';
import type { SuspensionExitReason } from '../domain/enums/SuspensionExitReason';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import type { MovePatientStatus, PatientStatusMoved } from './PatientStatusWriter';
import type { HorasDoItinerarioPort, TransactionRunnerPort } from './ports/patientStatusPorts';

/**
 * PatientStatusActionUseCase — aplica UMA ação humana sobre o estado do paciente (estado-automatico-do-paciente, F3, D5/D9).
 *
 * Só ports (fronteira provada em `casePortsAndAdapters.test.ts`): a transação, as horas do itinerário e o escritor de estado vêm de
 * fora. O destino sai da TABELA (`ACOES`): pausar/suspender/dar_alta/dar_baja têm destino fixo e origem `admin_panel`; retomar e
 * reativar usam `resolverRetomada` e a origem `resume` — o cliente NUNCA escolhe o destino, e a trilha NÃO é consultada. Tudo no mesmo
 * escritor (`movePatientStatus`) e na MESMA transação: FSM, célula do destino fora do fluxo, trava de alocação viva (D489/D530),
 * motivo de ON_HOLD e de saída de SUSPENDED, completude e trilha valem como na troca de hoje.
 */

/** A ação não existe para o estado atual (retomar fora de ON_HOLD/SUSPENDED, reativar fora de DISCHARGED, …) — o controller devolve 422. */
export class PatientStatusActionNotAvailableError extends Error {
  readonly code = 'PATIENT_STATUS_ACTION_NOT_AVAILABLE';
  constructor(readonly acao: Acao, readonly from: PatientStatus | null) {
    super(`Patient status action ${acao} is not available from ${from ?? 'null'}`);
    this.name = 'PatientStatusActionNotAvailableError';
  }
}

export interface PatientStatusActionInput {
  patientId: string;
  acao: Acao;
  /** Só `pausar` o exige (o escritor recusa sem ele). */
  onHoldReason?: OnHoldReason | null;
  /** Texto clínico restrito: só `pausar` o escreve; nunca logado. */
  onHoldNote?: string | null;
  /** Obrigatório ao sair de SUSPENDED (o escritor recusa sem ele). */
  suspensionExitReason?: SuspensionExitReason | null;
  actorUid?: string | null;
  /** Células do ator (`null` = engine neutro, nunca `?? []`). */
  cells?: readonly string[] | null;
}

export interface PatientStatusActionResult {
  id: string;
  acao: Acao;
  from: PatientStatus | null;
  status: PatientStatus;
  /** P6: vagas marcadas PENDING_PAUSE/PENDING_RESUME na transação; o controller envia ao Talentum DEPOIS do commit. */
  talentum: PatientStatusMoved['talentum'];
}

export interface PatientStatusActionPorts {
  transaction: TransactionRunnerPort;
  horas: HorasDoItinerarioPort;
  moveStatus: MovePatientStatus;
  clock?: () => Date;
}

export class PatientStatusActionUseCase {
  constructor(private readonly ports: PatientStatusActionPorts) {}

  execute(input: PatientStatusActionInput): Promise<PatientStatusActionResult> {
    const now = (this.ports.clock ?? (() => new Date()))();
    return this.ports.transaction.run(async (tx) => {
      const horas = await this.ports.horas.load(tx, input.patientId, now);
      if (!horas) throw new Error(`Patient not found: ${input.patientId}`);
      const from = horas.status as PatientStatus | null;
      if (!acaoDisponivelDe(input.acao, from)) throw new PatientStatusActionNotAvailableError(input.acao, from);

      const def = ACOES[input.acao];
      const moved = await this.ports.moveStatus(
        input.patientId,
        def.destino({ horas }),
        {
          changeSource: def.origem,
          onHoldReason: input.onHoldReason,
          onHoldNote: input.onHoldNote,
          suspensionExitReason: input.suspensionExitReason,
          actorUid: input.actorUid,
          cells: input.cells,
        },
        tx,
      );
      return { id: moved.id, acao: input.acao, from, status: moved.status, talentum: moved.talentum };
    });
  }
}
