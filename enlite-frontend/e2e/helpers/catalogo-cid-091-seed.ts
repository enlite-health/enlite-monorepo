/**
 * catalogo-cid-091-seed.ts — terminologia de teste da spec 091 semeada por SQL, sob o advisory lock do release CORRENTE
 * (`is_current` é global; mesma chave 9100221 de `travarReleaseCorrente` em worker-functions/tests/e2e/helpers/ptiCatalogoCidSeed.ts),
 * numa conexão `psql` dedicada. Dados SINTÉTICOS (títulos que não são texto clínico de paciente).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { runSQL } from './patient-detail-c-helper';

const LOCK_RELEASE_CORRENTE = 9100221;

export interface StemSintetico {
  code: string;
  title: string;
}

/** Advisory lock de sessão numa conexão dedicada (processo `psql`): fechar o processo solta o lock. Falha ALTO após 25 s. */
export function travarReleaseCorrente(): Promise<() => void> {
  const container = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
  const proc: ChildProcessWithoutNullStreams = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'enlite_admin', '-d', 'enlite_e2e', '-tA', '-v', 'ON_ERROR_STOP=1']);
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`release CID corrente ocupado por outro e2e (lock ${LOCK_RELEASE_CORRENTE})`)); }, 25_000);
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('TRAVADO')) { clearTimeout(timer); resolve(() => { proc.kill(); }); }
    });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('exit', (code) => { if (!out.includes('TRAVADO')) { clearTimeout(timer); reject(new Error(`psql do lock saiu (${code}): ${err}`)); } });
    proc.stdin.write(`SET lock_timeout = '20s'; SELECT pg_advisory_lock(${LOCK_RELEASE_CORRENTE}); SELECT 'TRAVADO';\n`);
  });
}

/** Sai do release de teste e reativa o anterior (se houver). Idempotente. */
export function restaurarRelease(release: string, anterior: string): void {
  for (const s of [
    `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = '${release}'`,
    ...(anterior ? [`UPDATE terminology.icd_releases SET is_current = true, promoted_at = now(), promoted_by = 'e2e091-restore' WHERE release = '${anterior}'`] : []),
    `DELETE FROM terminology.icd_entities WHERE release = '${release}'`,
    `DELETE FROM terminology.icd_releases WHERE release = '${release}'`,
  ]) runSQL(s);
}

/** Cria o release de teste (1 capítulo + os stems), promove-o a corrente e devolve o release que estava corrente. */
export function semearRelease(release: string, uriBase: string, stems: StemSintetico[]): string {
  runSQL(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ('${release}', ${stems.length + 1}) ON CONFLICT (release) DO NOTHING`);
  const linhas = [
    `('${uriBase}/cap06', '${release}', '06', 'Capitulo sintetico 091', NULL, '06', NULL, 'chapter', false)`,
    ...stems.map((s) => `('${uriBase}/${s.code}', '${release}', '${s.code}', '${s.title}', NULL, '06', NULL, 'stem', true)`),
  ];
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ${linhas.join(',')}`);
  const anterior = runSQL(`SELECT release FROM terminology.icd_releases WHERE is_current AND release <> '${release}' LIMIT 1`);
  runSQL(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
  runSQL(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = now(), promoted_by = 'e2e091' WHERE release = '${release}'`);
  return anterior;
}
