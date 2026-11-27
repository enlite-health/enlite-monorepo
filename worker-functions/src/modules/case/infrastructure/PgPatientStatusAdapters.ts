/**
 * Adapters Pg dos ports do escritor de estado (estado-automatico-do-paciente, D7 / design §5). Os do foguete: `PgRecruitmentAdapters.ts`.
 *
 * Tudo que fala com o banco que o escritor (`PatientStatusWriter`) usava
 * por import direto mora AQUI; ele depende só de `ports/patientStatusPorts`. O `StatusTx` que chega é sempre o
 * `PoolClient` da transação aberta por `PgTransactionRunner` (ou o client que o chamador já tinha — a derivação, dentro do
 * escritor do itinerário): o cast para `PoolClient` é só a volta do tipo mínimo ao concreto, no único lugar que o conhece.
 */
import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { loadPatientCompleteness } from './PatientCompletenessLoader';
import { countVivasForPatient } from './VacancyAllocationProbe';
import type { EscopoDaCompletude } from '../domain/PatientCompleteness';
import type { AcaoTalentum } from '../domain/talentumPausaDoPaciente';
import { pacientePausadoSql, vagaPublicavelSql } from '../../matching/domain/vacancyPublication';
import type {
  CompletenessReaderPort,
  LiveAllocationPort,
  PatientStatusPorts,
  StatusTx,
  TalentumPauseMarkerPort,
  TransactionRunnerPort,
} from '../application/ports/patientStatusPorts';

const pg = (tx: StatusTx): PoolClient => tx as unknown as PoolClient;

/** `withActorContext`: abre a transação no client certo (RLS por ator/país), reusando o client da request quando há. */
export class PgTransactionRunner implements TransactionRunnerPort {
  run<T>(fn: (tx: StatusTx) => Promise<T>): Promise<T> {
    return withActorContext(DatabaseConnection.getInstance().getPool(), (client) => fn(client));
  }
}

export class PgCompletenessReader implements CompletenessReaderPort {
  /** `paciente` mede todos os serviços ativos; `servico` mede só o `serviceId` (a leitura filtra `pcs.id`); `servicos_com_vaga_viva` só os com vaga viva. */
  async missingFor(tx: StatusTx, patientId: string, escopo: EscopoDaCompletude) {
    const { missing } = await loadPatientCompleteness(
      pg(tx),
      patientId,
      escopo.kind === 'servico' ? escopo.serviceId : undefined,
      escopo.kind === 'servicos_com_vaga_viva',
    );
    return missing;
  }
}

export class PgLiveAllocation implements LiveAllocationPort {
  countLive(tx: StatusTx, patientId: string): Promise<number> {
    return countVivasForPatient(pg(tx), patientId);
  }
}

/**
 * As vagas do paciente que ERAM publicáveis (a regra do dono SEM a cláusula do paciente) e têm projeto no Talentum. `pause` marca
 * PENDING_PAUSE; `resume` marca PENDING_RESUME as que ESTAVAM pausadas (PAUSED / PENDING_PAUSE / MANUAL_PAUSE da falha da pausa);
 * vaga baixada ou legado ON_HOLD/CLOSED nunca volta (ficam fora de "publicável"). Uma só regra: `vagaPublicavelSql`.
 */
const ESTADO_PARA_MARCAR: Readonly<Record<AcaoTalentum, { novo: string; deQuem: string }>> = {
  // pausa: só quem NÃO está pausado por outro caminho (MANUAL_PAUSE/PAUSED/PENDING_PAUSE ficam como estão)
  pause: { novo: 'PENDING_PAUSE', deQuem: `(jp.talentum_pause_state IS NULL OR jp.talentum_pause_state IN ('PENDING_RESUME', 'MANUAL_RESUME'))` },
  // retomada: PAUSED/PENDING_PAUSE e também MANUAL_PAUSE — numa vaga publicável-sem-paciente (DE_BAJA e legado ON_HOLD/CLOSED ficam fora
  // pelo próprio filtro de publicável), MANUAL_PAUSE só nasce da falha da pausa do paciente; sem isto ela ficava pausada para sempre.
  resume: { novo: 'PENDING_RESUME', deQuem: `jp.talentum_pause_state IN ('PAUSED', 'PENDING_PAUSE', 'MANUAL_PAUSE')` },
};

export class PgTalentumPauseMarker implements TalentumPauseMarkerPort {
  async mark(tx: StatusTx, patientId: string, acao: AcaoTalentum): Promise<string[]> {
    const { novo, deQuem } = ESTADO_PARA_MARCAR[acao];
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE job_postings jp
          SET talentum_pause_state = '${novo}', updated_at = NOW()
        WHERE jp.patient_id = $1
          AND jp.talentum_project_id IS NOT NULL
          AND ${deQuem}
          AND ${vagaPublicavelSql('jp', 'p', { semPaciente: true })}
        RETURNING jp.id`,
      [patientId],
    );
    return rows.map((r) => r.id);
  }

  /**
   * I1: a vaga que ACABA de ser lançada (dentro da transação do publish, com `talentum_project_id` já gravado) com o paciente já
   * pausado nasce PENDING_PAUSE — senão o projeto ficava ativo no Talentum enquanto o feed já a escondia. Mesmo marcador, mesma
   * regra (`vagaPublicavelSql` sem a cláusula do paciente + a tabela do dono `PACIENTE_QUE_PAUSA_A_VAGA`), escopo de UMA vaga.
   */
  async markVacancyIfPatientPaused(tx: StatusTx, vacancyId: string): Promise<string[]> {
    const { novo, deQuem } = ESTADO_PARA_MARCAR.pause;
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE job_postings jp
          SET talentum_pause_state = '${novo}', updated_at = NOW()
         FROM patients p
        WHERE jp.id = $1
          AND p.id = jp.patient_id
          AND ${pacientePausadoSql('p')}
          AND jp.talentum_project_id IS NOT NULL
          AND ${deQuem}
          AND ${vagaPublicavelSql('jp', 'p', { semPaciente: true })}
        RETURNING jp.id`,
      [vacancyId],
    );
    return rows.map((r) => r.id);
  }
}

export const buildPgPatientStatusPorts = (): PatientStatusPorts => ({
  transaction: new PgTransactionRunner(),
  completeness: new PgCompletenessReader(),
  allocation: new PgLiveAllocation(),
  talentum: new PgTalentumPauseMarker(),
});
