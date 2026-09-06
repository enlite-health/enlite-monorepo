/**
 * patient-support-network-replace.e2e.test.ts — spec 011, A1 (lex C1.1 / C1.2), Postgres REAL.
 *
 * `updatePatientSection('support-network')` é REPLACE (DELETE + INSERT). Este
 * arquivo prova as duas faces disso contra o banco:
 *   1. a PERDA: um payload no formato do drawer ANTIGO (sem documento, sem
 *      source) apaga o documento e reescreve a procedência como 'clickup';
 *   2. a GARANTIA: com documento e source no payload (o drawer novo), o banco
 *      relê tudo intacto — inclusive `source='web_form'` do lead público.
 * O caso 1 é a reprodução do bug no nível do serviço (característica do
 * replace, não regressão a consertar aqui — o conserto é o drawer reenviar).
 * KMS em passthrough base64 (NODE_ENV=test), como patient-responsibles.test.ts.
 */
import { Pool } from 'pg';
import { PatientService } from '../../src/modules/case/application/PatientService';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const DOC = '11222333';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface Row { document_type: string | null; document_number_encrypted: string | null; source: string; phone_encrypted: string | null }

describe('A1 — support-network é replace-all: o que o payload não traz, o banco perde', () => {
  let pool: Pool;
  const svc = new PatientService();
  const created: string[] = [];

  async function seed(): Promise<string> {
    const { id } = await svc.createNativePatient(
      {
        firstName: 'A1', lastName: 'Replace E2E', country: 'AR', phoneWhatsapp: '+5491100000010',
        responsibles: [{ firstName: 'Resp', lastName: 'Lead', phone: '+5491100000011', email: null, documentType: 'DNI', documentNumber: DOC, isPrimary: true, displayOrder: 1, source: 'web_form' }],
      },
      { origin: 'web_form', status: 'ADMISSION' },
    );
    created.push(id);
    return id;
  }

  async function readRow(patientId: string): Promise<Row> {
    const { rows } = await pool.query<Row>('SELECT document_type, document_number_encrypted, source, phone_encrypted FROM patient_responsibles WHERE patient_id = $1', [patientId]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => {
    for (const id of created) await pool.query('DELETE FROM patients WHERE id = $1', [id]).catch(() => {});
    await pool.end();
  });

  it('1. (a perda) payload do drawer ANTIGO — só telefone editado, sem documento nem source → documento NULL e source "clickup"', async () => {
    const patientId = await seed();
    expect(await readRow(patientId)).toMatchObject({ document_type: 'DNI', document_number_encrypted: b64(DOC), source: 'web_form' });

    await svc.updatePatientSection(patientId, 'support-network', {
      responsibles: [{ firstName: 'Resp', lastName: 'Lead', phone: '+5491100000099', email: null, isPrimary: true, displayOrder: 0 }],
    });

    const row = await readRow(patientId);
    expect(row.phone_encrypted).toBe(b64('+5491100000099'));
    expect(row.document_type).toBeNull();
    expect(row.document_number_encrypted).toBeNull();
    expect(row.source).toBe('clickup');
  });

  it('2. (a garantia) payload do drawer NOVO — documento e source reenviados → tudo intacto depois de editar só o telefone', async () => {
    const patientId = await seed();

    await svc.updatePatientSection(patientId, 'support-network', {
      responsibles: [{ firstName: 'Resp', lastName: 'Lead', phone: '+5491100000099', email: null, documentType: 'DNI', documentNumber: DOC, source: 'web_form', isPrimary: true, displayOrder: 0 }],
    });

    const row = await readRow(patientId);
    expect(row.phone_encrypted).toBe(b64('+5491100000099'));
    expect(row.document_type).toBe('DNI');
    expect(row.document_number_encrypted).toBe(b64(DOC));
    expect(row.source).toBe('web_form');
  });
});
