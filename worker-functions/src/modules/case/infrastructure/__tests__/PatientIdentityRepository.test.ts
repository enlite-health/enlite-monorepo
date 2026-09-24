import type { PoolClient } from 'pg';
import { PatientIdentityRepository } from '../PatientIdentityRepository';

/**
 * PatientIdentityRepository — o SQL emitido pelos três caminhos de escrita/leitura.
 *
 * ── POR QUE ESTE ARQUIVO NASCE AGORA (I2) ───────────────────────────────────
 * Este repositório é o ÚNICO ponto do sistema que decide se `sex` e `document_type` do
 * paciente são sobrescritos pelo espelho do ClickUp. Ele estava a **25 % / 0 % de branches**
 * — o `ON CONFLICT DO UPDATE` inteiro sem uma linha de teste unitário — e foi exatamente ali
 * que o I2 mora: `sex = EXCLUDED.sex` sem condição APAGAVA o dado do paciente sempre que uma
 * opção do ClickUp deixava de resolver (185 linhas de `sex` medidas em exposição).
 *
 * A régua que este arquivo fixa, e que não pode regredir calada:
 *   - as bandeiras `*Readable` só valem no DO UPDATE (o INSERT é linha nova: não há o que apagar);
 *   - ausente = `true` — chamador antigo continua escrevendo, nunca congela em silêncio;
 *   - `true` com valor nulo continua APAGANDO (vazio legítimo, D-E — não é COALESCE).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

const TASK = 'cu-task-identity-unit';
const ID   = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function lastCall(): { sql: string; params: unknown[] } {
  const [sql, params] = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1];
  return { sql, params };
}

/** Índice 1-based do parâmetro, como o SQL o nomeia (`$N`). */
const p = (params: unknown[], n: number): unknown => params[n - 1];

beforeEach(() => {
  mockPoolQuery.mockReset().mockResolvedValue({ rows: [{ id: ID, xmax: '0' }] });
});

describe('PatientIdentityRepository.upsert', () => {
  it('linha NOVA: devolve created=true (xmax = 0) e o país cai no default AR', async () => {
    const out = await new PatientIdentityRepository().upsert({ clickupTaskId: TASK });

    expect(out).toEqual({ id: ID, created: true });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/INSERT INTO patients/);
    expect(sql).toMatch(/ON CONFLICT \(clickup_task_id\) DO UPDATE SET/);
    expect(p(params, 15)).toBe('AR');
    // Todos os opcionais ausentes viram NULL — o ramo `?? null` de cada um.
    expect(p(params, 2)).toBeNull();   // first_name
    expect(p(params, 3)).toBeNull();   // last_name
    expect(p(params, 4)).toBeNull();   // birth_date
    expect(p(params, 5)).toBeNull();   // document_type
    expect(p(params, 6)).toBeNull();   // document_number
    expect(p(params, 7)).toBeNull();   // affiliate_id
    expect(p(params, 8)).toBeNull();   // sex
    expect(p(params, 9)).toBeNull();   // phone_whatsapp
    expect(p(params, 10)).toBeNull();  // insurance_informed
    expect(p(params, 11)).toBeNull();  // insurance_verified
    expect(p(params, 12)).toBeNull();  // city_locality
    expect(p(params, 13)).toBeNull();  // province
    expect(p(params, 14)).toBeNull();  // zone_neighborhood
    expect(p(params, 16)).toBe(false); // needs_attention
    expect(p(params, 17)).toEqual([]); // attention_reasons
    expect(p(params, 18)).toBeNull();  // health_insurance_name
    expect(p(params, 19)).toBeNull();  // health_insurance_member_id
    expect(p(params, 20)).toBeNull();  // case_number
    expect(p(params, 21)).toBeNull();  // status
  });

  it('linha EXISTENTE: xmax != 0 → created=false', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: ID, xmax: '12345' }] });
    const out = await new PatientIdentityRepository().upsert({ clickupTaskId: TASK });
    expect(out).toEqual({ id: ID, created: false });
  });

  it('todos os campos presentes viajam nos $N certos (o outro lado de cada `?? null`)', async () => {
    const nascimento = new Date('1990-05-04T00:00:00Z');
    await new PatientIdentityRepository().upsert({
      clickupTaskId: TASK,
      firstName: 'Nome', lastName: 'Sobrenome', birthDate: nascimento,
      documentType: 'DNI', documentNumber: '12345678', affiliateId: 'AF-1',
      sex: 'FEMALE', phoneWhatsapp: '+5491100000000',
      insuranceInformed: 'OSDE', insuranceVerified: 'SANIDAD',
      cityLocality: 'Temperley', province: 'Buenos Aires', zoneNeighborhood: 'Centro',
      country: 'BR',
      needsAttention: true, attentionReasons: ['MISSING_INFO'],
      healthInsuranceName: 'OSPICHA', healthInsuranceMemberId: 'M-9',
      caseNumber: 766, status: 'ACTIVE',
    });

    const { params } = lastCall();
    expect(params.slice(0, 21)).toEqual([
      TASK, 'Nome', 'Sobrenome', nascimento, 'DNI', '12345678', 'AF-1', 'FEMALE',
      '+5491100000000', 'OSDE', 'SANIDAD', 'Temperley', 'Buenos Aires', 'Centro', 'BR',
      true, ['MISSING_INFO'], 'OSPICHA', 'M-9', 766, 'ACTIVE',
    ]);
  });

  it('as três bandeiras `*Readable` ausentes = TRUE — chamador antigo NUNCA para de escrever', async () => {
    await new PatientIdentityRepository().upsert({ clickupTaskId: TASK });
    const { params } = lastCall();
    expect(p(params, 22)).toBe(true); // insuranceVerifiedReadable
    expect(p(params, 23)).toBe(true); // documentTypeReadable
    expect(p(params, 24)).toBe(true); // sexReadable
  });

  it('I2 — `false` nas bandeiras faz o DO UPDATE PULAR a coluna (o `CASE WHEN` é a trava)', async () => {
    await new PatientIdentityRepository().upsert({
      clickupTaskId: TASK,
      documentTypeReadable: false,
      sexReadable: false,
      insuranceVerifiedReadable: false,
    });

    const { sql, params } = lastCall();
    expect(p(params, 22)).toBe(false);
    expect(p(params, 23)).toBe(false);
    expect(p(params, 24)).toBe(false);
    // A forma do SQL é o que garante o efeito — o `ELSE` devolve o valor JÁ GRAVADO.
    expect(sql).toMatch(/document_type\s+= CASE WHEN \$23::boolean THEN EXCLUDED\.document_type ELSE patients\.document_type END/);
    expect(sql).toMatch(/sex\s+= CASE WHEN \$24::boolean THEN EXCLUDED\.sex ELSE patients\.sex END/);
    expect(sql).toMatch(/insurance_verified\s+= CASE WHEN \$22::boolean THEN EXCLUDED\.insurance_verified ELSE patients\.insurance_verified END/);
    // ⚠️ E o INSERT continua escrevendo os dois: linha nova não tem o que apagar.
    expect(sql).toMatch(/document_type, document_number, affiliate_id,/);
  });

  it('quem chama com `client` usa a transação do chamador, não o pool', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ id: ID, xmax: '0' }] });
    await new PatientIdentityRepository().upsert(
      { clickupTaskId: TASK },
      { query: clientQuery } as unknown as PoolClient,
    );
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('PatientIdentityRepository.insertNative', () => {
  beforeEach(() => { mockPoolQuery.mockReset().mockResolvedValue({ rows: [{ id: ID }] }); });

  const minimo = { origin: 'web_form' as const, status: 'SOLICITANTE' as const, country: 'AR' as const };

  it('INSERT sem ON CONFLICT — nascimento nativo é sempre linha nova (created: true)', async () => {
    const out = await new PatientIdentityRepository().insertNative(minimo);

    expect(out).toEqual({ id: ID, created: true });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/INSERT INTO patients/);
    expect(sql).not.toMatch(/ON CONFLICT/);
    expect(p(params, 1)).toBe('web_form');
    expect(p(params, 2)).toBeNull();   // contact_email_encrypted
    expect(p(params, 16)).toBe('AR');
    expect(p(params, 17)).toBe(false); // needs_attention
    expect(p(params, 18)).toEqual([]); // attention_reasons
    expect(p(params, 22)).toBe('SOLICITANTE');
  });

  it('todos os campos presentes (o outro lado de cada `?? null` do caminho nativo)', async () => {
    const nascimento = new Date('1988-01-02T00:00:00Z');
    await new PatientIdentityRepository().insertNative({
      ...minimo,
      origin: 'admin_manual',
      contactEmailEncrypted: 'BASE64==',
      firstName: 'Nome', lastName: 'Sobrenome', birthDate: nascimento,
      documentType: 'DNI', documentNumber: '999', affiliateId: 'AF-2',
      sex: 'MALE', phoneWhatsapp: '+5491111111111',
      insuranceInformed: 'OSDE', insuranceVerified: 'SANIDAD',
      cityLocality: 'CABA', province: 'CABA', zoneNeighborhood: 'Palermo',
      needsAttention: true, attentionReasons: ['MISSING_INFO'],
      healthInsuranceName: 'OSPICHA', healthInsuranceMemberId: 'M-1',
      caseNumber: 900,
    });

    const { params } = lastCall();
    expect(params).toEqual([
      'admin_manual', 'BASE64==', 'Nome', 'Sobrenome', nascimento, 'DNI', '999', 'AF-2',
      'MALE', '+5491111111111', 'OSDE', 'SANIDAD', 'CABA', 'CABA', 'Palermo', 'AR',
      true, ['MISSING_INFO'], 'OSPICHA', 'M-1', 900, 'SOLICITANTE',
    ]);
  });

  it('país inválido é barrado ANTES do INSERT (backstop de runtime, D108) — nada é executado', async () => {
    await expect(
      new PatientIdentityRepository().insertNative({
        ...minimo,
        country: 'US' as unknown as 'AR',
      }),
    ).rejects.toThrow(/invalid country "US"/);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('com `client`, o INSERT nativo roda na transação do chamador', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ id: ID }] });
    await new PatientIdentityRepository().insertNative(
      minimo,
      { query: clientQuery } as unknown as PoolClient,
    );
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('PatientIdentityRepository.nextCaseNumber (migration 459, spec 027 T011)', () => {
  it('emite SELECT nextval(...) na transação do CHAMADOR (client), nunca no pool', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ n: '1000' }] });
    const n = await new PatientIdentityRepository().nextCaseNumber(
      { query: clientQuery } as unknown as PoolClient,
    );

    expect(n).toBe(1000);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][0]).toMatch(/nextval\('patients_case_number_seq'\)/);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('duas chamadas em sequência: case_number consecutivos e ≥1000 (T014)', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ n: '1000' }] })
      .mockResolvedValueOnce({ rows: [{ n: '1001' }] });
    const client = { query: clientQuery } as unknown as PoolClient;
    const repo = new PatientIdentityRepository();

    const first  = await repo.nextCaseNumber(client);
    const second = await repo.nextCaseNumber(client);

    expect(first).toBeGreaterThanOrEqual(1000);
    expect(second).toBe(first + 1);
  });

  it('devolve number, não string (bigint do pg chega como string — precisa do parseInt)', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ n: '4294967296' }] });
    const n = await new PatientIdentityRepository().nextCaseNumber(
      { query: clientQuery } as unknown as PoolClient,
    );
    expect(typeof n).toBe('number');
    expect(n).toBe(4294967296);
  });
});

describe('PatientIdentityRepository.findById', () => {
  it('devolve a linha quando existe, com os chat ids agregados', async () => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [{ id: ID, firstName: 'Nome' }] });
    const out = await new PatientIdentityRepository().findById(ID);
    expect(out).toEqual({ id: ID, firstName: 'Nome' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/FROM patients p WHERE p\.id = \$1/);
    expect(sql).toMatch(/jsonb_object_agg\(c\.role, c\.chat_id\)/);
    expect(params).toEqual([ID]);
  });

  it('devolve null quando não existe (nunca `undefined` vazando para o chamador)', async () => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    expect(await new PatientIdentityRepository().findById(ID)).toBeNull();
  });
});
