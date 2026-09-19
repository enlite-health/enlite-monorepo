/**
 * RegistrarDocumentoPacienteAnaCareUseCase.test.ts
 *
 * Cenários:
 *  1. Caminho feliz — paciente sem documento registrado → insere e devolve `status: 'registrado'`.
 *  2. `anaCarePatientId` ausente → `AnaCarePatientIdAusenteError`, sem chamar `insert`.
 *  3. `documentNumber` inválido (curto, string 'null' literal) → `DocumentoInvalidoError`, sem
 *     chamar `insert`.
 *  4. Já existe registro com o MESMO número (normalizado) → idempotente, `status: 'ja_registrado'`,
 *     sem chamar `insert`.
 *  5. Já existe registro com número DIFERENTE → `DocumentoJaRegistradoDivergenteError` (409), sem
 *     chamar `insert`.
 *  6. Corrida: `findByPatientId` não achou nada, mas `insert` estoura 23505 (outra requisição
 *     venceu) — reconsulta e decide idempotente/divergente pelo vencedor, nunca deixa o erro cru
 *     escapar.
 */

import {
  RegistrarDocumentoPacienteAnaCareUseCase,
  AnaCarePatientIdAusenteError,
  DocumentoInvalidoError,
  DocumentoJaRegistradoDivergenteError,
} from '../RegistrarDocumentoPacienteAnaCareUseCase';
import type {
  AnaCarePatientDocumentRecord,
  IAnaCarePatientDocumentRepository,
} from '../../domain/IAnaCarePatientDocumentRepository';

function makeRepository(
  overrides: Partial<jest.Mocked<IAnaCarePatientDocumentRepository>> = {},
): jest.Mocked<IAnaCarePatientDocumentRepository> {
  return {
    findByPatientId: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockImplementation((params) =>
      Promise.resolve({
        id: 'doc-1',
        anaCarePatientId: params.anaCarePatientId,
        documentNumber: params.documentNumber,
        documentType: params.documentType,
        registeredBy: params.registeredBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as AnaCarePatientDocumentRecord),
    ),
    ...overrides,
  };
}

const EXISTING: AnaCarePatientDocumentRecord = {
  id: 'doc-existente',
  anaCarePatientId: 'ac-paciente-1',
  documentNumber: '30111222',
  documentType: 'DNI',
  registeredBy: 'uid-outro-staff',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

describe('RegistrarDocumentoPacienteAnaCareUseCase', () => {
  it('caminho feliz — paciente sem registro, insere e devolve registrado', async () => {
    const repository = makeRepository();
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    const result = await useCase.execute({
      anaCarePatientId: 'ac-paciente-1',
      documentNumber: '30.111.222',
      documentType: 'DNI',
      registeredBy: 'uid-staff-1',
    });

    expect(result.status).toBe('registrado');
    expect(repository.insert).toHaveBeenCalledWith({
      anaCarePatientId: 'ac-paciente-1',
      documentNumber: '30111222',
      documentType: 'DNI',
      registeredBy: 'uid-staff-1',
    });
  });

  it('anaCarePatientId ausente → AnaCarePatientIdAusenteError, sem chamar insert', async () => {
    const repository = makeRepository();
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    await expect(
      useCase.execute({ anaCarePatientId: '', documentNumber: '30111222', registeredBy: 'uid-1' }),
    ).rejects.toBeInstanceOf(AnaCarePatientIdAusenteError);
    expect(repository.findByPatientId).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['ausente', ''],
    ['string literal null', 'null'],
    ['curto demais', '123'],
  ])('documentNumber inválido (%s) → DocumentoInvalidoError, sem chamar insert', async (_label, documentNumber) => {
    const repository = makeRepository();
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    await expect(
      useCase.execute({ anaCarePatientId: 'ac-paciente-1', documentNumber, registeredBy: 'uid-1' }),
    ).rejects.toBeInstanceOf(DocumentoInvalidoError);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('já registrado com o MESMO número (normalizado) → idempotente, sem chamar insert', async () => {
    const repository = makeRepository({ findByPatientId: jest.fn().mockResolvedValue(EXISTING) });
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    const result = await useCase.execute({
      anaCarePatientId: 'ac-paciente-1',
      documentNumber: '30.111.222', // mesmo DNI, formatado diferente — normaliza igual
      registeredBy: 'uid-staff-2',
    });

    expect(result).toEqual({ status: 'ja_registrado', record: EXISTING });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('já registrado com número DIFERENTE → DocumentoJaRegistradoDivergenteError (409), sem chamar insert', async () => {
    const repository = makeRepository({ findByPatientId: jest.fn().mockResolvedValue(EXISTING) });
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    const promise = useCase.execute({
      anaCarePatientId: 'ac-paciente-1',
      documentNumber: '40999888',
      registeredBy: 'uid-staff-2',
    });

    await expect(promise).rejects.toBeInstanceOf(DocumentoJaRegistradoDivergenteError);
    expect(repository.insert).not.toHaveBeenCalled();
    try {
      await promise;
    } catch (err) {
      expect((err as DocumentoJaRegistradoDivergenteError).existente).toEqual(EXISTING);
    }
  });

  it('corrida — findByPatientId não achou nada, insert estoura 23505, reconsulta e decide pelo vencedor (mesmo número → idempotente)', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const repository = makeRepository({
      findByPatientId: jest
        .fn()
        .mockResolvedValueOnce(null) // guard 2 — nada achado
        .mockResolvedValueOnce(EXISTING), // reconsulta pós-23505 — o vencedor da corrida
      insert: jest.fn().mockRejectedValue(pgError),
    });
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    const result = await useCase.execute({
      anaCarePatientId: 'ac-paciente-1',
      documentNumber: EXISTING.documentNumber,
      registeredBy: 'uid-staff-3',
    });

    expect(result).toEqual({ status: 'ja_registrado', record: EXISTING });
    expect(repository.findByPatientId).toHaveBeenCalledTimes(2);
  });

  it('corrida — 23505 e o vencedor tem número DIFERENTE → DocumentoJaRegistradoDivergenteError', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const repository = makeRepository({
      findByPatientId: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING),
      insert: jest.fn().mockRejectedValue(pgError),
    });
    const useCase = new RegistrarDocumentoPacienteAnaCareUseCase(repository);

    await expect(
      useCase.execute({
        anaCarePatientId: 'ac-paciente-1',
        documentNumber: '40999888',
        registeredBy: 'uid-staff-3',
      }),
    ).rejects.toBeInstanceOf(DocumentoJaRegistradoDivergenteError);
  });
});
