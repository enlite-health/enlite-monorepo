import { dispatchTalentumPause } from '../../../matching/application/dispatchTalentumPause';
import { VacancyTalentumPauseService } from '../../../matching/application/VacancyTalentumPauseService';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientStatusMoved } from '../../application/PatientStatusWriter';

/**
 * P6 (semaforo-da-vaga F4): envia ao Talentum a pausa/retomada que a transição do paciente MARCOU (PENDING_PAUSE/PENDING_RESUME,
 * gravados na transação do escritor). Chamado pelos controllers DEPOIS do commit; nunca lança, e se o trabalho pós-resposta se
 * perder a vaga segue PENDING na lista manual. `null` = a transição não cruza o conjunto que pausa.
 */
export function dispatchPatientTalentumPause(talentum: PatientStatusMoved['talentum'], source: string): void {
  if (!talentum) return;
  const pool = DatabaseConnection.getInstance().getPool();
  dispatchTalentumPause(new VacancyTalentumPauseService(pool), { [talentum.acao]: talentum.vacancyIds }, source);
}
