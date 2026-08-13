/**
 * backfill-talentum-audio-published.ts
 *
 * Ticket 86ajfm80t (parte "PASSADO — projetos AO VIVO na Talentum").
 *
 * Habilita ÁUDIO nas perguntas dos projetos de pré-screening já publicados na
 * Talentum, IN-PLACE (PUT /pre-screening/projects/:id) — SEM recriar, preservando
 * projectId/whatsappUrl/slug (provado contra a Talentum real: PUT → 204, links
 * intactos). Complementa o backfill do banco (migration 249): o banco já está
 * {text,audio}; este script reflete isso nos projetos ao vivo.
 *
 * Idempotente: só toca projeto com ≥1 pergunta sem 'audio'. Preserva perguntas,
 * texto, pesos e flags — apenas garante 'audio' no responseType de cada pergunta.
 *
 * Uso:
 *   # DRY-RUN (padrão — só lista o que mudaria, não escreve):
 *   GCP_PROJECT_ID=enlite-prd ts-node -r tsconfig-paths/register scripts/backfill-talentum-audio-published.ts
 *   # EXECUTAR de verdade:
 *   GCP_PROJECT_ID=enlite-prd ts-node -r tsconfig-paths/register scripts/backfill-talentum-audio-published.ts --execute
 */

import { TalentumApiClient } from '../src/modules/integration/infrastructure/TalentumApiClient';
import type { TalentumProject } from '../src/modules/integration/domain/ITalentumApiClient';
import { normalizePrescreeningResponseType } from '../src/shared/utils/normalizePrescreeningResponseType';

function questionsNeedAudio(project: TalentumProject): boolean {
  return (project.questions ?? []).some((q) => !(q.responseType ?? []).includes('audio'));
}

async function main() {
  const execute = process.argv.includes('--execute');
  process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'enlite-prd';
  const client = await TalentumApiClient.create();

  const all = await client.listAllPrescreenings();
  const needFix = all.filter(questionsNeedAudio);

  console.log(`\n${execute ? '🟢 EXECUTAR' : '🔵 DRY-RUN'} — projetos totais=${all.length} | precisam de áudio=${needFix.length}\n`);
  for (const p of needFix) {
    const before = (p.questions ?? []).map((q) => JSON.stringify(q.responseType)).join(',');
    console.log(`  ${p.projectId}  "${p.title}"  q=${(p.questions ?? []).length}  rt=[${before}]`);
  }
  if (needFix.length === 0) {
    console.log('\nNada a fazer — todos os projetos já aceitam áudio. ✅');
    return;
  }
  if (!execute) {
    console.log(`\n(DRY-RUN) ${needFix.length} projeto(s) seriam atualizados via PUT. Rode com --execute para aplicar.`);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const p of needFix) {
    try {
      // Relê o projeto (fonte de verdade fresca) e só habilita áudio, preservando tudo.
      const project = await client.getPrescreening(p.projectId);
      await client.updatePrescreening(p.projectId, {
        title: project.title,
        description: project.description,
        faq: project.faq ?? [],
        questions: (project.questions ?? []).map((q) => ({
          ...q,
          responseType: normalizePrescreeningResponseType(q.responseType, { forceAudio: true }),
        })),
      });
      // Verifica in-place: relê e confirma áudio em todas.
      const after = await client.getPrescreening(p.projectId);
      const audioOk = (after.questions ?? []).every((q) => (q.responseType ?? []).includes('audio'));
      const linkOk = after.whatsappUrl === project.whatsappUrl && after.slug === project.slug;
      if (audioOk && linkOk) {
        ok++;
        console.log(`  ✅ ${p.projectId} "${p.title}" — áudio habilitado, link preservado`);
      } else {
        fail++;
        console.log(`  ⚠️  ${p.projectId} "${p.title}" — audioOk=${audioOk} linkOk=${linkOk} (verificar)`);
      }
    } catch (err) {
      fail++;
      console.log(`  ❌ ${p.projectId} "${p.title}" — ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log(`\nResultado: ${ok} OK, ${fail} falha(s) de ${needFix.length}.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n[ERRO]', e);
  process.exit(1);
});
