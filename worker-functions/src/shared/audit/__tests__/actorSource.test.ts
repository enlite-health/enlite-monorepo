import {
  actorSourceFromChangedBy,
  actorSourceSql,
  luzActor,
  staffActor,
  syncActor,
  systemActor,
  workerSelfActor,
  NOT_INSTRUMENTED,
} from '../actorSource';

describe('actorSource — construtores de ator', () => {
  it('staffActor grava o firebase_uid (não o e-mail) quando há uid', () => {
    expect(staffActor('uid-123', 'flor@enlite.health')).toEqual({
      source: 'admin_panel',
      id: 'staff:uid-123',
    });
  });

  it('staffActor cai para o e-mail só quando não há uid', () => {
    expect(staffActor(null, 'flor@enlite.health')?.id).toBe('staff:flor@enlite.health');
    expect(staffActor('  ', 'flor@enlite.health')?.id).toBe('staff:flor@enlite.health');
  });

  it('staffActor sem identidade nenhuma devolve null (não inventa ator)', () => {
    expect(staffActor(null, null)).toBeNull();
    expect(staffActor(undefined, undefined)).toBeNull();
  });

  it('demais atores carregam a fonte no prefixo', () => {
    expect(luzActor('apply')).toEqual({ source: 'luz_conversation', id: 'luz:apply' });
    expect(workerSelfActor('w-1')).toEqual({ source: 'worker_self', id: 'worker_self:w-1' });
    expect(workerSelfActor()).toEqual({ source: 'worker_self', id: 'worker_self' });
    expect(systemActor('no-show-auto')).toEqual({ source: 'system_auto', id: 'system:no-show-auto' });
    expect(syncActor('talentum')).toEqual({ source: 'sync_import', id: 'sync:talentum' });
  });
});

describe('actorSourceFromChangedBy — a fonte sai do prefixo', () => {
  it.each([
    ['staff:uid-123', 'admin_panel'],
    ['luz:apply', 'luz_conversation'],
    ['worker_self:w-1', 'worker_self'],
    ['worker_self', 'worker_self'],
    ['system:matchmaking', 'system_auto'],
    ['sync:talentum', 'sync_import'],
  ])('%s → %s', (changedBy, expected) => {
    expect(actorSourceFromChangedBy(changedBy)).toBe(expected);
  });

  it('reconhece os valores que já existiam em produção antes da instrumentação', () => {
    // gravados pelos 5 caminhos que já carimbavam o uid
    expect(actorSourceFromChangedBy('luz:baja-cuenta')).toBe('luz_conversation');
    expect(actorSourceFromChangedBy('luz:set-availability')).toBe('luz_conversation');
    expect(actorSourceFromChangedBy('luz')).toBe('luz_conversation');
    expect(actorSourceFromChangedBy('lgpd:baja-solicitada:camila-vald')).toBe('system_auto');
    expect(actorSourceFromChangedBy('system:merge-orphan-fix-20260727')).toBe('system_auto');
  });

  it('linha sem autor vira a fatia explícita, não uma autoria inventada', () => {
    expect(actorSourceFromChangedBy(null)).toBe(NOT_INSTRUMENTED);
    expect(actorSourceFromChangedBy(undefined)).toBe(NOT_INSTRUMENTED);
    expect(actorSourceFromChangedBy('   ')).toBe(NOT_INSTRUMENTED);
    // valor desconhecido também não é chutado para nenhuma fonte
    expect(actorSourceFromChangedBy('algum-uid-solto')).toBe(NOT_INSTRUMENTED);
  });
});

describe('actorSourceSql — o SQL espelha o TS', () => {
  it('cobre os mesmos prefixos e usa a coluna pedida', () => {
    const sql = actorSourceSql('h.changed_by');
    expect(sql).toContain("h.changed_by LIKE 'staff:%'");
    expect(sql).toContain("h.changed_by LIKE 'luz:%'");
    expect(sql).toContain("h.changed_by LIKE 'worker_self%'");
    expect(sql).toContain("h.changed_by LIKE 'system:%'");
    expect(sql).toContain("h.changed_by LIKE 'sync:%'");
    expect(sql).toContain(NOT_INSTRUMENTED);
  });
});
