import {
  decidirTransicaoDeBaixa,
  tocaABaixa,
  CELL_WORKER_DISABLE,
  PREFIXO_TITULAR,
} from '../transicaoDeBaixa';

const COM = [CELL_WORKER_DISABLE, 'worker:write'];
const SEM = ['worker:write'];
const MOTIVO = 'Pedido por telefone, ticket 4412';

describe('C7 — a baixa sai de `worker:write` e ganha célula própria', () => {
  it('transição que NÃO toca a baixa passa direto — o gate não é ruído', () => {
    expect(tocaABaixa('INCOMPLETE_REGISTER', 'REGISTERED')).toBe(false);
    expect(decidirTransicaoDeBaixa({
      de: 'INCOMPLETE_REGISTER', para: 'REGISTERED', cells: SEM,
    }).permitida).toBe(true);
  });

  it('cobre as DUAS direções — entrar e sair de DISABLED', () => {
    expect(tocaABaixa('REGISTERED', 'DISABLED')).toBe(true);
    expect(tocaABaixa('DISABLED', 'INCOMPLETE_REGISTER')).toBe(true);
  });

  it('sem `worker:disable`, dar baixa é recusado — mesmo com worker:write', () => {
    // Era exatamente isto: quem podia corrigir uma ocupação digitada errada
    // podia apagar alguém da operação.
    const d = decidirTransicaoDeBaixa({ de: 'REGISTERED', para: 'DISABLED', cells: SEM, motivo: MOTIVO });
    expect(d.permitida).toBe(false);
    expect(d.motivoRecusa).toBe('sem_celula_de_baixa');
  });

  it('o FURO do INCOMPLETE_REGISTER: reverter para ele exige a célula', () => {
    // `UPDATE workers SET status = $2` era incondicional, então
    // DISABLED → INCOMPLETE_REGISTER revertia a baixa por fora do guard do
    // WorkerImportRepository.
    const d = decidirTransicaoDeBaixa({ de: 'DISABLED', para: 'INCOMPLETE_REGISTER', cells: SEM, motivo: MOTIVO });
    expect(d.permitida).toBe(false);
    expect(d.motivoRecusa).toBe('sem_celula_de_baixa');
  });

  it('com a célula mas SEM motivo, recusa — o motivo é o que a auditoria lê', () => {
    for (const motivo of [undefined, null, '', '   ']) {
      const d = decidirTransicaoDeBaixa({ de: 'REGISTERED', para: 'DISABLED', cells: COM, motivo });
      expect([motivo, d.motivoRecusa]).toEqual([motivo, 'motivo_obrigatorio']);
    }
  });

  it('com célula E motivo, passa', () => {
    expect(decidirTransicaoDeBaixa({
      de: 'REGISTERED', para: 'DISABLED', cells: COM, motivo: MOTIVO,
    }).permitida).toBe(true);
  });

  it('`cells === null` não muda nada — D113, o engine não decidiu', () => {
    // Mas o motivo continua exigido: ele não é permissão, é registro.
    expect(decidirTransicaoDeBaixa({
      de: 'REGISTERED', para: 'DISABLED', cells: null, motivo: MOTIVO,
    }).permitida).toBe(true);
  });

  it('`[]` NÃO é `null` — ator conhecido e sem célula é recusado', () => {
    expect(decidirTransicaoDeBaixa({
      de: 'REGISTERED', para: 'DISABLED', cells: [], motivo: MOTIVO,
    }).motivoRecusa).toBe('sem_celula_de_baixa');
  });
});

describe('C8 — a baixa pedida pelo TITULAR não é revertida por célula de staff', () => {
  const doTitular = `${PREFIXO_TITULAR}uid-do-prestador`;

  it('nem com a célula, nem com motivo, nem com as duas', () => {
    const d = decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: COM, motivo: MOTIVO, autorDaBaixa: doTitular,
    });
    expect(d.permitida).toBe(false);
    expect(d.motivoRecusa).toBe('baixa_do_titular');
  });

  it('nem com `cells === null` — não é nível de acesso, é vontade da pessoa', () => {
    // ⚠️ A ÚNICA regra desta change que NÃO afrouxa com o engine desligado.
    // Se afrouxasse, a proteção do titular só existiria depois do flip.
    const d = decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'INCOMPLETE_REGISTER', cells: null, motivo: MOTIVO, autorDaBaixa: doTitular,
    });
    expect(d.permitida).toBe(false);
    expect(d.motivoRecusa).toBe('baixa_do_titular');
  });

  it('baixa dada por ADMIN continua revertível com a célula', () => {
    expect(decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: COM, motivo: MOTIVO, autorDaBaixa: 'uid-do-admin',
    }).permitida).toBe(true);
  });

  it('autor desconhecido NÃO é tratado como titular — erra para o lado de operar', () => {
    // Erro deliberado e declarado: histórico antigo pode não ter autor, e travar
    // reversão de todo worker legado quebraria operação por dado ausente.
    // Quem pediu baixa pela Luz TEM o carimbo desde a D95.
    expect(decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: COM, motivo: MOTIVO, autorDaBaixa: null,
    }).permitida).toBe(true);
  });

  it('DISABLED → DISABLED não é reversão — não dispara a regra do titular', () => {
    expect(decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'DISABLED', cells: COM, motivo: MOTIVO, autorDaBaixa: doTitular,
    }).permitida).toBe(true);
  });

  it('a RAZÃO é a do titular mesmo SEM a célula — a ordem da checagem importa', () => {
    // Ator sem `worker:disable` E baixa do titular: as duas regras negariam.
    // A que tem de aparecer é a do titular — senão o operador vai pedir a célula,
    // consegui-la, tentar de novo e ser negado igual, sem nunca saber por quê.
    const d = decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: SEM, motivo: MOTIVO, autorDaBaixa: doTitular,
    });
    expect(d.motivoRecusa).toBe('baixa_do_titular');
  });

  it('e sem motivo também — o titular vence a exigência de motivo', () => {
    const d = decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: COM, autorDaBaixa: doTitular,
    });
    expect(d.motivoRecusa).toBe('baixa_do_titular');
  });

  it('a explicação é pronta para a tela — a UI não inventa texto', () => {
    const d = decidirTransicaoDeBaixa({
      de: 'DISABLED', para: 'REGISTERED', cells: COM, motivo: MOTIVO, autorDaBaixa: doTitular,
    });
    expect(d.explicacao).toContain('novo pedido');
  });
});
