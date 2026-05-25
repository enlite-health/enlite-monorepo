#!/usr/bin/env node

/**
 * Wave 1 — Diagnóstico de Schema (sem mudança de código)
 *
 * Executa as 3 queries diagnósticas do roadmap:
 *   C1:   pg_constraint — verifica FK de worker_job_applications.worker_id
 *   C2-D: auditoria whatsapp_phone vs phone em workers
 *   N8-C: amostragem de blacklist.reason para PII clínico
 *
 * Uso:
 *   DATABASE_URL=postgresql://... node scripts/wave1-diagnostic.js
 */

const { Client } = require("pg");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e";

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const findings = {};

  // ─────────────────────────────────────────────────
  // C1 — FK de worker_job_applications.worker_id
  // ─────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  C1 — FK diagnóstico: worker_job_applications");
  console.log("══════════════════════════════════════════════\n");

  const c1Query = `
    SELECT conname,
           conrelid::regclass  AS tabela,
           confrelid::regclass AS referencia_para,
           pg_get_constraintdef(oid) AS definicao
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'worker_job_applications'::regclass;
  `;

  const c1Result = await client.query(c1Query);
  console.log("Foreign keys encontradas:");
  for (const row of c1Result.rows) {
    console.log(`  ${row.conname}: ${row.tabela} → ${row.referencia_para}`);
    console.log(`    Definição: ${row.definicao}`);
  }

  const workerFk = c1Result.rows.find(
    (r) => r.definicao.includes("workers") && r.definicao.includes("worker_id")
  );

  if (workerFk) {
    console.log("\n✅ C1 RESULTADO: FK de worker_id aponta para workers — banco íntegro.");
    console.log("   O problema reportado foi artefato do export do DBeaver.");
    findings.C1 = "FK_VALIDA";
  } else {
    console.log("\n❌ C1 RESULTADO: FK de worker_id NÃO aponta para workers — REQUER CORREÇÃO!");
    findings.C1 = "FK_QUEBRADA";
  }

  // Teste extra: tentar INSERT com worker_id inexistente
  console.log("\n  Teste de integridade: INSERT com worker_id inexistente...");
  try {
    // F7.c (ADR-004): application_status removido — apenas testa FK de worker_id
    await client.query(`
      INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
      VALUES ('00000000-0000-0000-0000-000000000000',
              (SELECT id FROM job_postings LIMIT 1),
              'INVITED', 'system')
    `);
    console.log("  ⚠️  INSERT com worker_id inexistente foi ACEITO — FK não está funcionando!");
    findings.C1_INSERT_TEST = "FAIL";
  } catch (err) {
    if (err.code === "23503") {
      console.log("  ✅ INSERT rejeitado com ForeignKeyViolation — FK funcional.");
      findings.C1_INSERT_TEST = "PASS";
    } else {
      console.log(`  ⚠️  Erro inesperado: ${err.message}`);
      findings.C1_INSERT_TEST = "ERROR";
    }
  }

  // ─────────────────────────────────────────────────
  // C2-D — Auditoria whatsapp_phone vs phone
  // ─────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  C2-D — Auditoria: whatsapp_phone vs phone");
  console.log("══════════════════════════════════════════════\n");

  const c2dQuery = `
    SELECT
      COUNT(*) AS total_workers,
      COUNT(*) FILTER (WHERE whatsapp_phone IS NOT NULL) AS com_whatsapp,
      COUNT(*) FILTER (WHERE whatsapp_phone IS NOT NULL AND phone = whatsapp_phone) AS identicos,
      COUNT(*) FILTER (WHERE whatsapp_phone IS NOT NULL AND phone != whatsapp_phone) AS diferentes,
      COUNT(*) FILTER (WHERE whatsapp_phone IS NOT NULL AND phone IS NULL) AS so_whatsapp
    FROM workers;
  `;

  const c2dResult = await client.query(c2dQuery);
  const stats = c2dResult.rows[0];

  console.log("Estatísticas:");
  console.log(`  Total de workers:         ${stats.total_workers}`);
  console.log(`  Com whatsapp_phone:       ${stats.com_whatsapp}`);
  console.log(`  phone = whatsapp_phone:   ${stats.identicos}`);
  console.log(`  phone ≠ whatsapp_phone:   ${stats.diferentes}`);
  console.log(`  Só whatsapp (sem phone):  ${stats.so_whatsapp}`);

  const pctIdenticos =
    Number(stats.com_whatsapp) > 0
      ? ((Number(stats.identicos) / Number(stats.com_whatsapp)) * 100).toFixed(1)
      : "N/A";

  console.log(`\n  Taxa de identidade: ${pctIdenticos}%`);

  if (Number(stats.com_whatsapp) === 0) {
    console.log("\n⚠️  C2-D RESULTADO: Nenhum worker com whatsapp_phone preenchido — sem dados para decisão.");
    findings.C2D = "SEM_DADOS";
  } else if (Number(pctIdenticos) > 90) {
    console.log("\n📋 C2-D RESULTADO: >90% idênticos — RECOMENDAÇÃO: merge (dropar whatsapp_phone, usar phone).");
    findings.C2D = "MERGE";
  } else {
    console.log("\n📋 C2-D RESULTADO: Diferença significativa — RECOMENDAÇÃO: encrypt (manter campo separado, criptografar).");
    findings.C2D = "ENCRYPT";
  }

  // Listar workers com valores diferentes para análise manual
  if (Number(stats.diferentes) > 0) {
    const diffQuery = `
      SELECT id, phone, whatsapp_phone
      FROM workers
      WHERE whatsapp_phone IS NOT NULL AND phone != whatsapp_phone
      LIMIT 10;
    `;
    const diffResult = await client.query(diffQuery);
    console.log("\n  Workers com phone ≠ whatsapp_phone:");
    for (const row of diffResult.rows) {
      console.log(`    ID: ${row.id.substring(0, 8)}… | phone: ${row.phone} | whatsapp: ${row.whatsapp_phone}`);
    }
  }

  findings.C2D_STATS = stats;

  // ─────────────────────────────────────────────────
  // N8-C — Amostragem de blacklist.reason para PII
  // ─────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  N8-C — Amostragem: blacklist.reason e detail");
  console.log("══════════════════════════════════════════════\n");

  const n8cQuery = `
    SELECT reason, detail FROM blacklist
    WHERE reason ILIKE '%paciente%'
       OR reason ILIKE '%atendimiento%'
       OR reason ILIKE '%atendimento%'
       OR reason ILIKE '%familiar%'
       OR reason ILIKE '%crisis%'
       OR detail ILIKE '%paciente%'
       OR detail ILIKE '%familiar%'
    LIMIT 20;
  `;

  const n8cResult = await client.query(n8cQuery);

  console.log(`Registros com possível PII clínico: ${n8cResult.rows.length}`);
  for (const row of n8cResult.rows) {
    console.log(`  reason: "${row.reason}"`);
    if (row.detail) {
      console.log(`  detail: "${row.detail}"`);
    }
    console.log("  ---");
  }

  // Contagem total
  const totalQuery = `SELECT COUNT(*) AS total FROM blacklist;`;
  const totalResult = await client.query(totalQuery);
  const totalBlacklist = totalResult.rows[0].total;

  console.log(`\nTotal de registros na blacklist: ${totalBlacklist}`);
  console.log(`Registros com PII potencial:     ${n8cResult.rows.length}`);

  if (n8cResult.rows.length > 0) {
    console.log("\n🔴 N8-C RESULTADO: PII clínico CONFIRMADO — reclassificar para CRÍTICO.");
    console.log("   Campos reason e detail contêm referências a pacientes, familiares e atendimentos.");
    console.log("   AÇÃO NECESSÁRIA: criptografar reason e detail (ver roadmap N8-C passos 2-7).");
    findings.N8C = "PII_CONFIRMADO";
  } else {
    console.log("\n✅ N8-C RESULTADO: Nenhum PII clínico encontrado na amostra.");
    console.log("   Documentar em DECISIONS.md: tabela auditada, classificada como não-PII clínico.");
    findings.N8C = "SEM_PII";
  }

  // ─────────────────────────────────────────────────
  // Resumo
  // ─────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  RESUMO — Wave 1 Diagnóstico");
  console.log("══════════════════════════════════════════════\n");

  console.log(`  C1   (FK worker_job_applications): ${findings.C1}`);
  console.log(`  C1   (INSERT test):                ${findings.C1_INSERT_TEST}`);
  console.log(`  C2-D (whatsapp_phone vs phone):    ${findings.C2D}`);
  console.log(`  N8-C (blacklist PII):              ${findings.N8C}`);

  console.log("\n══════════════════════════════════════════════\n");

  // Saída em JSON para uso programático
  const output = JSON.stringify(findings, null, 2);
  console.log("JSON findings:");
  console.log(output);

  await client.end();

  // Exit code: 0 se tudo ok, 1 se há FK quebrada
  process.exit(findings.C1 === "FK_QUEBRADA" ? 1 : 0);
}

run().catch((err) => {
  console.error("Erro ao executar diagnóstico:", err);
  process.exit(2);
});
