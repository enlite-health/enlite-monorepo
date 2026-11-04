/**
 * dispatchTalentumPause — UM só ponto de "tentar pausar/retomar no Talentum depois do commit" (spec 084 F4/R13).
 *
 * O estado `PENDING_PAUSE` / `PENDING_RESUME` já foi gravado NA MESMA transação da baixa/volta (BajaVacanciesUseCase e o
 * gatilho do serviço). Por isso, se este trabalho pós-resposta for descartado (Cloud Run sem CPU depois da resposta), a vaga
 * continua PENDING e aparece na lista manual — nunca fica NULL calada. Esta função só TENTA; o resultado final
 * (PAUSED / MANUAL_*) quem grava é o VacancyTalentumPauseService.
 */
import { withSystemDbContext } from '@shared/database/requestDbSession';
import { reportError } from '@shared/logging';
import type { VacancyBajaSideEffects } from './VacancyTalentumPauseService';

export function dispatchTalentumPause(
  side: VacancyBajaSideEffects,
  ids: { pause?: readonly string[]; resume?: readonly string[] },
  source: string,
): void {
  const pause = ids.pause ?? [];
  const resume = ids.resume ?? [];
  if (pause.length === 0 && resume.length === 0) return;
  setImmediate(() => {
    void withSystemDbContext('job:vacancy-talentum-pause', async () => {
      try {
        if (pause.length > 0) await side.pause(pause);
        if (resume.length > 0) await side.resume(resume);
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)), { source: `${source}:talentum` });
      }
    });
  });
}
