/**
 * patient-detail-c-helper.ts — semeadura e leitura direta no Postgres do docker para o e2e da
 * spec 013 (bloco C, serviço contratado). Dados SINTÉTICOS; KMS em passthrough base64
 * (NODE_ENV=test na API). Molde: patient-detail-b-helper.ts.
 */
import { createHmac } from 'node:crypto';
import { insertTestPatient } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Paciente PENDING_ADMISSION (ativável), com 1 endereço — o mínimo pro fluxo do bloco C. */
export function seedActivatablePatient(): { patientId: string; addressId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  // Spec 014 (SUP-D1): `POST /activate` agora também exige consentimento + cobertura informada
  // — sem isto o passo "ativar" deste teste (regressão do bloco C) voltaria 422.
  const { patientId, addressId } = insertTestPatient({
    status: 'PENDING_ADMISSION', firstName: 'BlocoC', lastName: `Servicio${stamp}`,
    withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
  });
  runSQL(`UPDATE patients SET case_number = ${900000 + Number(stamp) % 90000} WHERE id = '${patientId}'`);
  // Migration 330: o teste precisa do id do endereço para vincular o serviço no drawer.
  if (!addressId) throw new Error('seedActivatablePatient: insertTestPatient não devolveu addressId');
  return { patientId, addressId, stamp };
}

/**
 * `name_trgm_bidx` como o backend grava (`BlindIndexService.generateNameTrigramBidx`): a busca por
 * NOME em `GET /api/admin/workers?search=` é `name_trgm_bidx @> <trigramas do termo>` — um worker
 * semeado por SQL sem esse índice NUNCA aparece na busca (medido 03/09: API devolvia `[]` para
 * o nome exato). Chave fixa de teste (32 bytes 0x42, `NODE_ENV=test`), HMAC-SHA256 truncado a 8
 * bytes por trigrama do nome normalizado com padding de espaço dos dois lados, sem repetição,
 * ordenado por hex. Sai como `ARRAY[decode(...,'hex')]::bytea[]` para não depender de barra
 * invertida atravessando shell → psql.
 */
function nameTrgmBidxSql(first: string, last: string): string {
  const key = Buffer.alloc(32, 0x42);
  const normalized = `${first} ${last}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const padded = ` ${normalized} `;
  const hex = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) {
    hex.add(createHmac('sha256', key).update(padded.slice(i, i + 3), 'utf8').digest().subarray(0, 8).toString('hex'));
  }
  const sorted = [...hex].sort((a, b) => a.localeCompare(b));
  return `ARRAY[${sorted.map((h) => `decode('${h}','hex')`).join(',')}]::bytea[]`;
}

/** Worker sintético, com nome decriptável (passthrough base64) E indexado pra busca por nome. */
export function seedWorker(stamp: string): { workerId: string; name: string } {
  const first = `Prestador${stamp}`;
  const last = 'Fixture';
  // `psql -tAc` imprime a linha de status ("INSERT 0 1") MESMO com -t quando o comando visível é
  // um INSERT/UPDATE/DELETE com RETURNING — só um SELECT não carrega essa linha. O CTE por fora
  // faz o comando visível ser um SELECT, e `runSQL` volta a devolver só o valor, como em todo
  // outro uso deste helper (medido: `psql -tAc "INSERT ... RETURNING id"` direto no container
  // devolve 2 linhas, "<uuid>\nINSERT 0 1").
  const out = runSQL(`WITH ins AS (INSERT INTO workers (auth_uid, email, country, timezone, first_name_encrypted, last_name_encrypted, name_trgm_bidx) VALUES ('e2e-c-worker-${stamp}', 'e2e-c-worker-${stamp}@e2e.local', 'AR', 'America/Argentina/Buenos_Aires', '${b64(first)}', '${b64(last)}', ${nameTrgmBidxSql(first, last)}) RETURNING id) SELECT id FROM ins`);
  return { workerId: out, name: `${first} ${last}` };
}

export function cleanupWorker(workerId: string): void {
  if (!workerId) return;
  runSQL(`DELETE FROM workers WHERE id = '${workerId}'`);
}

export function readContractedServices(patientId: string): Array<{ serviceCode: string; active: boolean }> {
  const out = runSQL(`SELECT string_agg(service_code || ':' || active, ',') FROM patient_contracted_services WHERE patient_id = '${patientId}'`);
  return out ? out.split(',').map((l) => { const [serviceCode, active] = l.split(':'); return { serviceCode, active: active === 'true' }; }) : []; // `text || boolean` vira 'true'/'false' no Postgres, não 't'/'f' (medido 03/09)
}

export function readVacanciesByService(patientId: string): Array<{ serviceCode: string | null; providersNeeded: number | null }> {
  const out = runSQL(`SELECT string_agg(COALESCE(pcs.service_code,'<NULL>') || ':' || COALESCE(jp.providers_needed::text,'<NULL>'), ',') FROM job_postings jp LEFT JOIN patient_contracted_services pcs ON pcs.id = jp.contracted_service_id WHERE jp.patient_id = '${patientId}' AND jp.deleted_at IS NULL`);
  return out ? out.split(',').map((l) => { const [serviceCode, providersNeeded] = l.split(':'); return { serviceCode: serviceCode === '<NULL>' ? null : serviceCode, providersNeeded: providersNeeded === '<NULL>' ? null : Number(providersNeeded) }; }) : [];
}
