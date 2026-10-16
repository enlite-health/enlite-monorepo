/**
 * EnquadrePresenceService + decidePresence (spec 052, Fase 3, T-34c): quem entrou na call × quem foi convocado.
 * Dublês: Meet (`FakeMeetConference`), repositório em memória e decifrador em passthrough. Nomes SINTÉTICOS "Ficticio NN".
 * Os 5 casos: ligado por nome único · mesmo nome em 2 convocados · anônimo · telefone · ninguém sobrando (`absent`).
 */
import { FakeMeetConference } from '../../infrastructure/doubles/FakeMeetConference';
import { capturingLogger } from '../../infrastructure/doubles/admissionTestKit';
import type { EnquadrePresenceRepository, PresenceConvocadoRow } from '../../infrastructure/EnquadrePresenceRepository';
import type { PresenceVerdict } from '../../domain/enquadrePresence';
import { normalizeDisplayName } from '../../domain/enquadrePresence';
import type { MeetParticipant } from '../ports/MeetConferencePort';
import { EnquadrePresenceService } from '../EnquadrePresenceService';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE = 'spaces/abc-defg-hij';
const RECORD = 'conferenceRecords/rec-1';
const HOST = 'host.ficticio@example.test';

const signedin = (displayName: string, id = displayName): MeetParticipant => ({ kind: 'signedin', displayName, identityKey: `users/${id}` });

function setup(convocados: Array<[string, string, string]>, participants: MeetParticipant[], opts: { fail?: (m: FakeMeetConference) => void } = {}) {
  const meet = new FakeMeetConference();
  meet.setRecords('abc-defg-hij', [{ name: RECORD, startTime: new Date('2026-10-14T12:00:00Z'), endTime: new Date('2026-10-14T12:30:00Z') }]);
  meet.setParticipants(RECORD, participants);
  opts.fail?.(meet);
  const saved: Array<Map<string, PresenceVerdict>> = [];
  const repo = {
    listDueEvents: async () => [{ id: EVENT_ID, host_email: HOST, meet_space_name: SPACE }],
    listConvocados: async (): Promise<PresenceConvocadoRow[]> => convocados.map(([id, first, last]) => ({ id, first_name_encrypted: first, last_name_encrypted: last })),
    save: async (_e: string, v: ReadonlyMap<string, PresenceVerdict>) => void saved.push(new Map(v)),
  } as unknown as EnquadrePresenceRepository;
  const logs = capturingLogger();
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  const db = { connect: jest.fn(async () => client), query: jest.fn() };
  const service = new EnquadrePresenceService({ meet, db: db as never, repo, decryptor: { decrypt: async (c: string | null | undefined) => c ?? '' }, log: logs.log });
  return { service, saved, logs, meet };
}

const unidentifiedLogs = (output: string): Array<Record<string, unknown>> =>
  output.split('\n').filter((l) => l.includes('enquadre.participation.unidentified')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('normalizeDisplayName', () => {
  it('minúsculas, sem acento, espaços colapsados', () => {
    expect(normalizeDisplayName('  FICTÍCIO   Ñandú ')).toBe('ficticio nandu');
    expect(normalizeDisplayName(null)).toBe('');
  });
});

describe('presença do enquadre', () => {
  it('1. ligado por nome único: present + display_name_unique; o outro, sem ninguém sobrando, é absent', async () => {
    const { service, saved } = setup([['c1', 'Ficticio', '01'], ['c2', 'Ficticio', '02']], [signedin('FICTICIO 01')]);
    expect(await service.runOnce()).toEqual({ candidates: 1, measured: 1, failed: 0 });
    expect(saved[0].get('c1')).toEqual({ attendance: 'present', matchMethod: 'display_name_unique' });
    expect(saved[0].get('c2')).toEqual({ attendance: 'absent', matchMethod: null });
  });

  it('2. o mesmo nome em 2 convocados: ninguém é ligado, os dois ficam unidentified e o motivo é name_ambiguous', async () => {
    const { service, saved, logs } = setup([['c1', 'Ficticio', '03'], ['c2', 'Ficticio', '03'], ['c3', 'Ficticio', '04']], [signedin('Ficticio 03')]);
    await service.runOnce();
    expect(saved[0].get('c1')).toEqual({ attendance: 'unidentified', matchMethod: null });
    expect(saved[0].get('c2')).toEqual({ attendance: 'unidentified', matchMethod: null });
    expect(saved[0].get('c3')).toEqual({ attendance: 'unidentified', matchMethod: null });
    const [entry] = unidentifiedLogs(logs.output());
    expect(entry).toMatchObject({ event_id: EVENT_ID, participant_kind: 'signedin', reason: 'name_ambiguous', count: 1 });
  });

  it('3. anônimo nunca é chave, mesmo com o nome igual ao de um convocado: unidentified, motivo anonymous', async () => {
    const { service, saved, logs } = setup([['c1', 'Ficticio', '05']], [{ kind: 'anonymous', displayName: 'Ficticio 05', identityKey: null }]);
    await service.runOnce();
    expect(saved[0].get('c1')).toEqual({ attendance: 'unidentified', matchMethod: null });
    expect(unidentifiedLogs(logs.output())[0]).toMatchObject({ participant_kind: 'anonymous', reason: 'anonymous' });
  });

  it('4. telefone: unidentified, motivo phone', async () => {
    const { service, saved, logs } = setup([['c1', 'Ficticio', '06']], [{ kind: 'phone', displayName: '+54 11 ****-**00', identityKey: null }]);
    await service.runOnce();
    expect(saved[0].get('c1')).toEqual({ attendance: 'unidentified', matchMethod: null });
    expect(unidentifiedLogs(logs.output())[0]).toMatchObject({ participant_kind: 'phone', reason: 'phone' });
  });

  it('5. ninguém sobrando sem dono: o convocado que não entrou é absent (e nenhum log de não identificado)', async () => {
    const { service, saved, logs } = setup([['c1', 'Ficticio', '07'], ['c2', 'Ficticio', '08']], [signedin('Ficticio 07')]);
    await service.runOnce();
    expect(saved[0].get('c2')).toEqual({ attendance: 'absent', matchMethod: null });
    expect(unidentifiedLogs(logs.output())).toHaveLength(0);
  });

  it('quem caiu e voltou (mesmo users/{id} em 2 conferências) conta uma vez', async () => {
    const { service, logs, meet } = setup([['c1', 'Ficticio', '09']], [signedin('Ficticio 99', 'x')]);
    meet.setRecords('abc-defg-hij', [
      { name: RECORD, startTime: new Date('2026-10-14T12:00:00Z'), endTime: new Date('2026-10-14T12:10:00Z') },
      { name: 'conferenceRecords/rec-2', startTime: new Date('2026-10-14T12:12:00Z'), endTime: new Date('2026-10-14T12:30:00Z') },
    ]);
    meet.setParticipants('conferenceRecords/rec-2', [signedin('Ficticio 99', 'x')]);
    await service.runOnce();
    expect(unidentifiedLogs(logs.output())[0]).toMatchObject({ participants: 1, count: 1 });
  });

  it('o log capturado NÃO contém nome de convocado, nome de participante nem users/{id} — com controle positivo de que o log foi capturado', async () => {
    const { service, logs } = setup(
      [['c1', 'Ficticio', 'Sigiloso 10']],
      [signedin('Ficticio Visitante 11', 'idgoogle11'), { kind: 'anonymous', displayName: 'Ficticio Anonimo 12', identityKey: null }, { kind: 'phone', displayName: '+54 9 ****-0013', identityKey: null }],
    );
    await service.runOnce();
    const out = logs.output();
    expect(out).toContain('enquadre.participation.unidentified'); // controle positivo: o log existe e foi capturado
    expect(out).toContain(EVENT_ID);
    for (const secret of ['Sigiloso', 'Visitante', 'Anonimo', 'idgoogle11', 'users/', '0013', HOST]) expect(out).not.toContain(secret);
  });

  it('falha do Meet NÃO derruba: nada é gravado (presença NULL), o motivo vai ao log e a rodada segue', async () => {
    const { service, saved, logs } = setup([['c1', 'Ficticio', '14']], [], { fail: (m) => m.scopeMissing() });
    expect(await service.runOnce()).toEqual({ candidates: 1, measured: 0, failed: 1 });
    expect(saved).toHaveLength(0);
    expect(logs.output()).toContain('enquadre.presence.meet_failed');
    expect(logs.output()).toContain('meet_scope_missing');
  });
});
