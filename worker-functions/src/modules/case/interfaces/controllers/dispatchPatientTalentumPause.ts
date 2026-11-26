import { dispatchTalentumPause } from '../../../matching/application/dispatchTalentumPause';
import { VacancyTalentumPauseService } from '../../../matching/application/VacancyTalentumPauseService';
import { tryEnsureShortLinksOfPatient } from '../../../matching/application/vacancyShortLinks';
import { withSystemDbContext } from '@shared/database/requestDbSession';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientStatusMoved } from '../../application/PatientStatusWriter';

/**
 * P6 (semaforo-da-vaga F4): envia ao Talentum a pausa/retomada que a transição do paciente MARCOU (PENDING_PAUSE/PENDING_RESUME,
 * gravados na transação do escritor). Chamado pelos controllers DEPOIS do commit; nunca lança, e se o trabalho pós-resposta se
 * perder a vaga segue PENDING na lista manual. `null` = a transição não cruza o conjunto que pausa.
 *
 * Retomada (`resume`): a vaga lançada com o paciente pausado não ganhou short link (publicável era falso) e o feed exige
 * `social_short_links ? 'site'`. Ela também NÃO está entre os ids marcados (nunca esteve PAUSED), então o ensure do publish
 * (`tryEnsureShortLink`, nunca rejeita) roda pelas vagas do PACIENTE que viraram publicáveis e não têm link — um ponto só, mesma regra.
 */
export function dispatchPatientTalentumPause(talentum: PatientStatusMoved['talentum'], source: string, patientId: string): void {
  if (!talentum) return;
  const pool = DatabaseConnection.getInstance().getPool();
  dispatchTalentumPause(new VacancyTalentumPauseService(pool), { [talentum.acao]: talentum.vacancyIds }, source);
  if (talentum.acao !== 'resume') return;
  setImmediate(() => {
    void withSystemDbContext('job:patient-resume-shortlink', () => tryEnsureShortLinksOfPatient(pool, patientId));
  });
}
