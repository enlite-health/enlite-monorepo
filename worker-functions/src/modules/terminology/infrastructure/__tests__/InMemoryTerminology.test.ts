/**
 * InMemoryTerminology — o FAKE que implementa TerminologyPort para teste (spec 016, "Contrato de
 * arquitetura": "trocar o adaptador por um fake em memória e a suíte inteira continuar verde").
 * Mesma interface que `IcdCatalogTerminology`; ver
 * `tests/e2e/terminology-port-contract.e2e.test.ts` para a bateria que roda contra os dois.
 *
 * 🔧 F1-CORREÇÕES: `code` agora é `IcdCode` (D7) — fixtures usam `IcdCode.parse(...)` e
 * assertions comparam `.code.value`/`.code.equals(...)`. Catálogo vazio lança
 * `TerminologyUnavailableError` (D3); consulta < 2 caracteres devolve `[]` sem checar o catálogo
 * (D4) — mesmo contrato do adaptador real.
 */
import { InMemoryTerminology } from '../InMemoryTerminology';
import type { DiagnosisEntity } from '../../domain/TerminologyPort';
import { IcdCode } from '../../domain/IcdCode';
import { TerminologyUnavailableError } from '../../domain/UnavailableTerminology';

const AUTISMO: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified',
  code: IcdCode.parse('6A02.Z'),
  titleEs: 'Trastorno del espectro autista, sin especificación',
  titleEn: 'Autism spectrum disorder, unspecified',
  chapter: '06',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624',
};

const ESQUIZOFRENIA: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/1234',
  code: IcdCode.parse('6A20'),
  titleEs: 'Esquizofrenia',
  titleEn: 'Schizophrenia',
  chapter: '06',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

const EXTENSAO: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/xk0r',
  code: IcdCode.parse('XK0R'),
  titleEs: 'Medición',
  titleEn: 'Measurement',
  chapter: 'X',
  release: '2026-01',
  kind: 'extension',
  isLeaf: true,
  parentUri: null,
};

const CAPITULO_06: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/chap06',
  code: IcdCode.parse('06'),
  titleEs: 'Trastornos mentales, del comportamiento y del neurodesarrollo',
  titleEn: 'Mental, behavioural or neurodevelopmental disorders',
  chapter: '06',
  release: '2026-01',
  kind: 'chapter',
  isLeaf: false,
  parentUri: null,
};

const SEM_TITULO: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/sem-titulo',
  code: IcdCode.parse('ZZ99'),
  titleEs: null,
  titleEn: null,
  chapter: '06',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

const SO_INGLES: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/so-ingles',
  code: IcdCode.parse('ZZ98'),
  titleEs: null,
  titleEn: 'Only english title present',
  chapter: '06',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

const ORFAO_SEM_CAPITULO: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/orfao',
  code: IcdCode.parse('YY01'),
  titleEs: 'Entidade órfã',
  titleEn: 'Orphan entity',
  chapter: 'YY', // nenhum entity kind='chapter' com code='YY' está carregado no fake
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

function makeFake(): InMemoryTerminology {
  return new InMemoryTerminology([
    AUTISMO,
    ESQUIZOFRENIA,
    EXTENSAO,
    CAPITULO_06,
    SEM_TITULO,
    SO_INGLES,
    ORFAO_SEM_CAPITULO,
  ]);
}

describe('InMemoryTerminology', () => {
  describe('search', () => {
    it('acha por substring exata, case-insensitive', async () => {
      const out = await makeFake().search('autista');
      expect(out.map((c) => c.code.value)).toContain('6A02.Z');
    });

    it('tolera erro de digitação de uma letra (US-1 — o que a OMS não entrega)', async () => {
      const out = await makeFake().search('esquisofrenia');
      expect(out.map((c) => c.code.value)).toContain('6A20');
    });

    it('filtra por capítulo', async () => {
      const out = await makeFake().search('trastorno', { chapters: ['08'] });
      expect(out).toEqual([]);
    });

    it('exclui kind=extension por padrão', async () => {
      const out = await makeFake().search('medición');
      expect(out).toEqual([]);
    });

    it('inclui extension quando includeExtensions=true', async () => {
      const out = await makeFake().search('medición', { includeExtensions: true });
      expect(out.map((c) => c.code.value)).toContain('XK0R');
    });

    it('devolve [] para consulta sem nenhum match — não lança', async () => {
      const out = await makeFake().search('xyzxyzxyz-nao-existe');
      expect(out).toEqual([]);
    });

    it('cada candidato expõe uri, code, title e chapter — nenhum campo da OMS (destinationEntities, theCode)', async () => {
      const [candidate] = await makeFake().search('autista');
      expect(Object.keys(candidate).sort()).toEqual(['chapter', 'code', 'title', 'uri']);
    });

    it('lang=en prefere o título em inglês', async () => {
      const [candidate] = await makeFake().search('autista', { lang: 'en' });
      expect(candidate.title).toBe('Autism spectrum disorder, unspecified');
    });

    it('lang=es cai para o inglês quando o espanhol falta (buraco de tradução medido na F0)', async () => {
      const out = await makeFake().search('only english title', { lang: 'es' });
      expect(out.map((c) => c.code.value)).toContain('ZZ98');
      expect(out.find((c) => c.code.value === 'ZZ98')?.title).toBe('Only english title present');
    });

    it('entidade sem NENHUM título (es e en nulos) nunca é encontrada — não quebra a busca', async () => {
      const out = await makeFake().search('qualquer coisa');
      expect(out.map((c) => c.code.value)).not.toContain('ZZ99');
    });

    it('D4 — query vazia devolve [] SEM checar o catálogo — não lança nem casa com tudo', async () => {
      const out = await makeFake().search('');
      expect(out).toEqual([]);
    });

    it('D4 — query de 1 caractere (abaixo do piso de 2) devolve [] nos curingas típicos (%, _, a)', async () => {
      expect(await makeFake().search('%')).toEqual([]);
      expect(await makeFake().search('_')).toEqual([]);
      expect(await makeFake().search('a')).toEqual([]);
    });

    it('normaliza acento: query feita só de marcas combinantes normaliza para vazio e devolve [] (defensivo)', async () => {
      // Duas marcas de acento combinantes (U+0301) têm length 2 (passam o piso do D4), mas
      // normalize() as remove via NFD + strip do range Unicode de diacríticos, e sobra string
      // vazia — branch que só este caso alcança (nenhum outro teste normaliza para vazio).
      const soMarcasDeAcento = String.fromCharCode(0x0301, 0x0301);
      const out = await makeFake().search(soMarcasDeAcento);
      expect(out).toEqual([]);
    });

    it('respeita o limit e para antes de varrer o catálogo inteiro', async () => {
      const out = await makeFake().search('trastorno', { limit: 1 });
      expect(out).toHaveLength(1);
    });

    it('D3 — construtor sem argumentos nasce vazio → lança TerminologyUnavailableError (catálogo vazio é falha, não sucesso silencioso)', async () => {
      const empty = new InMemoryTerminology();
      await expect(empty.search('qualquer')).rejects.toThrow(TerminologyUnavailableError);
    });
  });

  describe('getByUri', () => {
    it('encontra por uri exata e devolve DiagnosisEntity completo', async () => {
      const entity = await makeFake().getByUri(ESQUIZOFRENIA.uri);
      expect(entity).toEqual(ESQUIZOFRENIA);
    });

    it('devolve null quando não existe — nunca lança', async () => {
      const entity = await makeFake().getByUri('uri-inexistente');
      expect(entity).toBeNull();
    });

    it('D3 — catálogo vazio lança TerminologyUnavailableError, nunca devolve null silencioso', async () => {
      await expect(new InMemoryTerminology().getByUri('qualquer-uri')).rejects.toThrow(TerminologyUnavailableError);
    });
  });

  describe('ancestorsOf', () => {
    it('resolve o capítulo a partir do código do capítulo gravado na entidade', async () => {
      const { chapter, block } = await makeFake().ancestorsOf(AUTISMO.uri);
      expect(chapter).toEqual({ code: '06', title: CAPITULO_06.titleEs });
      expect(block).toBeUndefined();
    });

    it('lança quando a uri não existe no catálogo', async () => {
      await expect(makeFake().ancestorsOf('uri-inexistente')).rejects.toThrow();
    });

    it('lança quando o capítulo da entidade não está carregado no fake (integridade do fixture)', async () => {
      await expect(makeFake().ancestorsOf(ORFAO_SEM_CAPITULO.uri)).rejects.toThrow(/YY/);
    });

    it('D3 — catálogo vazio lança TerminologyUnavailableError antes de checar a uri', async () => {
      await expect(new InMemoryTerminology().ancestorsOf('qualquer-uri')).rejects.toThrow(TerminologyUnavailableError);
    });
  });

  describe('F1.5-CORREÇÃO C1 (D261) — asOfRelease e opção `currentRelease` do construtor', () => {
    const RELEASE_OLD = 'C1-OLD';
    const RELEASE_NEW = 'C1-NEW';

    const CAPITULO_OLD: DiagnosisEntity = {
      uri: 'uri://c1/chapter',
      code: IcdCode.parse('77'),
      titleEs: 'Capítulo (old)',
      titleEn: null,
      chapter: '77',
      release: RELEASE_OLD,
      kind: 'chapter',
      isLeaf: false,
      parentUri: null,
    };
    const CAPITULO_NEW: DiagnosisEntity = {
      uri: 'uri://c1/chapter', // MESMO uri, release diferente — 2 linhas em byUriRelease
      code: IcdCode.parse('77'),
      titleEs: 'Capítulo (new)',
      titleEn: null,
      chapter: '77',
      release: RELEASE_NEW,
      kind: 'chapter',
      isLeaf: false,
      parentUri: null,
    };
    const ORFAO: DiagnosisEntity = {
      uri: 'uri://c1/orphan',
      code: IcdCode.parse('ZO01'),
      titleEs: 'Só existe no release antigo',
      titleEn: null,
      chapter: '77',
      release: RELEASE_OLD,
      kind: 'stem',
      isLeaf: true,
      parentUri: CAPITULO_OLD.uri,
    };

    function makeC1Fake(): InMemoryTerminology {
      return new InMemoryTerminology([CAPITULO_OLD, CAPITULO_NEW, ORFAO], { currentRelease: RELEASE_NEW });
    }

    it('getByUri(uri) SEM asOfRelease, com `currentRelease` configurado, filtra pelo release corrente do construtor', async () => {
      // ORFAO só existe em RELEASE_OLD; currentRelease do fake é RELEASE_NEW.
      expect(await makeC1Fake().getByUri(ORFAO.uri)).toBeNull();
    });

    it('getByUri(uri, asOfRelease) IGNORA `currentRelease` e busca o release pedido', async () => {
      const entity = await makeC1Fake().getByUri(ORFAO.uri, RELEASE_OLD);
      expect(entity).toEqual(ORFAO);
    });

    it('getByUri(uri, asOfRelease) devolve null quando o par uri+release não existe', async () => {
      expect(await makeC1Fake().getByUri(ORFAO.uri, 'RELEASE-INEXISTENTE')).toBeNull();
    });

    it('ancestorsOf(uri, asOfRelease) resolve o capítulo NO release pedido, mesmo não sendo o corrente', async () => {
      const { chapter } = await makeC1Fake().ancestorsOf(ORFAO.uri, RELEASE_OLD);
      expect(chapter).toEqual({ code: '77', title: CAPITULO_OLD.titleEs });
    });

    it('ancestorsOf(uri) SEM asOfRelease lança quando o código não existe no release corrente do construtor', async () => {
      await expect(makeC1Fake().ancestorsOf(ORFAO.uri)).rejects.toThrow();
    });

    it('sem `currentRelease` no construtor (default), getByUri(uri) mantém o comportamento de SEMPRE — última entidade daquele uri, sem filtrar release', async () => {
      // Sem currentRelease: cai no branch de retrocompatibilidade (this.byUri, não byUriRelease).
      const semCurrentRelease = new InMemoryTerminology([CAPITULO_OLD, CAPITULO_NEW]);
      const found = await semCurrentRelease.getByUri(CAPITULO_NEW.uri);
      expect(found?.release).toBe(RELEASE_NEW); // CAPITULO_NEW foi o último inserido para esse uri
    });
  });
});
