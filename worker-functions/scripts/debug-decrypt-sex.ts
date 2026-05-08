/**
 * Debug — descriptografa sex_encrypted dos AT REGISTERED próximos da vaga 760-554
 * pra confirmar a hipótese: o filtro sex='M' está zerando o pool porque todos
 * os AT na região são F.
 */
import { DatabaseConnection } from '../src/shared/database/DatabaseConnection';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';

const VACANCY = {
  lat: -34.5062324,
  lng: -58.5049847,
  radiusKm: 30,
};

async function main(): Promise<void> {
  const pool = DatabaseConnection.getInstance().getPool();
  const kms = new KMSEncryptionService();

  // Sample de TODOS os workers REGISTERED (qualquer profissão) pra ver os
  // valores únicos de sexo no banco
  const r = await pool.query(
    `SELECT w.id, w.occupation, w.sex_encrypted
     FROM workers w
     WHERE w.merged_into_id IS NULL
       AND w.status = 'REGISTERED'
       AND w.deleted_at IS NULL
       AND w.sex_encrypted IS NOT NULL
     LIMIT 50`,
  );

  console.log(`AT REGISTERED dentro de ${VACANCY.radiusKm}km de Olivos: ${r.rows.length}\n`);
  console.log(`worker_id                            | sex   | dist`);
  console.log(`-------------------------------------|-------|------`);

  let maleCount = 0;
  let femaleCount = 0;
  let unknownCount = 0;

  for (const row of r.rows) {
    let sex = '?';
    if (row.sex_encrypted) {
      try {
        sex = (await kms.decrypt(row.sex_encrypted)) ?? '?';
      } catch (e) {
        sex = `ERR:${(e as Error).message.slice(0, 20)}`;
      }
    }
    if (sex === 'M') maleCount++;
    else if (sex === 'F') femaleCount++;
    else unknownCount++;
    console.log(`${row.id} | ${sex.padEnd(5)} | ${row.dist_km}km`);
  }

  console.log(`\nResumo: M=${maleCount} F=${femaleCount} ?=${unknownCount}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
