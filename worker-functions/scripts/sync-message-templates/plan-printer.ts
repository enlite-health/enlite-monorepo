/**
 * Impressão formatada do plano de sync.
 */
import { HARDCODED_SLUGS } from './constants';
import { DeletePlan, SyncPlan } from './diff-engine';

export function printPlan(plan: SyncPlan): void {
  const line = '══════════════════════════════════════════════════════════════';
  console.log(`\n${line}\nPLANO DE SINCRONIZAÇÃO\n${line}\n`);

  printInserts(plan);
  printUpdates(plan);
  printDeletes(plan);

  const hardcodedDeletes = plan.deletes.filter(d => HARDCODED_SLUGS.has(d.slug));
  if (hardcodedDeletes.length > 0) printHardcodedWarning(hardcodedDeletes, line);
}

function printInserts(plan: SyncPlan): void {
  console.log(`INSERTS (${plan.inserts.length}):`);
  for (const ins of plan.inserts) {
    const preview = ins.body.slice(0, 100).replace(/\n/g, ' ');
    const ellipsis = ins.body.length > 100 ? '…' : '';
    console.log(`  + ${ins.slug}  [content_sid=${ins.contentSid}, category=${ins.category ?? 'null'}]`);
    console.log(`    body: ${preview}${ellipsis}`);
  }
  if (plan.inserts.length > 0) {
    console.log(`    ⚠ Body cru da Twilio usa {{1}}, {{2}} (numérico). Ajuste manual pode ser`);
    console.log(`      necessário pra casar com variáveis enviadas pelo frontend.\n`);
  } else {
    console.log('  (nenhum)\n');
  }
}

function printUpdates(plan: SyncPlan): void {
  console.log(`UPDATES (${plan.updates.length}):`);
  for (const upd of plan.updates) {
    const fieldStr = Object.entries(upd.fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    console.log(`  ~ ${upd.slug}  [${fieldStr || 'sem field updates'}]`);
    if (upd.bodyDiverges) {
      console.log(`    ⚠ body diverge — NÃO será sobrescrito (manter banco pra preservar`);
      console.log(`      placeholders nomeados). body_twilio recebe o texto da Twilio.`);
    }
  }
  if (plan.updates.length === 0) console.log('  (nenhum)');
  console.log();
}

function printDeletes(plan: SyncPlan): void {
  console.log(`DELETES (${plan.deletes.length}):`);
  for (const del of plan.deletes) {
    const isHardcoded = HARDCODED_SLUGS.has(del.slug);
    const flag = isHardcoded ? ' ⚠ HARDCODED EM CÓDIGO' : '';
    console.log(`  - ${del.slug}${flag}`);
    console.log(`    motivo: ${del.reason}`);
  }
  if (plan.deletes.length === 0) console.log('  (nenhum)');
  console.log();
}

function printHardcodedWarning(hardcoded: DeletePlan[], line: string): void {
  console.log(line);
  console.log(`⚠  ${hardcoded.length} SLUG(S) HARDCODED EM CÓDIGO no plano de DELETE:`);
  for (const d of hardcoded) console.log(`     - ${d.slug}`);
  console.log('   Deletar vai quebrar use cases que dependem desses slugs.');
  console.log('   Opções:');
  console.log('     1. Aprovar template equivalente na Twilio (mesmo friendly_name) e re-rodar.');
  console.log('     2. Remover o slug do código antes de deletar.');
  console.log('     3. Passar --allow-hardcoded-delete pra forçar (NÃO recomendado).');
  console.log(`${line}\n`);
}
