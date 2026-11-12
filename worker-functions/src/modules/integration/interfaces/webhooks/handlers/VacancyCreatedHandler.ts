import { Response } from 'express';
import { Pool } from 'pg';
import { TalentumWebhookHandler, TalentumWebhookContext } from './TalentumWebhookHandler';
import { TalentumPrescreeningCreatedParsed } from '../validators/talentumPrescreeningSchema';
import { CreateJobPostingFromTalentumUseCase, talentumPrescreeningIdResolver } from '../../../application/CreateJobPostingFromTalentumUseCase';

const TAG = '[TalentumWebhook:VacancyCreated]';

export class VacancyCreatedHandler implements TalentumWebhookHandler<TalentumPrescreeningCreatedParsed> {
  constructor(private readonly pool: Pool) {}

  async handle(payload: TalentumPrescreeningCreatedParsed, ctx: TalentumWebhookContext, res: Response): Promise<void> {
    const { _id, name } = payload.data;
    console.log(`${TAG} talentum_project_id=${_id} | name="${name}" | env=${ctx.environment}`);

    try {
      const useCase = new CreateJobPostingFromTalentumUseCase(this.pool, talentumPrescreeningIdResolver);
      const result = await useCase.execute(payload.data, ctx.environment);

      /* istanbul ignore next — ?? branches are cosmetic logging fallbacks */
      console.log(`${TAG} result: created=${result.created} | skipped=${result.skipped} | jobPostingId=${result.jobPostingId ?? 'none'} | reason=${result.reason ?? 'ok'}`);
      res.status(200).json({ received: true, event: 'PRESCREENING.CREATED', ...result });
    } catch (err) {
      // istanbul ignore next — ?? fallback only for non-Error values
      console.error(`${TAG} ERROR:`, (err as Error)?.message ?? err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
