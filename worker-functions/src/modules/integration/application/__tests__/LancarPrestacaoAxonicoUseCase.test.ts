/**
 * LancarPrestacaoAxonicoUseCase.test.ts — F3 da change `integracao-axonico`.
 *
 * REGRA DURA (não negociável): NENHUM teste desta suíte instancia `AxonicoApiClient` (o cliente
 * HTTP concreto) nem chama `fetch`. As três dependências do use case são SEMPRE
 * `jest.Mocked<Interface>` — `IPatientReadPort`, `IAxonicoApiClient`, `IAxonicoLancamentoRepository`.
 * Nenhum destes testes toca a API real do Axonico (`api.apiws.axonico.ar` e afins).
 *
 * Cenários (tasks.md §3 "Termina quando", F3):
 *  1. `document_number IS NULL` → recusado sem nenhuma chamada ao `IAxonicoApiClient`.
 *  2. `hours` não-inteiro (2.5) → recusado sem nenhuma chamada ao `IAxonicoApiClient`.
 *  3. `hours` acima do teto de `cantidad_max_prestaciones` → recusado sem chamar `findPatientByDni`/
 *     `checkExistingComprobante`/`submitComprobante`.
 *  4. Leitura do teto indisponível (mock lança OU `cantidad_max_prestaciones` ausente) → recusado
 *     sem nenhuma chamada a `submitComprobante` (D371).
 *  5. Lançamento já `enviado` na tabela (dedupe local, guard 2 — roda ANTES do teto) → `duplicado`
 *     com o comprovante ORIGINAL, sem nenhuma chamada a `getCantidadMaxPrestaciones`/
 *     `findPatientByDni`/`checkExistingComprobante`/`submitComprobante`.
 *  6. Tipo sem mapeamento (`CAREGIVER`) → recusado antes de qualquer chamada de rede (exceto o
 *     guard 3 — teto — que já rodou antes do guard de mapeamento).
 *  7. Falha de `submitComprobante` → grava `status='erro'` com `error_message`, relança, e NÃO
 *     repete a chamada.
 *  + Caminho feliz (não listado como um dos 7, mas é a prova positiva cruzada dos testes de "zero
 *    chamadas": mostra que os MESMOS métodos do mock SÃO registrados quando efetivamente chamados).
 *  + `patientId` inexistente (variação do guard 0 — `findDocumentNumber` devolve `null`, não
 *    `{ documentNumber: null }`).
 *  + Dedupe remoto devolvendo `numeroComprobante: null` e `lancadoEm` igual ao `createdAt` da linha
 *    `duplicado` recém-inserida (o comprovante foi criado fora do nosso registro).
 */

import {
  LancarPrestacaoAxonicoUseCase,
  LancarPrestacaoAxonicoInput,
  PacienteSemDniError,
  HoraQuebradaError,
  AxonicoTetoIndisponivelError,
  AxonicoTetoExcedidoError,
  AxonicoPacienteNaoEncontradoError,
  AxonicoLancamentoConcorrenteError,
} from '../LancarPrestacaoAxonicoUseCase';
import type { IPatientReadPort } from '../../domain/IPatientReadPort';
import type { IAxonicoApiClient, AxonicoPatientMatch } from '../../domain/IAxonicoApiClient';
import type { IAxonicoLancamentoRepository, AxonicoLancamentoRecord } from '../../domain/IAxonicoLancamentoRepository';
import { AxonicoUnmappedServiceTypeError } from '../../infrastructure/AxonicoServiceMapping';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger: mockLogger } = require('@shared/logging') as {
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
};

// ── Helpers ──────────────────────────────────────────────────────

const PATIENT_ID = 'patient-uuid-1';
const DNI = '30111222';
const SERVICE_DATE = '2026-09-18'; // dia civil como STRING 'YYYY-MM-DD' — nunca Date

function makeInput(overrides: Partial<LancarPrestacaoAxonicoInput> = {}): LancarPrestacaoAxonicoInput {
  return {
    patientId: PATIENT_ID,
    serviceType: 'AT',
    serviceDate: SERVICE_DATE,
    hours: 4,
    ...overrides,
  };
}

const PATIENT_MATCH: AxonicoPatientMatch = {
  historiaClinica: 'hc-123',
  nroCobertura: 'cob-456',
};

function makePatientReadPort(documentNumber: string | null = DNI): jest.Mocked<IPatientReadPort> {
  return {
    findDocumentNumber: jest.fn().mockResolvedValue({ documentNumber }),
  };
}

function makeAxonicoApiClient(overrides: Partial<jest.Mocked<IAxonicoApiClient>> = {}): jest.Mocked<IAxonicoApiClient> {
  return {
    findPatientByDni: jest.fn().mockResolvedValue(PATIENT_MATCH),
    checkExistingComprobante: jest.fn().mockResolvedValue(false),
    submitComprobante: jest.fn().mockResolvedValue({ numeroComprobante: 'nc-1', codAutorizacion: 'ca-1' }),
    getCantidadMaxPrestaciones: jest.fn().mockResolvedValue(24),
    ...overrides,
  };
}

function makeLancamentoRepository(
  overrides: Partial<jest.Mocked<IAxonicoLancamentoRepository>> = {},
): jest.Mocked<IAxonicoLancamentoRepository> {
  return {
    findExisting: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockImplementation((params) =>
      Promise.resolve({ id: 'lanc-1', ...params, createdAt: new Date() } as AxonicoLancamentoRecord),
    ),
    ...overrides,
  };
}

// ── Testes ───────────────────────────────────────────────────────

describe('LancarPrestacaoAxonicoUseCase', () => {
  describe('caminho feliz — envio com sucesso', () => {
    it('resolve DNI, confere teto, dedupe local e remoto, envia, e grava status=enviado', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const result = await useCase.execute(makeInput({ hours: 4 }));

      expect(result).toEqual({ status: 'enviado', numeroComprobante: 'nc-1', codAutorizacion: 'ca-1' });

      // Prova positiva: TODOS os métodos do mock IAxonicoApiClient são chamados exatamente 1 vez
      // no caminho feliz — esta é a referência cruzada citada pelos testes de "zero chamadas"
      // abaixo, que provam que o MESMO conjunto de métodos, no MESMO mock, registraria uma
      // chamada se ela tivesse ocorrido.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledWith(DNI);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledWith(
        expect.objectContaining({ cantidad: 4, historiaClinica: 'hc-123', nroCobertura: 'cob-456' }),
      );

      expect(lancamentoRepository.findExisting).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.findExisting).toHaveBeenCalledWith(DNI, 'AT', '2026-09-18');
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: '2026-09-18',
        hours: 4,
        numeroComprobante: 'nc-1',
        codAutorizacion: 'ca-1',
        status: 'enviado',
        errorMessage: null,
      });
    });
  });

  describe('guard 0 — DNI presente', () => {
    it('document_number IS NULL: recusa com PacienteSemDniError sem nenhuma chamada ao IAxonicoApiClient', async () => {
      const patientReadPort = makePatientReadPort(null);
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(PacienteSemDniError);

      // Contagem zero — prova de "não chamou", não de "não mediu".
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);

      // Prova positiva NESTE MESMO teste: a porta de paciente (o outro mock injetado) FOI
      // chamada — mostra que os mocks do teste registram chamadas normalmente, não que estão
      // "mudos" por configuração. A prova cruzada de que o IAxonicoApiClient especificamente
      // registraria uma chamada está no teste "caminho feliz" acima (mesmos 4 métodos, 1x cada).
      expect(patientReadPort.findDocumentNumber).toHaveBeenCalledTimes(1);
      expect(patientReadPort.findDocumentNumber).toHaveBeenCalledWith(PATIENT_ID);
    });

    it('paciente inexistente (findDocumentNumber devolve null): mesma recusa, sem chamada ao IAxonicoApiClient', async () => {
      const patientReadPort: jest.Mocked<IPatientReadPort> = {
        findDocumentNumber: jest.fn().mockResolvedValue(null),
      };
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(PacienteSemDniError);

      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
      // Prova positiva local: o mock da porta registrou a chamada que de fato ocorreu.
      expect(patientReadPort.findDocumentNumber).toHaveBeenCalledTimes(1);
    });

    it("document_number é a string literal 'null' (medido em produção, 19 pacientes): recusa com PacienteSemDniError(reason='invalid_document'), sem nenhuma chamada ao IAxonicoApiClient", async () => {
      const patientReadPort = makePatientReadPort('null');
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const rejection = useCase.execute(makeInput());
      await expect(rejection).rejects.toThrow(PacienteSemDniError);
      await rejection.catch((err: PacienteSemDniError) => {
        expect(err.reason).toBe('invalid_document');
      });

      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });

    it('document_number com 6 dígitos (curto demais para DNI): recusa com PacienteSemDniError(reason=\'invalid_document\'), sem chamada ao IAxonicoApiClient', async () => {
      const patientReadPort = makePatientReadPort('123456');
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(PacienteSemDniError);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });
  });

  describe('guard 1 — hora cheia (D366)', () => {
    it('hours=2.5 (não-inteiro): recusa com HoraQuebradaError sem nenhuma chamada ao IAxonicoApiClient', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ hours: 2.5 }))).rejects.toThrow(HoraQuebradaError);

      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);

      // Prova positiva NESTE teste: guard 0 rodou antes e chamou a porta de paciente — mostra que
      // o mock geral está "vivo". A prova cruzada específica do IAxonicoApiClient (mesmos 4
      // métodos que aqui ficaram em 0) é o teste "caminho feliz", que os chama 1x cada.
      expect(patientReadPort.findDocumentNumber).toHaveBeenCalledTimes(1);
    });

    it('hours=0: recusa com HoraQuebradaError sem chamada ao IAxonicoApiClient', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ hours: 0 }))).rejects.toThrow(HoraQuebradaError);
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });
  });

  describe('guard 3 — teto de cantidad_max_prestaciones (D371)', () => {
    it('hours acima do teto: recusa com AxonicoTetoExcedidoError sem chamar findPatientByDni/checkExistingComprobante/submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        getCantidadMaxPrestaciones: jest.fn().mockResolvedValue(24),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ hours: 30 }))).rejects.toThrow(AxonicoTetoExcedidoError);

      // Prova positiva NESTE MESMO teste: getCantidadMaxPrestaciones (do MESMO objeto mockado
      // IAxonicoApiClient cujos outros métodos afirmamos em 0) FOI chamado — prova direta de que
      // o mock registra chamadas, sem depender de outro teste.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });

    it('leitura do teto indisponível (getCantidadMaxPrestaciones lança): recusa sem nenhuma chamada a submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        getCantidadMaxPrestaciones: jest.fn().mockRejectedValue(new Error('timeout Axonico')),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ hours: 4 }))).rejects.toThrow(AxonicoTetoIndisponivelError);

      // Prova positiva NESTE MESMO teste: getCantidadMaxPrestaciones FOI chamado (é ele quem
      // lançou o erro) — mesmo mock, mesmo objeto, prova direta.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });

    it('leitura do teto indisponível — mock rejeita com valor não-Error: cobre o ramo String(err) de AxonicoTetoIndisponivelError', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        getCantidadMaxPrestaciones: jest.fn().mockRejectedValue('timeout cru, sem Error'),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(AxonicoTetoIndisponivelError);
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });

    it('cantidad_max_prestaciones ausente do corpo (getCantidadMaxPrestaciones devolve null): recusa sem submitComprobante, nunca usa número cravado', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        getCantidadMaxPrestaciones: jest.fn().mockResolvedValue(null),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ hours: 4 }))).rejects.toThrow(AxonicoTetoIndisponivelError);

      // Prova positiva NESTE MESMO teste.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });
  });

  describe('guard 2 — dedupe local (nossa tabela primeiro, roda ANTES do teto)', () => {
    it('lançamento já enviado na tabela: devolve duplicado com o comprovante ORIGINAL, sem nenhuma chamada a getCantidadMaxPrestaciones/findPatientByDni/checkExistingComprobante/submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const existingCreatedAt = new Date(2026, 8, 10);
      const existingRecord: AxonicoLancamentoRecord = {
        id: 'lanc-existing',
        patientId: PATIENT_ID,
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: '2026-09-18',
        hours: 4,
        numeroComprobante: 'nc-old',
        codAutorizacion: 'ca-old',
        status: 'enviado',
        errorMessage: null,
        createdAt: existingCreatedAt,
      };
      const lancamentoRepository = makeLancamentoRepository({
        findExisting: jest.fn().mockResolvedValue(existingRecord),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const result = await useCase.execute(makeInput());

      expect(result).toEqual({
        status: 'duplicado',
        jaFaturado: true,
        numeroComprobante: 'nc-old',
        codAutorizacion: 'ca-old',
        lancadoEm: existingCreatedAt,
      });

      // ESTA É A MUDANÇA: hoje o teto (rede) rodava ANTES do dedupe local, e um item já faturado
      // virava AxonicoTetoIndisponivelError num reprocessamento com o Axonico instável. Agora o
      // dedupe local roda primeiro — zero chamadas a QUALQUER método de rede, inclusive o teto.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).not.toHaveBeenCalled();
      expect(axonicoApiClient.findPatientByDni).not.toHaveBeenCalled();
      expect(axonicoApiClient.checkExistingComprobante).not.toHaveBeenCalled();
      expect(axonicoApiClient.submitComprobante).not.toHaveBeenCalled();

      expect(lancamentoRepository.findExisting).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'duplicado', errorMessage: null }),
      );
    });
  });

  describe('guard 3 (prova positiva cruzada) — teto rodando após o dedupe local não achar nada', () => {
    it('caminho feliz (prova positiva): getCantidadMaxPrestaciones/findPatientByDni/checkExistingComprobante/submitComprobante SÃO chamados quando o dedupe local não acha nada — referenciado pelo teste de zero-chamadas do guard 2 acima', async () => {
      // Referência: este é o mesmo teste "caminho feliz" declarado no topo do arquivo — os 4
      // métodos do IAxonicoApiClient são chamados exatamente 1x cada, provando que o mock não
      // está morto e que os `not.toHaveBeenCalled()` do guard 2 são prova real, não silêncio.
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await useCase.execute(makeInput({ hours: 4 }));

      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);
    });
  });

  describe('guard 4a — tipo sem mapeamento (CAREGIVER, D372)', () => {
    it('CAREGIVER: recusa com AxonicoUnmappedServiceTypeError antes de qualquer chamada de rede, exceto getCantidadMaxPrestaciones (guard 3 — teto —, que roda antes)', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput({ serviceType: 'CAREGIVER' }))).rejects.toThrow(
        AxonicoUnmappedServiceTypeError,
      );

      // Prova positiva NESTE MESMO teste: getCantidadMaxPrestaciones FOI chamado (guard 3 — teto —
      // roda antes do guard de mapeamento) — mesmo mock cujos 3 outros métodos ficam em 0.
      expect(axonicoApiClient.getCantidadMaxPrestaciones).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      // Tipo sem mapeamento não grava linha (não houve tentativa real contra o Axonico).
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(0);
    });
  });

  describe('dedupe remoto (3b) — cobertura das ramificações não listadas nos 7 casos, mas exercitadas pelo código escrito', () => {
    it('findPatientByDni não encontra o paciente no Axonico: grava status=erro (AxonicoPacienteNaoEncontradoError) e relança, sem chamar checkExistingComprobante/submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        findPatientByDni: jest.fn().mockResolvedValue(null),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(AxonicoPacienteNaoEncontradoError);

      expect(axonicoApiClient.findPatientByDni).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(0);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'erro', errorMessage: expect.stringContaining('não encontrou paciente') }),
      );
    });

    it('checkExistingComprobante lança valor não-Error: gravaErro cobre o ramo String(err)', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        checkExistingComprobante: jest.fn().mockRejectedValue('falha crua, sem Error'),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toBe('falha crua, sem Error');

      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'erro', errorMessage: 'falha crua, sem Error' }),
      );
    });

    it('checkExistingComprobante lança: grava status=erro e relança, sem chamar submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const checkError = new Error('Axonico 500 — falha no filtro de comprobante');
      const axonicoApiClient = makeAxonicoApiClient({
        checkExistingComprobante: jest.fn().mockRejectedValue(checkError),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(checkError);

      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'erro', errorMessage: checkError.message }),
      );
    });

    it('checkExistingComprobante encontra comprobante existente no Axonico (dedupe remoto): devolve duplicado SEM o comprovante (numeroComprobante/codAutorizacion null), lancadoEm = createdAt da linha duplicado recém-inserida, grava status=duplicado, sem chamar submitComprobante', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient({
        checkExistingComprobante: jest.fn().mockResolvedValue(true),
      });
      const insertedCreatedAt = new Date(2026, 8, 18, 10, 30);
      const lancamentoRepository = makeLancamentoRepository({
        insert: jest.fn().mockImplementation((params) =>
          Promise.resolve({ id: 'lanc-duplicado-remoto', ...params, createdAt: insertedCreatedAt } as AxonicoLancamentoRecord),
        ),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const result = await useCase.execute(makeInput());

      expect(result).toEqual({
        status: 'duplicado',
        jaFaturado: true,
        numeroComprobante: null,
        codAutorizacion: null,
        lancadoEm: insertedCreatedAt,
      });
      expect(axonicoApiClient.checkExistingComprobante).toHaveBeenCalledTimes(1);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(0);
      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'duplicado', errorMessage: null }),
      );
    });
  });

  describe('falha de submitComprobante (D368 — sem retry)', () => {
    it('submitComprobante rejeita: grava status=erro com error_message, relança o erro original, e não repete a chamada', async () => {
      const patientReadPort = makePatientReadPort();
      const submitError = new Error('Axonico 500 — falha ao gravar comprobante');
      const axonicoApiClient = makeAxonicoApiClient({
        submitComprobante: jest.fn().mockRejectedValue(submitError),
      });
      const lancamentoRepository = makeLancamentoRepository();
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(submitError);

      // submitComprobante foi chamado — e SÓ UMA VEZ (nunca duas, D368: sem retry automático).
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);

      expect(lancamentoRepository.insert).toHaveBeenCalledTimes(1);
      expect(lancamentoRepository.insert).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: '2026-09-18',
        hours: 4,
        numeroComprobante: null,
        codAutorizacion: null,
        status: 'erro',
        errorMessage: submitError.message,
      });
    });
  });

  describe('Conserto 1 — insert do enviado sem proteção (F3, 18/09/2026)', () => {
    it('submitComprobante dá certo mas o insert de status=enviado rejeita: relança, loga ERROR com numeroComprobante, e NÃO chama submitComprobante de novo', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const insertError = new Error('pool caído — connection terminated');
      const lancamentoRepository = makeLancamentoRepository({
        insert: jest.fn().mockRejectedValue(insertError),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toThrow(insertError);

      // submitComprobante JÁ FATUROU no Axonico e foi chamado exatamente 1× — não repete.
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      const logCall = mockLogger.error.mock.calls[0][0];
      expect(logCall).toEqual(
        expect.objectContaining({
          numeroComprobante: 'nc-1',
          codAutorizacion: 'ca-1',
          patientId: PATIENT_ID,
          serviceType: 'AT',
          serviceDate: '2026-09-18',
          hours: 4,
          errorMessage: insertError.message,
        }),
      );
      expect(String(logCall.msg)).toMatch(/FOI CRIADO no Axonico/i);
    });

    it('submitComprobante dá certo mas o insert de status=enviado rejeita com um valor que NÃO é Error (ex.: string): loga ERROR com errorMessage=String(err), e relança o mesmo valor não-Error', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const lancamentoRepository = makeLancamentoRepository({
        insert: jest.fn().mockRejectedValue('boom'),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      // `mockLogger` é module-level (sem clearMocks no jest.config.js) — o teste anterior deste
      // mesmo describe já chamou logger.error 1×; limpar aqui para isolar esta asserção sem
      // tocar no teste vizinho.
      mockLogger.error.mockClear();

      await expect(useCase.execute(makeInput())).rejects.toBe('boom');

      // submitComprobante JÁ FATUROU no Axonico e foi chamado exatamente 1× — não repete.
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      const logCall = mockLogger.error.mock.calls[0][0];
      expect(logCall).toEqual(
        expect.objectContaining({
          numeroComprobante: 'nc-1',
          codAutorizacion: 'ca-1',
          patientId: PATIENT_ID,
          serviceType: 'AT',
          serviceDate: '2026-09-18',
          hours: 4,
          errorMessage: 'boom',
        }),
      );
      expect(String(logCall.msg)).toMatch(/FOI CRIADO no Axonico/i);
    });
  });

  describe('Correção 18/09/2026 — dedupe por documentNumber (DNI), não patientId', () => {
    it('dois patientId distintos, MESMO documentNumber: o segundo é bloqueado pelo dedupe local (guard 2) mesmo com patientId diferente do primeiro', async () => {
      const OUTRO_PATIENT_ID = 'patient-uuid-2';
      const patientReadPort = makePatientReadPort(DNI); // mesmo DNI do primeiro paciente
      const axonicoApiClient = makeAxonicoApiClient();
      const existingCreatedAt = new Date(2026, 8, 18);
      const existingRecord: AxonicoLancamentoRecord = {
        id: 'lanc-existing',
        patientId: PATIENT_ID, // gravado pelo PRIMEIRO paciente
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: SERVICE_DATE,
        hours: 4,
        numeroComprobante: 'nc-primeiro',
        codAutorizacion: 'ca-primeiro',
        status: 'enviado',
        errorMessage: null,
        createdAt: existingCreatedAt,
      };
      const lancamentoRepository = makeLancamentoRepository({
        findExisting: jest.fn().mockResolvedValue(existingRecord),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      // SEGUNDO paciente (patientId diferente), mesmo DNI, mesmo serviceType/serviceDate.
      const result = await useCase.execute(makeInput({ patientId: OUTRO_PATIENT_ID }));

      expect(result).toEqual({
        status: 'duplicado',
        jaFaturado: true,
        numeroComprobante: 'nc-primeiro',
        codAutorizacion: 'ca-primeiro',
        lancadoEm: existingCreatedAt,
      });
      // O dedupe é por documentNumber — zero rede, mesmo o patientId sendo outro.
      expect(axonicoApiClient.submitComprobante).not.toHaveBeenCalled();
      expect(lancamentoRepository.findExisting).toHaveBeenCalledWith(DNI, 'AT', SERVICE_DATE);
    });
  });

  describe('item 1.3 — 23505 no INSERT final vira AxonicoLancamentoConcorrenteError (corrida entre guard 2 e o INSERT)', () => {
    it('guard 2 não acha nada, mas o INSERT de status=enviado estoura 23505 (corrida): lança AxonicoLancamentoConcorrenteError com os DOIS comprovantes', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const existingCreatedAt = new Date(2026, 8, 18, 12, 0);
      const winnerRecord: AxonicoLancamentoRecord = {
        id: 'lanc-winner',
        patientId: PATIENT_ID,
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: SERVICE_DATE,
        hours: 4,
        numeroComprobante: 'nc-winner',
        codAutorizacion: 'ca-winner',
        status: 'enviado',
        errorMessage: null,
        createdAt: existingCreatedAt,
      };
      const conflictError = Object.assign(new Error('duplicate key value violates unique constraint "uq_axonico_lancamento_dedupe"'), {
        code: '23505',
      });
      const findExisting = jest
        .fn()
        .mockResolvedValueOnce(null) // guard 2 — não achou nada
        .mockResolvedValueOnce(winnerRecord); // pós-23505 — busca o vencedor da corrida
      const lancamentoRepository = makeLancamentoRepository({
        findExisting,
        insert: jest.fn().mockRejectedValue(conflictError),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const rejection = useCase.execute(makeInput());
      await expect(rejection).rejects.toThrow(AxonicoLancamentoConcorrenteError);
      await rejection.catch((err: AxonicoLancamentoConcorrenteError) => {
        expect(err.code).toBe('23505');
        expect(err.existente).toEqual(winnerRecord);
        expect(err.recemFaturado).toEqual({ numeroComprobante: 'nc-1', codAutorizacion: 'ca-1' });
        expect(err.documentNumber).toBe(DNI);
        expect(err.patientId).toBe(PATIENT_ID);
      });

      // submitComprobante JÁ FATUROU (chamado 1x, nunca repetido) — o segundo comprovante do
      // erro (`recemFaturado`) é exatamente o que esta chamada produziu.
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);
      expect(findExisting).toHaveBeenCalledTimes(2);
    });

    it('insert rejeita com código diferente de 23505: NÃO vira AxonicoLancamentoConcorrenteError, cai no comportamento genérico (relança o erro original)', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const otherError = Object.assign(new Error('connection terminated'), { code: '57P01' });
      const lancamentoRepository = makeLancamentoRepository({
        insert: jest.fn().mockRejectedValue(otherError),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await expect(useCase.execute(makeInput())).rejects.toBe(otherError);
      expect(axonicoApiClient.submitComprobante).toHaveBeenCalledTimes(1);
    });
  });

  describe('regressão 18/09/2026 — documentNumber (DNI) nunca aparece em log nem em mensagem de erro', () => {
    it('dedupe local (guard 2): logger.info não recebe documentNumber em nenhum campo/valor', async () => {
      mockLogger.info.mockClear();
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const existingCreatedAt = new Date(2026, 8, 18, 12, 0);
      const lancamentoRepository = makeLancamentoRepository({
        findExisting: jest.fn().mockResolvedValue({
          id: 'lanc-existing',
          patientId: PATIENT_ID,
          documentNumber: DNI,
          serviceType: 'AT',
          serviceDate: SERVICE_DATE,
          hours: 4,
          numeroComprobante: 'nc-original',
          codAutorizacion: 'ca-original',
          status: 'enviado',
          errorMessage: null,
          createdAt: existingCreatedAt,
        } satisfies AxonicoLancamentoRecord),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      await useCase.execute(makeInput());

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const [loggedArg] = mockLogger.info.mock.calls[0];
      expect(loggedArg).not.toHaveProperty('documentNumber');
      expect(JSON.stringify(loggedArg)).not.toContain(DNI);
      // patientId continua — é ele que dá a rastreabilidade sem expor o DNI.
      expect(loggedArg.patientId).toBe(PATIENT_ID);
    });

    it('AxonicoLancamentoConcorrenteError (23505): err.message não interpola o DNI', async () => {
      const patientReadPort = makePatientReadPort();
      const axonicoApiClient = makeAxonicoApiClient();
      const existingCreatedAt = new Date(2026, 8, 18, 12, 0);
      const winnerRecord: AxonicoLancamentoRecord = {
        id: 'lanc-winner',
        patientId: PATIENT_ID,
        documentNumber: DNI,
        serviceType: 'AT',
        serviceDate: SERVICE_DATE,
        hours: 4,
        numeroComprobante: 'nc-winner',
        codAutorizacion: 'ca-winner',
        status: 'enviado',
        errorMessage: null,
        createdAt: existingCreatedAt,
      };
      const conflictError = Object.assign(new Error('duplicate key value violates unique constraint "uq_axonico_lancamento_dedupe"'), {
        code: '23505',
      });
      const findExisting = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winnerRecord);
      const lancamentoRepository = makeLancamentoRepository({
        findExisting,
        insert: jest.fn().mockRejectedValue(conflictError),
      });
      const useCase = new LancarPrestacaoAxonicoUseCase(patientReadPort, axonicoApiClient, lancamentoRepository);

      const rejection = useCase.execute(makeInput());
      await expect(rejection).rejects.toThrow(AxonicoLancamentoConcorrenteError);
      await rejection.catch((err: AxonicoLancamentoConcorrenteError) => {
        // A PROPRIEDADE `documentNumber` continua (uso interno/estrutural), mas a MENSAGEM —
        // o que vaza para log/observabilidade via err.message — não pode conter o valor do DNI.
        expect(err.message).not.toContain(DNI);
        expect(err.message).toContain(PATIENT_ID);
      });
    });
  });
});
