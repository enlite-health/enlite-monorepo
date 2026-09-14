/**
 * PatientRepository (shim @deprecated) — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock),
 * contra as migrations até a 434 (spec 019, task adicional "cobertura de PatientRepository.ts").
 *
 * Escopo (contrato desta rodada): cobrir `upsertFromClickUp` e `replaceProfessionals` (e, por
 * dependência direta de `upsertFromClickUp`, `replaceAddresses`) com TODOS os ramos alcançáveis.
 * A classe é `@deprecated`/shim (zero callers em produção — grep na task anterior já provou isso
 * para `replaceAddresses`; o mesmo grep de `new PatientRepository(` continua valendo aqui), mas o
 * arquivo entra no diff `origin/main..HEAD` (import type usado por `PatientRelatedWriter`) e por
 * isso a régua de 100% por arquivo se aplica.
 *
 * Como rodar (fora da stack completa — sem API nem Firebase Emulator):
 *   docker run -d --name 019cov-postgres -p 127.0.0.1:5541:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e \
 *     node scripts/run-migrations-docker.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand PatientRepository
 *
 * NODE_ENV=test (padrão do jest) põe `KMSEncryptionService` em modo passthrough (base64), então
 * `phone_encrypted`/`email_encrypted` no banco são o base64 do texto original — sem KMS real.
 */
import { Pool } from 'pg';
import { PatientRepository } from '../../src/infrastructure/repositories/PatientRepository';
import type { GeocodingService } from '../../src/infrastructure/services/GeocodingService';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e';

process.env.DATABASE_URL = DATABASE_URL;

function makeGeocoder(batchImpl?: (queries: string[]) => Promise<Array<{ latitude: number; longitude: number } | null>>) {
  const geocodeBatch = jest.fn(
    batchImpl ?? (async (queries: string[]) => queries.map(() => null)),
  );
  return {
    geocode: jest.fn().mockResolvedValue(null),
    geocodeBatch,
  } as unknown as GeocodingService & { geocodeBatch: jest.Mock };
}

describe('PatientRepository @repo (Postgres real, upsertFromClickUp + replaceAddresses + replaceProfessionals)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    // limpa tudo entre testes — patient_addresses/patient_professionals somem via ON DELETE CASCADE
    await pool.query("DELETE FROM patients WHERE clickup_task_id LIKE 'repo-test-%'");
  });

  it('construtor sem geocoder explícito usa `new GeocodingService()` (ramo `??` do construtor)', () => {
    const repo = new PatientRepository();
    expect(repo).toBeInstanceOf(PatientRepository);
  });

  describe('upsertFromClickUp', () => {
    it('cria paciente novo (created=true) com TODOS os campos preenchidos + addresses + professionals', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);

      const result = await repo.upsertFromClickUp({
        clickupTaskId: 'repo-test-full',
        firstName: 'Ana',
        lastName: 'García',
        birthDate: new Date('1980-01-01'),
        documentType: 'DNI',
        documentNumber: '12345678',
        affiliateId: 'AFF-1',
        sex: 'FEMALE',
        phoneWhatsapp: '+5491100000000',
        diagnosis: 'Diagnóstico X',
        dependencyLevel: 'SEVERE',
        clinicalSegments: 'segmento-a',
        serviceType: ['AT'] as unknown as string,
        deviceType: 'HOME',
        additionalComments: 'obs',
        hasJudicialProtection: true,
        hasCud: true,
        hasConsent: true,
        insuranceInformed: 'OSDE',
        insuranceVerified: 'OSDE-verificado',
        cityLocality: 'CABA',
        province: 'Buenos Aires',
        zoneNeighborhood: 'Palermo',
        country: 'AR',
        addresses: [
          { addressFormatted: 'Av. Corrientes 1234', displayOrder: 1 },
        ],
        professionals: [
          { name: 'Dr. Juan Pérez', phone: '111', email: 'juan@x.com', displayOrder: 1, isTeam: true },
        ],
      });

      expect(result.created).toBe(true);

      const { rows } = await pool.query(
        `SELECT first_name, last_name, document_number, country FROM patients WHERE id = $1`,
        [result.id],
      );
      expect(rows[0]).toEqual({
        first_name: 'Ana', last_name: 'García', document_number: '12345678', country: 'AR',
      });

      const { rows: addrRows } = await pool.query(
        `SELECT address_formatted FROM patient_addresses WHERE patient_id = $1`, [result.id],
      );
      expect(addrRows).toHaveLength(1);

      const { rows: profRows } = await pool.query(
        `SELECT name, is_team FROM patient_professionals WHERE patient_id = $1`, [result.id],
      );
      expect(profRows).toEqual([{ name: 'Dr. Juan Pérez', is_team: true }]);
    });

    it('atualiza paciente existente (created=false) quando SÓ os campos obrigatórios são enviados — todo o resto vira NULL (branch `?? null` do lado falso)', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);

      const first = await repo.upsertFromClickUp({
        clickupTaskId: 'repo-test-minimal',
        firstName: 'Bruno',
        country: 'AR',
      });
      expect(first.created).toBe(true);

      // Segunda chamada: MESMO clickup_task_id, NENHUM campo opcional, addresses/professionals
      // OMITIDOS — cobre o ramo `undefined` de `data.addresses !== undefined` /
      // `data.professionals !== undefined` (replaceAddresses/replaceProfessionals NÃO chamados)
      // e o ramo `?? null` de cada campo opcional do UPDATE.
      const replaceAddressesSpy = jest.spyOn(repo, 'replaceAddresses');
      const replaceProfessionalsSpy = jest.spyOn(repo, 'replaceProfessionals');

      const second = await repo.upsertFromClickUp({
        clickupTaskId: 'repo-test-minimal',
      });

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(replaceAddressesSpy).not.toHaveBeenCalled();
      expect(replaceProfessionalsSpy).not.toHaveBeenCalled();

      const { rows } = await pool.query(
        `SELECT first_name, country FROM patients WHERE id = $1`, [first.id],
      );
      // first_name virou NULL (EXCLUDED.first_name = null, pois não foi enviado na 2ª chamada)
      expect(rows[0].first_name).toBeNull();
      // country default (AR) quando omitido no `data`
      expect(rows[0].country).toBe('AR');
    });

    it('created=false ao atualizar paciente existente COM addresses/professionals nesta chamada (ramo `!== undefined` verdadeiro no UPDATE)', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);

      const first = await repo.upsertFromClickUp({ clickupTaskId: 'repo-test-update-with-related' });
      expect(first.created).toBe(true);

      const replaceAddressesSpy = jest.spyOn(repo, 'replaceAddresses');
      const replaceProfessionalsSpy = jest.spyOn(repo, 'replaceProfessionals');

      const second = await repo.upsertFromClickUp({
        clickupTaskId: 'repo-test-update-with-related',
        addresses: [{ addressFormatted: 'Rua X', displayOrder: 1 }],
        professionals: [{ name: 'Fono', displayOrder: 1 }],
      });

      expect(second.created).toBe(false);
      expect(replaceAddressesSpy).toHaveBeenCalledTimes(1);
      expect(replaceProfessionalsSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('replaceAddresses', () => {
    async function createPatient(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country) VALUES ($1, 'AR') RETURNING id`,
        [`repo-test-addr-${Math.random().toString(36).slice(2)}`],
      );
      return rows[0].id;
    }

    it('geocodifica endereço novo e, na passagem seguinte com o MESMO texto, REUSA a coordenada conhecida — geocodeBatch não é chamado de novo', async () => {
      const geocoder = makeGeocoder(async (queries) => queries.map(() => ({ latitude: -34.6, longitude: -58.4 })));
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceAddresses(patientId, [
        { addressFormatted: 'Av. Corrientes 1234', displayOrder: 1 },
      ]);
      expect(geocoder.geocodeBatch).toHaveBeenCalledTimes(1);

      const { rows: firstRows } = await pool.query(
        `SELECT lat, lng FROM patient_addresses WHERE patient_id = $1`, [patientId],
      );
      expect(Number(firstRows[0].lat)).toBeCloseTo(-34.6, 5);

      // 2ª passagem: mesmo texto — se o `known` map (lido ANTES do DELETE) funcionar,
      // `indexedToResolve` fica vazio e geocodeBatch NÃO é chamado de novo.
      await repo.replaceAddresses(patientId, [
        { addressFormatted: 'Av. Corrientes 1234', displayOrder: 1 },
      ]);
      expect(geocoder.geocodeBatch).toHaveBeenCalledTimes(1); // continua 1, não foi a 2

      const { rows: secondRows } = await pool.query(
        `SELECT lat, lng FROM patient_addresses WHERE patient_id = $1`, [patientId],
      );
      expect(Number(secondRows[0].lat)).toBeCloseTo(-34.6, 5);
    });

    it('endereço só com addressRaw (sem addressFormatted) entra em `valid` e é persistido', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceAddresses(patientId, [
        { addressRaw: 'Bolivia 4145', displayOrder: 1 },
      ]);

      const { rows } = await pool.query(
        `SELECT address_raw, address_formatted FROM patient_addresses WHERE patient_id = $1`, [patientId],
      );
      expect(rows).toEqual([{ address_raw: 'Bolivia 4145', address_formatted: null }]);
    });

    it('endereço sem addressFormatted NEM addressRaw é filtrado por `valid` — não entra no INSERT (mistura com um válido)', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceAddresses(patientId, [
        { displayOrder: 1 }, // nem formatted nem raw — descartado
        { addressFormatted: 'Válido 1', displayOrder: 2 },
      ]);

      const { rows } = await pool.query(
        `SELECT address_formatted FROM patient_addresses WHERE patient_id = $1`, [patientId],
      );
      expect(rows).toEqual([{ address_formatted: 'Válido 1' }]);
    });

    it('lista vazia OU só endereços inválidos → `valid.length === 0` → DELETE roda mas NENHUM INSERT', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceAddresses(patientId, []);
      const { rows: r1 } = await pool.query(`SELECT * FROM patient_addresses WHERE patient_id = $1`, [patientId]);
      expect(r1).toHaveLength(0);

      await repo.replaceAddresses(patientId, [{ displayOrder: 1 }]); // só inválido
      const { rows: r2 } = await pool.query(`SELECT * FROM patient_addresses WHERE patient_id = $1`, [patientId]);
      expect(r2).toHaveLength(0);
      expect(geocoder.geocodeBatch).not.toHaveBeenCalled();
    });

    it('linhas anteriores com address_formatted NULL/vazio ou lat/lng NULL são ignoradas ao montar o mapa de conhecidas (3 ramos `continue`)', async () => {
      const geocoder = makeGeocoder(async (queries) => queries.map(() => ({ latitude: -10, longitude: -20 })));
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      // Semeia 3 linhas "anteriores" diretamente por SQL, cada uma acionando um `continue` diferente
      // no laço que monta `conhecidas` dentro de replaceAddresses:
      //   r1: address_formatted NULL           → `!texto` verdadeiro
      //   r2: address_formatted preenchido, lat NULL → `r.lat === null` verdadeiro
      //   r3: address_formatted preenchido, lat preenchido, lng NULL → `r.lng === null` verdadeiro
      await pool.query(
        `INSERT INTO patient_addresses (patient_id, address_formatted, lat, lng, display_order)
         VALUES ($1, NULL, NULL, NULL, 1),
                ($1, 'Sem coordenada', NULL, NULL, 2),
                ($1, 'Só latitude', 1.0, NULL, 3)`,
        [patientId],
      );

      // Chamada seguinte substitui as 3 por um endereço novo — nenhuma delas deveria
      // ter entrado no mapa `conhecidas` (nenhuma é reaproveitada), então o geocoder É chamado.
      await repo.replaceAddresses(patientId, [{ addressFormatted: 'Endereço novo', displayOrder: 1 }]);

      expect(geocoder.geocodeBatch).toHaveBeenCalledTimes(1);
      const { rows } = await pool.query(
        `SELECT address_formatted, lat FROM patient_addresses WHERE patient_id = $1`, [patientId],
      );
      expect(rows).toEqual([{ address_formatted: 'Endereço novo', lat: '-10.0000000' }]);
    });
  });

  describe('replaceProfessionals', () => {
    async function createPatient(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country) VALUES ($1, 'AR') RETURNING id`,
        [`repo-test-prof-${Math.random().toString(36).slice(2)}`],
      );
      return rows[0].id;
    }

    it('profissional com todos os campos: phone/email encriptados (passthrough base64), isTeam=true', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceProfessionals(patientId, [
        { name: 'Dra. Ríos', phone: '5491100000000', email: 'rios@x.com', displayOrder: 1, isTeam: true },
      ]);

      const { rows } = await pool.query(
        `SELECT name, phone_encrypted, email_encrypted, is_team FROM patient_professionals WHERE patient_id = $1`,
        [patientId],
      );
      expect(rows).toEqual([{
        name: 'Dra. Ríos',
        phone_encrypted: Buffer.from('5491100000000', 'utf8').toString('base64'),
        email_encrypted: Buffer.from('rios@x.com', 'utf8').toString('base64'),
        is_team: true,
      }]);
    });

    it('profissional só com name (phone/email/isTeam omitidos) — ramos `?? null` / `?? false` do lado falso', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceProfessionals(patientId, [
        { name: 'Enfermeiro Sem Contato', displayOrder: 1 },
      ]);

      const { rows } = await pool.query(
        `SELECT name, phone_encrypted, email_encrypted, is_team FROM patient_professionals WHERE patient_id = $1`,
        [patientId],
      );
      expect(rows).toEqual([{
        name: 'Enfermeiro Sem Contato', phone_encrypted: null, email_encrypted: null, is_team: false,
      }]);
    });

    it('profissional sem name (ou só espaços) é filtrado por `valid` — mistura com um válido', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceProfessionals(patientId, [
        { name: '   ', displayOrder: 1 } as { name: string; displayOrder: number },
        { name: 'Válido', displayOrder: 2 },
      ]);

      const { rows } = await pool.query(
        `SELECT name FROM patient_professionals WHERE patient_id = $1`, [patientId],
      );
      expect(rows).toEqual([{ name: 'Válido' }]);
    });

    it('lista vazia OU só nomes em branco → `valid.length === 0` → DELETE roda mas NENHUM INSERT', async () => {
      const geocoder = makeGeocoder();
      const repo = new PatientRepository(geocoder);
      const patientId = await createPatient();

      await repo.replaceProfessionals(patientId, []);
      const { rows: r1 } = await pool.query(`SELECT * FROM patient_professionals WHERE patient_id = $1`, [patientId]);
      expect(r1).toHaveLength(0);

      await repo.replaceProfessionals(patientId, [{ name: '', displayOrder: 1 }]);
      const { rows: r2 } = await pool.query(`SELECT * FROM patient_professionals WHERE patient_id = $1`, [patientId]);
      expect(r2).toHaveLength(0);
    });
  });
});
