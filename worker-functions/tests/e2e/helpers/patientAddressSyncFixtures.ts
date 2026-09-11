/**
 * patientAddressSyncFixtures — o que os e2e de `PatientRelatedWriter.replacePatientAddresses`
 * (o caminho do sync do ClickUp) precisam repetir a cada suíte: um geocoder mudo, o construtor
 * do endereço/slot que o ClickUp manda, e a limpeza por `clickup_task_id LIKE <tag>`.
 *
 * Extraído de `c1b-address-version-preserves-logistics.e2e.test.ts` quando
 * `sync-clickup-preserva-endereco-painel.e2e.test.ts` foi criado copiando as três peças
 * (gate `revisao-pr`, critério 2 — repetição de teste). Os DOIS arquivos importam daqui; o stub
 * do geocoder só é definido NESTE arquivo — nenhum outro `.e2e.test.ts` deve voltar a declarar
 * o próprio `geocodeBatch`.
 */
import { Pool } from 'pg';
import type { GeocodingService } from '../../../src/infrastructure/services/GeocodingService';
import type { PatientAddress } from '../../../src/infrastructure/repositories/PatientRepository';

/** O geocoder nunca é a peça sob teste aqui: devolve "não resolvi" sem tocar rede. */
export const noopGeocoder = {
  geocodeBatch: async (queries: string[]) => queries.map(() => null),
} as unknown as GeocodingService;

/**
 * Um endereço no formato que `replacePatientAddresses` recebe do sync do ClickUp.
 * Default `displayOrder: 1` / `addressType: 'primary'` — o slot mais comum nos testes; passe
 * `opts` para os outros slots (2, 3, …) e o `addressType` que o ClickUp mandaria para eles.
 */
export function clickupAddressInput(
  formatted: string,
  opts: { displayOrder?: number; addressType?: string } = {},
): PatientAddress {
  return {
    addressType: opts.addressType ?? 'primary',
    addressFormatted: formatted,
    addressRaw: null,
    displayOrder: opts.displayOrder ?? 1,
    state: 'Buenos Aires',
    city: 'Vicente López',
    neighborhood: 'Florida',
  } as unknown as PatientAddress;
}

/**
 * Apaga os pacientes de teste (e as vagas que apontam para eles — `job_postings` tem FK
 * `ON DELETE RESTRICT` para `patient_addresses`, então a vaga sai primeiro) pelo padrão de
 * `clickup_task_id`. Chamar em `beforeAll`/`beforeEach`/`afterAll` de cada suíte, com uma tag
 * própria por suíte para não colidir com outras.
 */
export async function limparPacientesDeTeste(pool: Pool, tagPattern: string): Promise<void> {
  await pool.query(
    `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
    [tagPattern],
  );
  await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [tagPattern]);
}
