/**
 * load-transit-stops.ts — carrega as PARADAS de transporte público em
 * `transit_stops`, o insumo do corredor logístico do /admin/mapa.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/load-transit-stops.ts            # dry-run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/load-transit-stops.ts --apply
 *   ... --file ./paradas.csv     # usa um arquivo local em vez de baixar
 *
 * Dry-run é o DEFAULT: sem `--apply` NADA é escrito, só se conta e se imprime.
 *
 * ⚠️ ESTE SCRIPT NÃO LÊ NEM ESCREVE DADO DE PESSOA. A tabela alvo é
 * infraestrutura pública, sem titular — é essa ausência que mantém o cálculo do
 * corredor dentro do nosso perímetro (parecer lex 05/09/2026). Se um dia ele
 * precisar juntar parada com worker/patient, o parecer cai junto: pare e
 * reabra.
 *
 * FONTE: "Colectivos: paradas" do GCBA (CC-BY-2.5-AR), medida em 05/09/2026 com
 * `Last-Modified: 28/10/2024` e 6.962 linhas. Escolhida porque é o dado de
 * transporte mais FRESCO que existe aberto para a região: o GTFS oficial está
 * suspenso e o que ainda se baixa é conteúdo morto (o `calendar.txt` do feed de
 * trens expira em 30/04/2020; o do subte, em 31/12/2021). Como não há grade de
 * horários, a tela promete CORREDOR ("que linha serve os dois pontos, a quantas
 * quadras"), nunca horário de partida.
 *
 * 🔒 COBERTURA: só CABA. Prestador ou paciente fora dela cai em `sem_cobertura`
 * na tela — recusa explícita, nunca um palpite. Acrescentar o conurbano é
 * acrescentar um `feed_id` novo aqui, sem tocar no resto.
 *
 * Idempotente: a carga é POR FEED (`DELETE` do feed + `INSERT`), dentro de uma
 * transação. Recarregar não duplica, e trocar a fonte de colectivos não derruba
 * as estações de trem que vierem de outro feed.
 */
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { parseGcbaStops } from '../src/modules/matching/infrastructure/gcbaStopsParser';

const GCBA_STOPS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/colectivos-paradas/paradas-de-colectivo.csv';
/** Carimba a data do dado, não a do download — é o que diz se a base envelheceu. */
const FEED_ID = 'gcba-colectivos-2024-10-28';
const COUNTRY = 'AR';
const MODE = 'bus';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileArg = args.indexOf('--file');
const localFile = fileArg !== -1 ? args[fileArg + 1] : undefined;

async function fetchCsv(): Promise<string> {
  if (localFile) return readFileSync(localFile, 'utf-8');
  const res = await fetch(GCBA_STOPS_URL);
  if (!res.ok) throw new Error(`GET paradas-de-colectivo.csv respondeu ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error('DATABASE_URL não definida');

  console.log(`[load-transit-stops] mode=${apply ? 'APPLY' : 'DRY RUN'} feed=${FEED_ID}`);
  console.log(`[load-transit-stops] fonte=${localFile ?? GCBA_STOPS_URL}`);

  const { stops, skipped } = parseGcbaStops(await fetchCsv());
  const linhas = new Set(stops.flatMap((s) => s.lines));
  console.log(`[load-transit-stops] paradas lidas: ${stops.length}`);
  console.log(`[load-transit-stops] linhas distintas: ${linhas.size}`);
  console.log(
    `[load-transit-stops] descartadas: semCoordenada=${skipped.semCoordenada} ` +
    `foraDeFaixa=${skipped.foraDeFaixa} semLinha=${skipped.semLinha} semId=${skipped.semId}`,
  );

  // Contagem zero é falha, nunca sucesso: significa tanto "a fonte mudou de
  // formato" quanto "nada para fazer", e as duas exigem olhar antes de escrever.
  if (stops.length === 0) throw new Error('ZERO paradas lidas — a fonte mudou de formato? Não escrevo nada.');

  if (!apply) {
    console.log('[load-transit-stops] DRY RUN — nada gravado. Use --apply para escrever.');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: apagadas } = await client.query('DELETE FROM transit_stops WHERE feed_id = $1', [FEED_ID]);
    for (const s of stops) {
      await client.query(
        `INSERT INTO transit_stops (feed_id, country, external_id, name, latitude, longitude, mode, lines)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [FEED_ID, COUNTRY, s.externalId, s.name, s.latitude, s.longitude, MODE, s.lines],
      );
    }
    await client.query('COMMIT');
    console.log(`[load-transit-stops] OK — ${apagadas} apagadas, ${stops.length} inseridas.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[load-transit-stops] FALHOU:', err instanceof Error ? err.message : err);
  process.exit(1);
});
