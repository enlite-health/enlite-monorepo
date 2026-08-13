import {
  PatientChatRolesService,
  ChatRoleNotFoundError,
  ChatRoleAlreadyExistsError,
  ChatRoleInUseError,
  ChatRoleExclusivityConflictError,
} from '../PatientChatRolesService';
import type { PatientChatRolesRepository } from '../../infrastructure/PatientChatRolesRepository';
import type { PatientChatRoleSpec } from '../../domain/PatientChatRole';

// Só para o caso "sem repo injetado": o repositório real abre pool no construtor.
jest.mock('../../infrastructure/PatientChatRolesRepository', () => ({
  PatientChatRolesRepository: jest.fn().mockImplementation(() => ({})),
}));

function spec(over: Partial<PatientChatRoleSpec> & { code: string }): PatientChatRoleSpec {
  return {
    labelEs: `es-${over.code}`,
    labelPtBr: `pt-${over.code}`,
    isExclusive: true,
    displayOrder: 0,
    isActive: true,
    matchKeywords: [],
    ...over,
  };
}

const FAMILY = spec({ code: 'FAMILY' });
const PLAN = spec({ code: 'HEALTH_PLAN', isExclusive: false });

/**
 * `updateChecked`/`deleteChecked` fazem check+write NA MESMA transação (achado
 * de review, 11/08 — ver PatientChatRolesRepository). Esta função reproduz,
 * sobre os mocks das leituras individuais, EXATAMENTE as duas travas que a
 * repository real roda dentro da transação — assim o teste continua provando
 * a decisão (quando recusa, quando grava) sem reimplementar a repository real
 * nem testar a repository de dentro do teste do serviço (isso já é coberto em
 * PatientChatRolesRepository.test.ts).
 */
/** Formato mínimo que os dois helpers abaixo precisam — frouxo de propósito, para aceitar qualquer sabor de jest.fn/jest.Mocked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Callable = (...args: any[]) => any;

function defaultUpdateChecked(repo: {
  findByCode: Callable;
  findSharedGroups: Callable;
  countUsage: Callable;
  update: Callable;
}) {
  return jest.fn().mockImplementation(async (code: string, input: Record<string, unknown>) => {
    const current = await repo.findByCode(code);
    if (!current) return { outcome: 'not_found' };

    if (input.isExclusive === true && !current.isExclusive) {
      const conflicts = await repo.findSharedGroups(code);
      if (conflicts.length > 0) return { outcome: 'exclusivity_conflict', conflicts };
    }

    if (input.isActive === false && current.isActive) {
      const patientCount = await repo.countUsage(code);
      if (patientCount > 0) return { outcome: 'in_use', patientCount };
    }

    const role = await repo.update(code, input);
    if (!role) return { outcome: 'not_found' };
    return { outcome: 'updated', role };
  });
}

function defaultDeleteChecked(repo: { findByCode: Callable; countUsage: Callable; delete: Callable }) {
  return jest.fn().mockImplementation(async (code: string) => {
    const current = await repo.findByCode(code);
    if (!current) return { outcome: 'not_found' };

    const patientCount = await repo.countUsage(code);
    if (patientCount > 0) return { outcome: 'in_use', patientCount };

    const deleted = await repo.delete(code);
    if (!deleted) return { outcome: 'not_found' };
    return { outcome: 'deleted' };
  });
}

function repoMock(over: Partial<jest.Mocked<PatientChatRolesRepository>> = {}) {
  const base = {
    listAll: jest.fn().mockResolvedValue([FAMILY, PLAN]),
    listActive: jest.fn().mockResolvedValue([FAMILY, PLAN]),
    findByCode: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((input: PatientChatRoleSpec) => Promise.resolve(input)),
    update: jest.fn().mockImplementation((code: string) => Promise.resolve(spec({ code }))),
    delete: jest.fn().mockResolvedValue(true),
    countUsage: jest.fn().mockResolvedValue(0),
    findSharedGroups: jest.fn().mockResolvedValue([]),
    ...over,
  };
  return {
    ...base,
    updateChecked: over.updateChecked ?? defaultUpdateChecked(base),
    deleteChecked: over.deleteChecked ?? defaultDeleteChecked(base),
  } as unknown as jest.Mocked<PatientChatRolesRepository>;
}

const NEW_ROLE = {
  code: 'MANAGEMENT',
  labelEs: 'Grupo de gestión',
  labelPtBr: 'Grupo de gestão',
  isExclusive: true,
  displayOrder: 4,
  matchKeywords: ['gestion'],
};

describe('PatientChatRolesService', () => {
  describe('leitura', () => {
    it('listAll traz ativos e inativos (visão da administração)', async () => {
      const repo = repoMock();
      await new PatientChatRolesService(repo).listAll();
      expect(repo.listAll).toHaveBeenCalled();
    });

    it('listActive é o recorte da ficha do paciente', async () => {
      const repo = repoMock();
      await new PatientChatRolesService(repo).listActive();
      expect(repo.listActive).toHaveBeenCalled();
    });

    it('usageByRole devolve a contagem por papel — a tela mostra o peso antes de mexer', async () => {
      const countUsage = jest
        .fn()
        .mockImplementation((code: string) => Promise.resolve(code === 'FAMILY' ? 15 : 0));
      const repo = repoMock({ countUsage } as never);

      await expect(new PatientChatRolesService(repo).usageByRole()).resolves.toEqual({
        FAMILY: 15,
        HEALTH_PLAN: 0,
      });
    });
  });

  describe('create', () => {
    it('cria quando o código está livre', async () => {
      const repo = repoMock();
      await expect(new PatientChatRolesService(repo).create(NEW_ROLE)).resolves.toMatchObject({
        code: 'MANAGEMENT',
      });
      expect(repo.create).toHaveBeenCalledWith(NEW_ROLE);
    });

    it('código já existente → ChatRoleAlreadyExistsError, sem gravar', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);

      await expect(
        new PatientChatRolesService(repo).create({ ...NEW_ROLE, code: 'FAMILY' }),
      ).rejects.toBeInstanceOf(ChatRoleAlreadyExistsError);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('update — TRAVA 1: compartilhado → exclusivo', () => {
    it('recusa a virada quando já existe grupo dividido, COM a contagem', async () => {
      // Deixar bater no índice único devolveria 23505 sem explicação; e
      // "resolver" apagando um vínculo seria o software escolhendo qual
      // paciente perde a conversa.
      const conflicts = [
        { chatId: '1@g.us', patientCount: 3 },
        { chatId: '2@g.us', patientCount: 2 },
      ];
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(PLAN),
        findSharedGroups: jest.fn().mockResolvedValue(conflicts),
      } as never);

      const promise = new PatientChatRolesService(repo).update('HEALTH_PLAN', {
        isExclusive: true,
      });

      await expect(promise).rejects.toBeInstanceOf(ChatRoleExclusivityConflictError);
      await expect(promise).rejects.toMatchObject({ conflicts });
      await expect(promise).rejects.toThrow('2 group(s) are shared by 5 patients');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('permite a virada quando NÃO há grupo dividido', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(PLAN) } as never);

      await expect(
        new PatientChatRolesService(repo).update('HEALTH_PLAN', { isExclusive: true }),
      ).resolves.toBeDefined();
      expect(repo.update).toHaveBeenCalledWith('HEALTH_PLAN', { isExclusive: true });
    });

    it('o caminho INVERSO (exclusivo → compartilhado) nunca é barrado', async () => {
      // Afrouxar não pode invalidar dado nenhum: o que era único continua único.
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);

      await expect(
        new PatientChatRolesService(repo).update('FAMILY', { isExclusive: false }),
      ).resolves.toBeDefined();
      expect(repo.findSharedGroups).not.toHaveBeenCalled();
    });

    it('não consulta conflito quando `isExclusive` nem foi mandado', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(PLAN) } as never);
      await new PatientChatRolesService(repo).update('HEALTH_PLAN', { labelEs: 'Outro' });
      expect(repo.findSharedGroups).not.toHaveBeenCalled();
    });

    it('mandar `isExclusive: true` em papel que JÁ é exclusivo é no-op, não consulta nada', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);
      await new PatientChatRolesService(repo).update('FAMILY', { isExclusive: true });
      expect(repo.findSharedGroups).not.toHaveBeenCalled();
    });
  });

  describe('update — TRAVA 2: desativar papel em uso', () => {
    it('recusa a desativação com QUANTOS pacientes dependem', async () => {
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(FAMILY),
        countUsage: jest.fn().mockResolvedValue(21),
      } as never);

      const promise = new PatientChatRolesService(repo).update('FAMILY', { isActive: false });

      await expect(promise).rejects.toBeInstanceOf(ChatRoleInUseError);
      await expect(promise).rejects.toMatchObject({
        code: 'FAMILY',
        patientCount: 21,
        operation: 'deactivate',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('permite desativar papel que ninguém usa', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);

      await expect(
        new PatientChatRolesService(repo).update('FAMILY', { isActive: false }),
      ).resolves.toBeDefined();
    });

    it('REATIVAR é sempre livre — reabilitar não pode quebrar nada', async () => {
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(spec({ code: 'FAMILY', isActive: false })),
        countUsage: jest.fn().mockResolvedValue(99),
      } as never);

      await expect(
        new PatientChatRolesService(repo).update('FAMILY', { isActive: true }),
      ).resolves.toBeDefined();
      expect(repo.countUsage).not.toHaveBeenCalled();
    });

    it('editar rótulo de papel em uso é livre — a trava é sobre DESATIVAR', async () => {
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(FAMILY),
        countUsage: jest.fn().mockResolvedValue(200),
      } as never);

      await expect(
        new PatientChatRolesService(repo).update('FAMILY', { labelEs: 'Grupo familiar' }),
      ).resolves.toBeDefined();
      expect(repo.countUsage).not.toHaveBeenCalled();
    });
  });

  describe('update — não encontrado', () => {
    it('papel inexistente → ChatRoleNotFoundError, sem gravar', async () => {
      const repo = repoMock();
      await expect(
        new PatientChatRolesService(repo).update('NOPE', { labelEs: 'x' }),
      ).rejects.toBeInstanceOf(ChatRoleNotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('apagado entre a leitura e a escrita também vira NotFound, não 500', async () => {
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(FAMILY),
        update: jest.fn().mockResolvedValue(null),
      } as never);

      await expect(
        new PatientChatRolesService(repo).update('FAMILY', { labelEs: 'x' }),
      ).rejects.toBeInstanceOf(ChatRoleNotFoundError);
    });
  });

  describe('update — TOCTOU (achado de review, 11/08)', () => {
    it('delega em updateChecked — check e write têm de estar na MESMA transação (na infra)', async () => {
      // Até 11/08 o serviço fazia findByCode → findSharedGroups/countUsage →
      // update() em CONEXÕES separadas: janela real para outro processo
      // inserir um conflito entre o check e a escrita. `updateChecked` reúne
      // as duas coisas num client só (ver PatientChatRolesRepository); aqui só
      // provamos que o serviço PARIU de chamar o check e o write como passos
      // distintos e passou a delegar tudo numa chamada única.
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);
      await new PatientChatRolesService(repo).update('FAMILY', { labelEs: 'x' });

      // Uma chamada só, com o code e o input crus — nada de o SERVIÇO orquestrar
      // findByCode/findSharedGroups/countUsage/update em passos separados (isso
      // agora é responsabilidade da infra, dentro de uma transação).
      expect(repo.updateChecked).toHaveBeenCalledTimes(1);
      expect(repo.updateChecked).toHaveBeenCalledWith('FAMILY', { labelEs: 'x' });
    });
  });

  describe('delete', () => {
    it('apaga papel que ninguém usa', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);
      await expect(new PatientChatRolesService(repo).delete('FAMILY')).resolves.toBeUndefined();
      expect(repo.delete).toHaveBeenCalledWith('FAMILY');
    });

    it('papel EM USO é recusado com a contagem — nada de cascata', async () => {
      // Os vínculos são a chave de join da auditoria da Candela: apagá-los
      // junto com uma linha de catálogo seria perder dado operacional por um
      // clique de configuração.
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(FAMILY),
        countUsage: jest.fn().mockResolvedValue(15),
      } as never);

      const promise = new PatientChatRolesService(repo).delete('FAMILY');

      await expect(promise).rejects.toBeInstanceOf(ChatRoleInUseError);
      await expect(promise).rejects.toMatchObject({ patientCount: 15, operation: 'delete' });
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('papel inexistente → ChatRoleNotFoundError', async () => {
      const repo = repoMock();
      await expect(new PatientChatRolesService(repo).delete('NOPE')).rejects.toBeInstanceOf(
        ChatRoleNotFoundError,
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('sumiu entre a checagem e o DELETE → NotFound, não 500', async () => {
      const repo = repoMock({
        findByCode: jest.fn().mockResolvedValue(FAMILY),
        delete: jest.fn().mockResolvedValue(false),
      } as never);

      await expect(new PatientChatRolesService(repo).delete('FAMILY')).rejects.toBeInstanceOf(
        ChatRoleNotFoundError,
      );
    });

    it('delega em deleteChecked — mesma razão do update: check e delete na MESMA transação', async () => {
      const repo = repoMock({ findByCode: jest.fn().mockResolvedValue(FAMILY) } as never);
      await new PatientChatRolesService(repo).delete('FAMILY');

      expect(repo.deleteChecked).toHaveBeenCalledTimes(1);
      expect(repo.deleteChecked).toHaveBeenCalledWith('FAMILY');
    });
  });

  it('sem repo injetado, instancia o padrão', () => {
    expect(() => new PatientChatRolesService()).not.toThrow();
  });

  it('as mensagens de erro carregam NÚMERO e não vazam PII', () => {
    // "não dá" sem contagem obriga quem opera a adivinhar se são 2 pacientes ou
    // 200 antes de ir mexer.
    const inUse = new ChatRoleInUseError('FAMILY', 21, 'delete');
    expect(inUse.message).toContain('21');
    expect(inUse.name).toBe('ChatRoleInUseError');

    const conflict = new ChatRoleExclusivityConflictError('HEALTH_PLAN', [
      { chatId: '1@g.us', patientCount: 3 },
    ]);
    expect(conflict.message).toContain('3 patients');
    expect(conflict.name).toBe('ChatRoleExclusivityConflictError');

    expect(new ChatRoleNotFoundError('X').name).toBe('ChatRoleNotFoundError');
    expect(new ChatRoleAlreadyExistsError('X').name).toBe('ChatRoleAlreadyExistsError');
  });
});
