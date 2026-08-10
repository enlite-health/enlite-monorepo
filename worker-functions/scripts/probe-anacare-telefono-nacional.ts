/**
 * Sonda READ-ONLY: o que o espelho MANDARIA no campo `telefono` do Ana Care,
 * depois do conserto, para os workers que hoje estão presos sem ana_care_id.
 *
 * Não escreve nada, não chama a API do Ana Care, e não imprime PII —
 * só comprimentos, prefixos e contagens agregadas.
 *
 * Uso: DATABASE_URL=... npx ts-node scripts/probe-anacare-telefono-nacional.ts
 */
import { Pool } from 'pg';
import { toNationalAR } from '../src/shared/utils/phoneNormalization';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ phone: string | null }>(`
      SELECT phone
        FROM workers
       WHERE status = 'REGISTERED'
         AND ana_care_id IS NULL
         AND deleted_at IS NULL
         AND NOT COALESCE(is_test, false)
    `);

    const antes = new Map<string, number>();
    const depois = new Map<string, number>();
    let mudaram = 0;
    let vazios = 0;

    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const shape = (d: string) => (d ? `${d.length} dig / inicia ${d.slice(0, 3)}` : '(vazio)');

    for (const { phone } of rows) {
      const cru = (phone ?? '').replace(/\D/g, '');
      const nac = toNationalAR(phone);
      if (!cru) { vazios++; continue; }
      bump(antes, shape(cru));
      bump(depois, shape(nac));
      if (cru !== nac) mudaram++;
    }

    const dump = (t: string, m: Map<string, number>) => {
      console.log(`\n=== ${t} ===`);
      [...m.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`  ${k.padEnd(26)} ${String(v).padStart(4)}`));
    };

    console.log(`workers presos analisados: ${rows.length} (sem telefone: ${vazios})`);
    dump('HOJE — o que seria enviado sem o conserto', antes);
    dump('DEPOIS — o que passa a ser enviado', depois);
    console.log(`\nmudam de forma: ${mudaram} de ${rows.length - vazios}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
