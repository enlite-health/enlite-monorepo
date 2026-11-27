import type { Pool } from 'pg';
import { withSystemDbContext } from '@shared/database/requestDbSession';
import type { VacancyPublishedPort } from '@modules/integration/ports/VacancyPublishedPort';
import { PgTalentumPauseMarker } from '../../../case/infrastructure/PgPatientStatusAdapters';
import { dispatchTalentumPause } from '../../application/dispatchTalentumPause';
import { VacancyTalentumPauseService } from '../../application/VacancyTalentumPauseService';
import { tryEnsureShortLink } from '../../application/vacancyShortLinks';

/**
 * Implementação da porta do publish (semaforo-da-vaga F4): a marcação de pausa na transação usa o MESMO marcador do escritor de estado
 * do paciente (`PgTalentumPauseMarker`); depois do commit sai a pausa dos ids marcados (`dispatchTalentumPause`, o mesmo envio do
 * escritor) e nasce o short link do feed (que só existe se a vaga é publicável — vaga de paciente pausado não ganha link agora).
 */
export function buildVacancyPublishedPort(db: Pool): VacancyPublishedPort {
  const marker = new PgTalentumPauseMarker();
  return {
    markPauseInTx: (tx, vacancyId) => marker.markVacancyIfPatientPaused(tx, vacancyId),
    onPublished: async (vacancyId, pausedVacancyIds) => {
      dispatchTalentumPause(new VacancyTalentumPauseService(db), { pause: pausedVacancyIds }, 'PublishVacancyToTalentum');
      // O link do feed nasce quando a vaga vira publicável (depois do commit); escopo de sistema, como os pós-commit da vaga.
      await withSystemDbContext('job:vacancy-publish-shortlink', () => tryEnsureShortLink(db, vacancyId));
    },
  };
}
