/**
 * clickup-4.2-device-type-repository.test.ts — o conjunto de `Tipo de Dispositivo`.
 *
 * O que estes testes protegem, e por quê:
 *   1. `readable:false` NÃO apaga (D167/F41) — renomear o campo no ClickUp não pode esvaziar
 *      o dispositivo de 253 pacientes com log verde.
 *   2. Rótulo que o ConceptMap não conhece vai para QUARENTENA, não para um `23503` no meio
 *      do webhook. A coluna tem FK (migration 287): valor desconhecido não é dado ruim, é
 *      exceção de banco derrubando o sync do paciente inteiro.
 *   3. Dois rótulos que caem no MESMO código viram uma linha só — a PK recusaria, e recusar
 *      aqui com motivo é o que faz a contagem bater.
 *   4. C1 do `lex`: nenhum rótulo em log. Sai campo, contagem e motivo.
 *
 * ⚠️ Nenhum teste aqui toca banco: o pool é dublê e as queries são inspecionadas.
 */

const mockConnect = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: jest.fn() }),
    }),
  },
}));

import { PatientDeviceTypeRepository } from '@modules/case';

const PACIENTE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** ConceptMap de mentira, com os 5 rótulos reais medidos no catálogo vivo (migration 287). */
const ALIASES = [
  { label: 'Domiciliario',  code: 'HOME' },
  { label: 'Escolar',       code: 'SCHOOL' },
  { label: 'Institucional', code: 'INSTITUTIONAL' },
  { label: 'Internación',   code: 'INPATIENT' },
  { label: 'Traslado',      code: 'TRANSPORT' },
];

interface Chamada { sql: string; params: unknown[] }

function dubleDeCliente(): { cli: { query: jest.Mock; release: jest.Mock }; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes('device_type_aliases')) return { rows: ALIASES, rowCount: ALIASES.length };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('PatientDeviceTypeRepository.replaceForPatient', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('origem ILEGÍVEL não escreve e não apaga (D167/F41)', async () => {
    const { cli } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: false, reason: 'field_renamed' },
    });

    expect(r.outcome).toBe('skipped-unreadable');
    // A prova é a AUSÊNCIA de qualquer query: nem DELETE, nem INSERT, nem conexão pedida.
    expect(mockConnect).not.toHaveBeenCalled();
    expect(cli.query).not.toHaveBeenCalled();
  });

  it('traduz os rótulos para o ENUM em inglês e substitui o conjunto', async () => {
    const { cli, chamadas } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: true, labels: ['Escolar', 'Domiciliario'] },
    });

    expect(r.outcome).toBe('written');
    expect(r.accepted).toEqual(['SCHOOL', 'HOME']);   // ordem da ORIGEM, não do catálogo
    const inserts = chamadas.filter(c => c.sql.includes('INSERT INTO patient_device_types'));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(i => i.params[1])).toEqual(['SCHOOL', 'HOME']);
    // O conjunto é SUBSTITUÍDO, não acrescentado.
    expect(chamadas.some(c => c.sql.includes('DELETE FROM patient_device_types'))).toBe(true);
    // E o escalar NÃO é tocado aqui: quem o calcula é o trigger da migration 290 (F64).
    expect(chamadas.some(c => /UPDATE\s+patients/i.test(c.sql))).toBe(false);
  });

  it('rótulo fora do ConceptMap vai para QUARENTENA, e o paciente segue gravado', async () => {
    const { cli, chamadas } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: true, labels: ['Domiciliario', 'Domiciliario Nocturno'] },
    });

    expect(r.accepted).toEqual(['HOME']);
    expect(r.rejected).toEqual([{ reason: 'unmapped' }]);
    expect(r.quarantined).toBe(1);

    const quarentena = chamadas.filter(c => c.sql.includes('patient_source_labels'));
    expect(quarentena).toHaveLength(1);
    // O nome do campo é literal no SQL (não é parâmetro), então é lá que se confere.
    expect(quarentena[0].sql).toContain("'Tipo de Dispositivo'");
    expect(quarentena[0].params[0]).toBe(PACIENTE);
    expect(quarentena[0].params[1]).toBe(1);                     // ordinal começa em 1
    // 🔒 O rótulo desconhecido é PRESERVADO na quarentena — é o dado que a operação criou.
    expect(quarentena[0].params[2]).toBe('Domiciliario Nocturno');
    expect(quarentena[0].params[3]).toBe('clickup-quarentena');
  });

  it('dois rótulos para o mesmo código viram UMA linha, com motivo', async () => {
    const { cli, chamadas } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: true, labels: ['Domiciliario', 'Domiciliario'] },
    });

    expect(r.accepted).toEqual(['HOME']);
    expect(r.rejected).toEqual([{ reason: 'duplicate' }]);
    expect(chamadas.filter(c => c.sql.includes('INSERT INTO patient_device_types'))).toHaveLength(1);
  });

  it('lista de PERMISSÃO: número, booleano, array e vazio caem como `blank` (C5)', async () => {
    const { cli } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: true, labels: [0, false, [], {}, '', '   ', 'Traslado'] as unknown[] },
    });

    expect(r.accepted).toEqual(['TRANSPORT']);
    expect(r.rejected).toHaveLength(6);
    expect(r.rejected.every(x => x.reason === 'blank')).toBe(true);
  });

  it('C1 do `lex`: o log NÃO carrega rótulo nenhum — só campo, contagem e motivo', async () => {
    const { cli } = dubleDeCliente();
    mockConnect.mockResolvedValue(cli);

    await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PACIENTE,
      read: { readable: true, labels: ['Internación', 'Rótulo Clínico Secreto'] },
    });

    const logado = warn.mock.calls.map(c => JSON.stringify(c)).join('\n');
    expect(logado).toContain('Tipo de Dispositivo');   // o NOME do campo pode
    expect(logado).toContain('unmapped');              // o MOTIVO pode
    expect(logado).not.toContain('Rótulo Clínico Secreto');
    // `Internación` → INPATIENT revela regime de cuidado: o rótulo não sai nem quando aceito.
    expect(logado).not.toContain('Internación');
  });
});
