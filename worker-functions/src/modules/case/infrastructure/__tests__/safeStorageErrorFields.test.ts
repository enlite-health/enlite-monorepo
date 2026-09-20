import { safeStorageErrorFields } from '../safeStorageErrorFields';

describe('safeStorageErrorFields — conserto da 3ª revisão do PR-4 (item 3)', () => {
  it('extrai code/status/name sem tocar em message/stack', () => {
    const err = Object.assign(new Error('No such object: patient-photos-bucket/uuid-real-do-paciente.jpg'), {
      code: 404,
      response: { status: 404 },
    });
    const fields = safeStorageErrorFields(err);
    expect(fields).toEqual({ code: 404, status: 404, name: 'Error' });
  });

  it('o JSON serializado do resultado NUNCA contém o objectPath que estava na message original', () => {
    const objectPath = 'patient-photos-bucket/uuid-sensivel-do-paciente.jpg';
    const err = Object.assign(new Error(`No such object: ${objectPath}`), { code: 404 });
    const json = JSON.stringify(safeStorageErrorFields(err));
    expect(json).not.toContain(objectPath);
    expect(json).not.toContain('uuid-sensivel-do-paciente');
  });

  it('erro sem code/status/response — devolve undefined nos dois, name da classe', () => {
    const err = new TypeError('boom');
    expect(safeStorageErrorFields(err)).toEqual({ code: undefined, status: undefined, name: 'TypeError' });
  });

  it('valor não-Error (string/objeto solto) — name vira o typeof, sem lançar', () => {
    expect(safeStorageErrorFields('plain string')).toEqual({ code: undefined, status: undefined, name: 'string' });
    expect(safeStorageErrorFields(null)).toEqual({ code: undefined, status: undefined, name: 'object' });
    expect(safeStorageErrorFields(undefined)).toEqual({ code: undefined, status: undefined, name: 'undefined' });
  });
});
