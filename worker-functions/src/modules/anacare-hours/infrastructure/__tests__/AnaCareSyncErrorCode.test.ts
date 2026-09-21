/**
 * `toStableErrorCode` (F1, migration 457) — regra dura: `anacare_sync_run.last_error` NUNCA guarda
 * `.message` de exceção (pode carregar nome de paciente). Prova central desta suíte: uma mensagem
 * com PII simulada (nome fictício) não aparece na string devolvida, em NENHUM ramo (mapeado ou
 * fallback genérico).
 */
import { toStableErrorCode } from '../AnaCareSyncErrorCode';
import { AnaCarePatientMonthCollisionError } from '../AnaCarePatientMonthRepository';

describe('toStableErrorCode', () => {
  it('AnaCarePatientMonthCollisionError → código dedicado com o HTTP que o controller já devolve (409)', () => {
    const err = new AnaCarePatientMonthCollisionError(['AC-PAT-0'], '2026-09');
    expect(toStableErrorCode(err)).toBe('AnaCarePatientMonthCollisionError:409');
  });

  it('Error genérico não mapeado → fallback UnknownError:<classe>, nunca a mensagem', () => {
    const err = new Error('falha qualquer');
    expect(toStableErrorCode(err)).toBe('UnknownError:Error');
  });

  it('subclasse de Error não mapeada → fallback usa o NOME DA CLASSE real, não "Error" genérico', () => {
    class MinhaFalhaCustomizada extends Error {}
    const err = new MinhaFalhaCustomizada('boom');
    expect(toStableErrorCode(err)).toBe('UnknownError:MinhaFalhaCustomizada');
  });

  it('valor lançado que não é Error (string/objeto) → fallback fixo, nunca tenta ler .message', () => {
    expect(toStableErrorCode('string lançada crua')).toBe('UnknownError:NonError');
    expect(toStableErrorCode({ message: 'objeto qualquer' })).toBe('UnknownError:NonError');
    expect(toStableErrorCode(null)).toBe('UnknownError:NonError');
    expect(toStableErrorCode(undefined)).toBe('UnknownError:NonError');
  });

  /**
   * PROVA OBRIGATÓRIA (item 4 do prompt): erro cujo `.message` contém uma string de PII simulada
   * (nome fictício de paciente) — o código devolvido NÃO pode conter essa substring, nem no ramo
   * mapeado (`AnaCarePatientMonthCollisionError`, cuja mensagem REALMENTE cita o(s)
   * `anaCarePatientId`) nem no fallback genérico.
   */
  describe('PII simulada em .message nunca vaza para o código devolvido', () => {
    const NOME_FICTICIO = 'Ramona Quimey Villalba';

    it('erro genérico com nome fictício na mensagem', () => {
      const err = new Error(`Falha ao processar turno de ${NOME_FICTICIO} — timeout na API`);
      const code = toStableErrorCode(err);
      expect(code).not.toContain(NOME_FICTICIO);
      expect(code).toBe('UnknownError:Error');
    });

    it('AnaCarePatientMonthCollisionError com id que embute um nome fictício na mensagem gerada', () => {
      // A mensagem REAL desta classe interpola os ids recebidos — se um id (por engano de outra
      // camada) carregasse texto livre, `toStableErrorCode` ainda assim nunca lê `.message`.
      const err = new AnaCarePatientMonthCollisionError([`paciente-${NOME_FICTICIO}`], '2026-09');
      expect(err.message).toContain(NOME_FICTICIO); // confirma que a mensagem REALMENTE carrega o nome (senão o teste não prova nada)
      const code = toStableErrorCode(err);
      expect(code).not.toContain(NOME_FICTICIO);
      expect(code).toBe('AnaCarePatientMonthCollisionError:409');
    });

    it('subclasse desconhecida com nome fictício na mensagem cai no fallback sem vazar', () => {
      class OutraFalha extends Error {}
      const err = new OutraFalha(`erro envolvendo ${NOME_FICTICIO}`);
      const code = toStableErrorCode(err);
      expect(code).not.toContain(NOME_FICTICIO);
      expect(code).toBe('UnknownError:OutraFalha');
    });
  });
});
