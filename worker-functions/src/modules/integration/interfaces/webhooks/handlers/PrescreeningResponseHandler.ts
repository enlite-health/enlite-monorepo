import { Response } from 'express';
import { Pool } from 'pg';
import { redactContact } from '@shared/logging';
import { TalentumWebhookHandler, TalentumWebhookContext } from './TalentumWebhookHandler';
import { TalentumPrescreeningResponseParsed } from '../validators/talentumPrescreeningSchema';
import { TalentumPrescreeningRepository, ProcessTalentumPrescreening } from '@modules/matching';
import type { IJobPostingLookup } from '@modules/matching';
import { WorkerRepository } from '@modules/worker';
import { PubSubClient } from '@shared/events/PubSubClient';

const TAG = '[TalentumWebhook:PrescreeningResponse]';

class JobPostingLookup implements IJobPostingLookup {
  constructor(private readonly pool: Pool) {}

  async findByTitleILike(name: string): Promise<{ id: string } | null> {
    const result = await this.pool.query(
      `SELECT id FROM job_postings WHERE title ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
      [`%${name}%`],
    );
    return result.rows[0] ?? null;
  }
}

export class PrescreeningResponseHandler implements TalentumWebhookHandler<TalentumPrescreeningResponseParsed> {
  constructor(private readonly pool: Pool) {}

  async handle(payload: TalentumPrescreeningResponseParsed, ctx: TalentumWebhookContext, res: Response): Promise<void> {
    const { profile, prescreening, response } = payload.data;
    const extId = prescreening.id;

    // PII (achado do gate, 2ª rodada): mesmo caminho de request do achado de 608/7d
    // em ProcessTalentumPrescreening — e-mail mascarado; profile.id já é o id estável.
    console.log(
      `${TAG} INCOMING | extId=${extId} | subtype=${payload.subtype}` +
      ` | profile=${profile.id} | email=${redactContact(profile.email, 'email')}` +
      ` | statusLabel=${response.statusLabel ?? 'none'} | score=${response.score ?? 'none'}` +
      ` | env=${ctx.environment}`,
    );

    try {
      const useCase = new ProcessTalentumPrescreening(
        new TalentumPrescreeningRepository(),
        new WorkerRepository(),
        new JobPostingLookup(this.pool),
        this.pool,
        new PubSubClient(),
      );

      const result = await useCase.execute(payload, { environment: ctx.environment, dryRun: false });

      console.log(
        `${TAG} DONE | prescreeningId=${result.prescreeningId}` +
        ` | workerId=${result.workerId ?? 'null'} | jobPostingId=${result.jobPostingId ?? 'null'}` +
        ` | resolved: worker=${result.resolved.worker}, jobPosting=${result.resolved.jobPosting}`,
      );
      res.status(200).json(result);
    } catch (err) {
      console.error(`${TAG} ERROR | extId=${extId} |`, (err as Error)?.message ?? err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
