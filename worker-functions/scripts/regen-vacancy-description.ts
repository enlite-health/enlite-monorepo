/**
 * regen-vacancy-description.ts
 *
 * Re-generates the Talentum description for a single vacancy using the current
 * code's mapper + formatZoneForPrompt deduplication.
 *
 * Default: PREVIEW only (no DB write).
 * With --persist: calls generateDescription (UPDATEs talentum_description).
 *
 * Auth: usa Vertex AI via ADC (sem API key). Localmente rode antes:
 *   gcloud auth application-default login   (conta com roles/aiplatform.user)
 *
 * Usage:
 *   DATABASE_URL=... \
 *     npx ts-node -r tsconfig-paths/register scripts/regen-vacancy-description.ts <vacancy_id> [--persist]
 */

import { TalentumDescriptionService } from '../src/modules/integration/infrastructure/TalentumDescriptionService';

(async () => {
  const vacancyId = process.argv[2];
  const persist = process.argv.includes('--persist');
  if (!vacancyId) {
    console.error('Usage: regen-vacancy-description.ts <vacancy_id> [--persist]');
    process.exit(1);
  }

  const svc = new TalentumDescriptionService();
  const result = persist
    ? await svc.generateDescription(vacancyId)
    : await svc.generateDescriptionPreview(vacancyId);

  console.log('───────── TITLE ─────────');
  console.log(result.title);
  console.log('───────── DESCRIPTION ─────────');
  console.log(result.description);
  console.log('───────── END ─────────');
  console.log(persist ? '✅ Persisted to talentum_description' : '(preview only — not persisted)');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
