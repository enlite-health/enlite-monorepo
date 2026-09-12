/**
 * PatientRelatedWriter — as duas coleções auxiliares do paciente, sem regra de negócio.
 *
 * A prova de que o caminho de produção funciona contra Postgres de verdade é o e2e
 * `tests/e2e/c1b-address-version-preserves-logistics.e2e.test.ts` (C2 do relatório F5: o Path 2
 * apagava `access_notes` e `logistics_corridor`). Aqui cobrimos os RAMOS que o e2e não distingue:
 * qual dos três caminhos cada slot toma, o que vai em cada parâmetro, e a limpeza dos slots que
 * sumiram do payload.
 *
 * Spec 019 (B4/B7): `address_type` sai do UPDATE (Path 1) e do INSERT (Path 2/3) — nasce/
 * permanece NULL, só o PATCH humano escreve valor. `is_default` entra: Path 1 nunca o toca; Path 2
 * (versiona) carrega o valor da linha arquivada; Path 3 (INSERT puro, slot novo) só nasce
 * principal quando é o slot 1 E o paciente ainda não tem nenhum principal ativo — a decisão vem
 * de uma nova query `SELECT EXISTS(...)` que roda uma vez por chamada.
 */
const mockGeocode = jest.fn();
jest.mock('../../infrastructure/geocodePatientAddresses', () => ({
  geocodePatientAddressesBestEffort: (...args: unknown[]) => mockGeocode(...args),
}));
const mockEncrypt = jest.fn(async (v: string | null) => (v === null ? null : `enc(${v})`));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: mockEncrypt })),
}));

import { replacePatientAddresses, replacePatientProfessionals } from '../PatientRelatedWriter';
import type { PatientAddress, PatientProfessional } from '../../../../infrastructure/repositories/PatientRepository';
import type { GeocodingService } from '../../../../infrastructure/services/GeocodingService';

const PID = 'pat-1';
const geocoder = {} as GeocodingService;

type Chamada = { sql: string; params: unknown[] };

/**
 * Cliente de mentira: responde por FORMA da query. `existing` são as linhas ativas de
 * `patient_addresses`; `published` é o conjunto de ids com vaga publicada apontando para eles;
 * `patientHasDefault` controla a resposta da nova query `SELECT EXISTS(...is_default...)`
 * (spec 019) — default `false` (paciente sem principal ainda).
 *
 * O SELECT inicial simula o `WHERE` de verdade: só filtra por `source = 'clickup'` quando o SQL
 * recebido CONTÉM esse trecho — se a sabotagem (contrato item 4) remover o filtro do código, o
 * mock deixa de filtrar também, porque está espelhando o que o Postgres faria com aquele SQL
 * exato, não reimplementando a regra por fora.
 */
function cliente(opts: {
  existing?: Array<{ id: string; display_order: number; address_formatted: string | null; logistics_corridor: string | null; access_notes: string | null; is_default?: boolean; lat?: string | number | null; lng?: string | number | null; source?: string }>;
  published?: string[];
  patientHasDefault?: boolean;
} = {}) {
  const chamadas: Chamada[] = [];
  let novos = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/SELECT id, display_order, address_formatted/.test(sql)) {
      const todasExistentes = (opts.existing ?? []).map((r) => ({ is_default: false, ...r }));
      const rows = /AND\s+source\s*=\s*'clickup'/.test(sql)
        ? todasExistentes.filter(r => (r.source ?? 'clickup') === 'clickup')
        : todasExistentes;
      return { rows, rowCount: rows.length };
    }
    if (/SELECT EXISTS \(\s*SELECT 1 FROM patient_addresses WHERE patient_id = \$1 AND is_default AND archived_at IS NULL/.test(sql)) {
      return { rows: [{ exists: opts.patientHasDefault ?? false }], rowCount: 1 };
    }
    if (/COUNT\(\*\)::text AS count FROM job_postings/.test(sql)) {
      return { rows: [{ count: (opts.published ?? []).includes(String(params[0])) ? '1' : '0' }], rowCount: 1 };
    }
    if (/^\s*INSERT INTO patient_addresses/.test(sql)) { novos += 1; return { rows: [{ id: `novo-${novos}` }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as import('pg').PoolClient, chamadas };
}

const sqlDe = (chamadas: Chamada[], re: RegExp): Chamada | undefined => chamadas.find((c) => re.test(c.sql));
const todos = (chamadas: Chamada[], re: RegExp): Chamada[] => chamadas.filter((c) => re.test(c.sql));

const endereco = (over: Partial<PatientAddress> = {}): PatientAddress => ({
  addressFormatted: 'Av. Maipú 1234',
  addressRaw: null,
  displayOrder: 1,
  state: 'Buenos Aires',
  city: 'Vicente López',
  neighborhood: 'Florida',
  ...over,
});

const linha = (over: Partial<{ id: string; display_order: number; address_formatted: string | null; logistics_corridor: string | null; access_notes: string | null; is_default: boolean; lat: string | number | null; lng: string | number | null; source: string }> = {}) => ({
  id: 'antiga-1',
  display_order: 1,
  address_formatted: 'Av. Maipú 1234',
  logistics_corridor: 'Corredor Norte',
  access_notes: 'Portero 24h',
  is_default: false,
  lat: null as string | number | null,
  lng: null as string | number | null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGeocode.mockImplementation(async (addresses: PatientAddress[]) => addresses.map((address) => ({ address, lat: -34.5, lng: -58.5 })));
});

describe('replacePatientAddresses', () => {
  it('sem endereço VÁLIDO (nem formatted nem raw) não geocodifica nem escreve — só a leitura', async () => {
    const { client, chamadas } = cliente({ existing: [linha()] });
    await replacePatientAddresses(PID, [endereco({ addressFormatted: null, addressRaw: null })], client, geocoder);
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].sql).toMatch(/SELECT id, display_order/);
  });

  it('endereço só com `addressRaw` conta como válido', async () => {
    const { client, chamadas } = cliente();
    await replacePatientAddresses(PID, [endereco({ addressFormatted: null, addressRaw: 'Bolivia 4145' })], client, geocoder);
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)).toBeDefined();
  });

  it('Path 1 — mesma rua e SEM vaga publicada: UPDATE no lugar, nenhum INSERT, nenhum arquivamento, address_type NUNCA escrito', async () => {
    const { client, chamadas } = cliente({ existing: [linha()] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    const upd = sqlDe(chamadas, /^UPDATE patient_addresses SET\s+address_formatted/);
    expect(upd).toBeDefined();
    expect(upd?.sql).not.toMatch(/address_type/);
    expect(upd?.sql).not.toMatch(/is_default/);
    expect(upd?.params).toEqual(['antiga-1', 'Av. Maipú 1234', null, 'Buenos Aires', 'Vicente López', 'Florida', -34.5, -58.5]);
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)).toBeUndefined();
    expect(sqlDe(chamadas, /SET archived_at = NOW\(\)/)).toBeUndefined();
  });

  it('Path 1 com campos AUSENTES no payload: grava null em cada um (nunca `undefined`)', async () => {
    const { client, chamadas } = cliente({ existing: [linha({ address_formatted: null })] });
    await replacePatientAddresses(
      PID,
      [{ addressRaw: 'Bolivia 4145', displayOrder: 1 } as PatientAddress],
      client,
      geocoder,
    );
    const upd = sqlDe(chamadas, /^UPDATE patient_addresses SET\s+address_formatted/);
    expect(upd?.params).toEqual(['antiga-1', null, 'Bolivia 4145', null, null, null, -34.5, -58.5]);
  });

  it('Path 2 por VAGA PUBLICADA (rua idêntica): arquiva, insere copiando logística, acesso E is_default, remapeia rascunhos', async () => {
    const { client, chamadas } = cliente({ existing: [linha({ is_default: true })], published: ['antiga-1'] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);

    expect(sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = \$1/)?.params).toEqual(['antiga-1']);
    const ins = sqlDe(chamadas, /INSERT INTO patient_addresses/);
    expect(ins?.sql).toMatch(/logistics_corridor, access_notes, is_default/);
    expect(ins?.sql).not.toMatch(/address_type/);
    // Path 2 CARREGA o is_default da linha arquivada (true) — não deduz de novo.
    expect(ins?.params).toEqual([PID, 'Av. Maipú 1234', null, 1, 'Buenos Aires', 'Vicente López', 'Florida', -34.5, -58.5, 'Corredor Norte', 'Portero 24h', true]);
    expect(sqlDe(chamadas, /UPDATE job_postings/)?.params).toEqual(['novo-1', 'antiga-1']);
    // Migration 330: o serviço contratado ATIVO acompanha o endereço novo (o encerrado guarda
    // onde foi prestado — a linha arquivada continua existindo).
    const svc = sqlDe(chamadas, /UPDATE patient_contracted_services/);
    expect(svc?.params).toEqual(['novo-1', 'antiga-1']);
    expect(svc?.sql).toMatch(/AND active/);
  });

  it('Path 2 por MUDANÇA de rua: mesmo desfecho — a logística é do domicílio, não do texto da rua; is_default=false carrega igual', async () => {
    const { client, chamadas } = cliente({ existing: [linha({ address_formatted: 'Rua Velha 1', is_default: false })] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    expect(sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = \$1/)).toBeDefined();
    const ins = sqlDe(chamadas, /INSERT INTO patient_addresses/);
    expect(ins?.params.slice(-3)).toEqual(['Corredor Norte', 'Portero 24h', false]);
  });

  it('Path 2 com a linha anterior SEM logística: copia null (não inventa)', async () => {
    const { client, chamadas } = cliente({ existing: [linha({ logistics_corridor: null, access_notes: null })], published: ['antiga-1'] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)?.params.slice(-3)).toEqual([null, null, false]);
  });

  it('Path 3 — slot NOVO (displayOrder≠1): insere sem consultar vagas, sem arquivar, sem remapear, is_default=false mesmo sem principal', async () => {
    const { client, chamadas } = cliente({ patientHasDefault: false });
    await replacePatientAddresses(
      PID,
      [endereco({ displayOrder: 2, state: null, city: null, neighborhood: null, addressRaw: 'texto cru' })],
      client,
      geocoder,
    );
    expect(sqlDe(chamadas, /COUNT\(\*\)::text AS count FROM job_postings/)).toBeUndefined();
    expect(sqlDe(chamadas, /SET archived_at = NOW\(\)/)).toBeUndefined();
    expect(sqlDe(chamadas, /UPDATE job_postings/)).toBeUndefined();
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)?.params).toEqual([PID, 'Av. Maipú 1234', 'texto cru', 2, null, null, null, -34.5, -58.5, null, null, false]);
  });

  it('Path 3 — slot 1 SEM principal ativo: nasce is_default=true (regra de nascimento, spec 019)', async () => {
    const { client, chamadas } = cliente({ patientHasDefault: false });
    await replacePatientAddresses(PID, [endereco({ displayOrder: 1 })], client, geocoder);
    const exists = sqlDe(chamadas, /SELECT EXISTS/);
    expect(exists?.params).toEqual([PID]);
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)?.params.at(-1)).toBe(true);
  });

  it('Path 3 — slot 1 mas o paciente JÁ TEM principal ativo (de qualquer origem): nasce is_default=false', async () => {
    const { client, chamadas } = cliente({ patientHasDefault: true });
    await replacePatientAddresses(PID, [endereco({ displayOrder: 1 })], client, geocoder);
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)?.params.at(-1)).toBe(false);
  });

  it('5.5/3.7 — paciente NOVO com 3 slots preenchidos (import ClickUp / caminho latente de PatientNativeCreator): slot 1 nasce is_default=true, slots 2 e 3 false, address_type sempre NULL', async () => {
    const { client, chamadas } = cliente({ patientHasDefault: false });
    await replacePatientAddresses(
      PID,
      [
        endereco({ displayOrder: 1, addressFormatted: 'Domicilio 1' }),
        endereco({ displayOrder: 2, addressFormatted: 'Domicilio 2' }),
        endereco({ displayOrder: 3, addressFormatted: 'Domicilio 3' }),
      ],
      client,
      geocoder,
    );
    const inserts = todos(chamadas, /INSERT INTO patient_addresses/);
    expect(inserts).toHaveLength(3);
    expect(inserts[0].params.at(-1)).toBe(true); // slot 1
    expect(inserts[1].params.at(-1)).toBe(false); // slot 2
    expect(inserts[2].params.at(-1)).toBe(false); // slot 3
    for (const ins of inserts) expect(ins.sql).not.toMatch(/address_type/);
  });

  it('linha anterior com `address_formatted` NULL versiona (null ≠ o texto novo)', async () => {
    const { client, chamadas } = cliente({ existing: [linha({ address_formatted: null })] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    expect(sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = \$1/)).toBeDefined();
  });

  it('slot que SUMIU do payload: arquiva o referenciado e apaga o órfão, numa passada só', async () => {
    const { client, chamadas } = cliente({ existing: [linha(), linha({ id: 'antiga-2', display_order: 2 })] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    const arquiva = sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = ANY/);
    const apaga = sqlDe(chamadas, /^\s*DELETE FROM patient_addresses/);
    expect(arquiva?.params).toEqual([['antiga-2']]);
    expect(apaga?.params).toEqual([['antiga-2']]);
    // Migration 330: endereço apontado por serviço contratado é arquivado, nunca apagado (a FK
    // sem ON DELETE recusaria o DELETE) — os dois comandos consultam a tabela do serviço.
    expect(arquiva?.sql).toMatch(/patient_contracted_services pcs\s+WHERE pcs\.address_id = patient_addresses\.id/);
    expect(apaga?.sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM patient_contracted_services/);
  });

  it('nenhum slot sumiu → não roda nem o arquivamento nem o DELETE em lote', async () => {
    const { client, chamadas } = cliente({ existing: [linha()] });
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    expect(sqlDe(chamadas, /WHERE id = ANY/)).toBeUndefined();
  });

  it('geocodificação sem resultado persiste lat/lng NULL (best-effort, nunca bloqueia)', async () => {
    mockGeocode.mockImplementation(async (addresses: PatientAddress[]) => addresses.map((address) => ({ address, lat: null, lng: null })));
    const { client, chamadas } = cliente();
    await replacePatientAddresses(PID, [endereco()], client, geocoder);
    // lat/lng agora nos índices 7/8 (address_type saiu do INSERT).
    expect(sqlDe(chamadas, /INSERT INTO patient_addresses/)?.params.slice(7, 9)).toEqual([null, null]);
  });

  it('dois slots ao mesmo tempo: cada um segue o SEU caminho', async () => {
    const { client, chamadas } = cliente({ existing: [linha()], published: [] });
    await replacePatientAddresses(PID, [endereco(), endereco({ displayOrder: 2, addressFormatted: 'Calle Nueva 900' })], client, geocoder);
    expect(todos(chamadas, /^UPDATE patient_addresses SET\s+address_formatted/)).toHaveLength(1);
    expect(todos(chamadas, /INSERT INTO patient_addresses/)).toHaveLength(1);
  });

  describe('convivência com linha do painel (source admin_manual)', () => {
    it('linha admin_manual no display_order 4 SOBREVIVE a um sync que só traz slots 1-3: não é arquivada nem apagada', async () => {
      const painel = linha({ id: 'painel-4', display_order: 4, source: 'admin_manual' });
      const { client, chamadas } = cliente({ existing: [painel] });

      await replacePatientAddresses(
        PID,
        [endereco({ displayOrder: 1 }), endereco({ displayOrder: 2 }), endereco({ displayOrder: 3 })],
        client,
        geocoder,
      );

      // O SELECT filtrado nunca devolve a linha do painel — o bloco "gone" (goneIds) é
      // calculado a partir dessa lista, então o id dela não pode aparecer em NENHUM
      // UPDATE (archive) ou DELETE.
      const arquiva = sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = ANY/);
      const apaga = sqlDe(chamadas, /^\s*DELETE FROM patient_addresses/);
      expect(arquiva).toBeUndefined();
      expect(apaga).toBeUndefined();
      for (const c of chamadas) expect(c.params.flat()).not.toContain('painel-4');
    });

    it('linha admin_manual no display_order 1 NÃO é sobrescrita (Path 1) nem arquivada (Path 2) quando o ClickUp traz o slot 1 — os dois convivem', async () => {
      const painel = linha({ id: 'painel-1', display_order: 1, source: 'admin_manual', address_formatted: 'Rua do Painel 1' });
      const { client, chamadas } = cliente({ existing: [painel], patientHasDefault: false });

      await replacePatientAddresses(PID, [endereco({ displayOrder: 1, addressFormatted: 'Av. Maipú 1234' })], client, geocoder);

      // Nenhum UPDATE in-place (Path 1) e nenhum archived_at (Path 2) mira o id do painel —
      // porque o SELECT filtrado nunca o devolveu como `existingForSlot`.
      expect(sqlDe(chamadas, /^UPDATE patient_addresses SET\s+address_formatted/)).toBeUndefined();
      expect(sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = \$1/)).toBeUndefined();
      for (const c of chamadas) expect(c.params.flat()).not.toContain('painel-1');

      // A convivência: o slot 1 do ClickUp vira Path 3 (INSERT novo), sem tocar a linha do
      // painel — os dois passam a existir no MESMO display_order. Como a query EXISTS olha
      // TODOS os endereços ativos do paciente (não só os 'clickup'), e aqui não configuramos
      // nenhum principal, o slot 1 novo nasce principal (regra de nascimento).
      const ins = sqlDe(chamadas, /INSERT INTO patient_addresses/);
      expect(ins?.params).toEqual([PID, 'Av. Maipú 1234', null, 1, 'Buenos Aires', 'Vicente López', 'Florida', -34.5, -58.5, null, null, true]);
    });

    it('linhas `clickup` continuam com o comportamento de sempre: slot que sumiu ainda arquiva/apaga, mesmo com uma linha admin_manual no meio', async () => {
      const painel = linha({ id: 'painel-9', display_order: 9, source: 'admin_manual' });
      const clickupSumiu = linha({ id: 'ck-2', display_order: 2, source: 'clickup' });
      const { client, chamadas } = cliente({ existing: [linha({ source: 'clickup' }), clickupSumiu, painel] });

      await replacePatientAddresses(PID, [endereco({ displayOrder: 1 })], client, geocoder);

      const arquiva = sqlDe(chamadas, /SET archived_at = NOW\(\)\s+WHERE id = ANY/);
      const apaga = sqlDe(chamadas, /^\s*DELETE FROM patient_addresses/);
      // Só a linha clickup que sumiu (ck-2) entra no lote — nem a clickup que ficou (antiga-1,
      // atualizada via Path 1) nem a admin_manual (painel-9, nunca lida).
      expect(arquiva?.params).toEqual([['ck-2']]);
      expect(apaga?.params).toEqual([['ck-2']]);
    });
  });
});

describe('replacePatientProfessionals', () => {
  const pro = (over: Partial<PatientProfessional> = {}): PatientProfessional => ({
    name: 'Dra. Ana', phone: '+5491100000000', email: 'ana@example.com', displayOrder: 1, ...over,
  });

  it('apaga os antigos e insere os válidos com telefone/e-mail cifrados', async () => {
    const { client, chamadas } = cliente();
    await replacePatientProfessionals(PID, [pro()], client);
    expect(chamadas[0].sql).toMatch(/DELETE FROM patient_professionals/);
    expect(sqlDe(chamadas, /INSERT INTO patient_professionals/)?.params).toEqual([PID, 'Dra. Ana', 'enc(+5491100000000)', 'enc(ana@example.com)', 1, false]);
  });

  it('`isTeam` explícito e contato ausente: null cifrado é null, e o default de isTeam é false', async () => {
    const { client, chamadas } = cliente();
    await replacePatientProfessionals(PID, [pro({ phone: null, email: null, isTeam: true })], client);
    expect(sqlDe(chamadas, /INSERT INTO patient_professionals/)?.params).toEqual([PID, 'Dra. Ana', null, null, 1, true]);
  });

  it('nome vazio/em branco/ausente é descartado — lista sem ninguém válido só apaga', async () => {
    const { client, chamadas } = cliente();
    await replacePatientProfessionals(PID, [pro({ name: '   ' }), pro({ name: undefined as unknown as string })], client);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].sql).toMatch(/DELETE FROM patient_professionals/);
  });

  /**
   * 🔒 O CACHE DE COORDENADA (D289, 06/09/2026).
   *
   * A rede de segurança do ClickUp roda a cada 10 min e regravava o endereço de
   * todo paciente que tocasse. Sem cache, cada passagem pagava ao Google para
   * reresponder o que já estava no banco: 132 chamadas/hora, 24h/dia.
   *
   * Estes testes cobrem as DUAS metades. A que economiza, e a que impede o
   * conserto de virar "nunca mais geocodifica" — que é o modo de falha óbvio de
   * um cache que não invalida.
   */
  describe('cache de coordenada já conhecida', () => {
    it('reusa a coordenada do banco quando o texto do endereço NÃO mudou', async () => {
      const { client } = cliente({ existing: [linha({ lat: -34.61, lng: -58.38 })] });

      await replacePatientAddresses(PID, [endereco({ addressFormatted: 'Av. Maipú 1234' })], client, geocoder);

      expect(mockGeocode).toHaveBeenCalledTimes(1);
      const conhecidas = mockGeocode.mock.calls[0][2]?.known as Map<string, { lat: number; lng: number }>;
      expect(conhecidas.get('Av. Maipú 1234')).toEqual({ lat: -34.61, lng: -58.38 });
    });

    it('endereço com texto NOVO não entra no cache — volta a ser geocodificado', async () => {
      // A metade que impede "nunca mais geocodifica": mudou o texto, a chave não
      // bate, o Google responde de novo.
      const { client } = cliente({ existing: [linha({ address_formatted: 'Av. Maipú 1234', lat: -34.61, lng: -58.38 })] });

      await replacePatientAddresses(PID, [endereco({ addressFormatted: 'Calle Nueva 999' })], client, geocoder);

      const conhecidas = mockGeocode.mock.calls[0][2]?.known as Map<string, { lat: number; lng: number }>;
      expect(conhecidas.has('Calle Nueva 999')).toBe(false);
    });

    it('linha do banco SEM coordenada fica fora do cache', async () => {
      // `lat`/`lng` nulos são o estado que o backfill existe para recuperar —
      // colocá-los no cache congelaria o endereço sem pino para sempre.
      const { client } = cliente({ existing: [linha({ lat: null, lng: null })] });

      await replacePatientAddresses(PID, [endereco()], client, geocoder);

      const conhecidas = mockGeocode.mock.calls[0][2]?.known as Map<string, { lat: number; lng: number }>;
      expect(conhecidas.size).toBe(0);
    });

    it('🔒 coordenada ILEGÍVEL fica fora do cache — não vira pino errado', async () => {
      // O banco devolve NUMERIC como string; se vier lixo, `Number()` dá NaN.
      // Um NaN no cache viraria coordenada inválida gravada na ficha do
      // paciente. Fora do cache, ele é geocodificado como sempre.
      const { client } = cliente({ existing: [linha({ lat: 'não-é-número', lng: -58.38 })] });

      await replacePatientAddresses(PID, [endereco()], client, geocoder);

      const conhecidas = mockGeocode.mock.calls[0][2]?.known as Map<string, { lat: number; lng: number }>;
      expect(conhecidas.size).toBe(0);
    });

    it('linha SEM texto de endereço fica fora do cache', async () => {
      const { client } = cliente({ existing: [linha({ address_formatted: '   ', lat: -34.61, lng: -58.38 })] });

      await replacePatientAddresses(PID, [endereco()], client, geocoder);

      const conhecidas = mockGeocode.mock.calls[0][2]?.known as Map<string, { lat: number; lng: number }>;
      expect(conhecidas.size).toBe(0);
    });
  });
});
