/**
 * Gera a migration 560 (sinônimos CID-10 F00-F99) a partir das duas fontes oficiais.
 *
 *   curl -L -o mapping.zip https://icdcdn.who.int/static/releasefiles/2025-01/mapping.zip && unzip mapping.zip
 *   curl -L -o Volume1.pdf https://ais.paho.org/classifications/Chapters/pdf/Volume1.pdf && pdftotext -layout Volume1.pdf v1.txt
 *   npx ts-node scripts/gen-cie10-synonyms-migration.ts 10To11MapToOneCategory.txt v1.txt migrations/560_terminology_icd_synonyms_cie10_saude_mental.sql
 */
import { readFileSync, writeFileSync } from 'fs';
import { buildCie10Seeds, parseCie10Map, parseOpsTitles, renderCie10Migration } from './icd11-ingest/cie10-synonyms';

const [mapPath, opsPath, outPath] = process.argv.slice(2);
if (!mapPath || !opsPath || !outPath) {
  console.error('uso: gen-cie10-synonyms-migration.ts <10To11MapToOneCategory.txt> <texto OPS (pdftotext -layout)> <saida.sql>');
  process.exit(1);
}
const mappings = parseCie10Map(readFileSync(mapPath, 'utf8'));
const titles = parseOpsTitles(readFileSync(opsPath, 'utf8'));
const semTitulo = mappings.filter((m) => !titles.has(m.code10)).map((m) => m.code10);
const seeds = buildCie10Seeds(mappings, titles);
writeFileSync(outPath, renderCie10Migration(seeds));
console.log(`${mappings.length} códigos F, ${titles.size} títulos OPS, ${seeds.length} linhas na carga; sem título OPS: ${semTitulo.length ? semTitulo.join(' ') : '(nenhum)'}`);
