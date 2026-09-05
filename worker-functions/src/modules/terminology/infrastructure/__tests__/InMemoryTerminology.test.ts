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
      await expect(makeFake().ancestorsOf(ORFAO_SEM_CAPITULO.uri)).rejects.toThrow(
        /Capítulo da entidade não está carregado/,
      );
    });

    // T7 — o fake segue a MESMA regra do adaptador real: a mensagem não nomeia o conceito.
    it('T7 — a mensagem de erro NÃO carrega a uri nem o código do conceito procurado', async () => {
      await expect(makeFake().ancestorsOf('uri://segredo-clinico/12345')).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('segredo-clinico') }),
      );
      await expect(makeFake().ancestorsOf(ORFAO_SEM_CAPITULO.uri)).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('YY') }),
      );
    });

    it('D3 — catálogo vazio lança TerminologyUnavailableError antes de checar a uri', async () => {
      await expect(new InMemoryTerminology().ancestorsOf('qualquer-uri')).rejects.toThrow(TerminologyUnavailableError);
    });
  });

  /**
   * 🔧 F5-CORREÇÃO T2 — o fake indexa e resolve por `conceptKey`, igual ao adaptador real. Sem
   * isto a resolução estável entre releases estaria provada só no Postgres, e o contrato da
   * porta (LSP) teria um buraco: "se só passa no real, a abstração vazou".
   *
   * O describe do C1 (`asOfRelease` / opção `currentRelease` do construtor) SAIU junto com o
   * parâmetro — ver o COMMENT do `TerminologyPort` para o porquê (T3).
   */
  describe('T2 — identidade de conceito estável entre releases (concept_key)', () => {
    const uriEm = (release: string) => `http://id.who.int/icd/release/11/${release}/mms/405565289/unspecified`;

    const CAP_2027: DiagnosisEntity = {
      uri: 'http://id.who.int/icd/release/11/2027-01/mms/1000',
      code: IcdCode.parse('06'),
      titleEs: 'Capítulo 06 (2027-01)',
      titleEn: null,
      chapter: '06',
      release: '2027-01',
      kind: 'chapter',
      isLeaf: false,
      parentUri: null,
    };
    /** O MESMO conceito do mapa do ClickUp, agora publicado no release 2027-01. */
    const CONCEITO_2027: DiagnosisEntity = {
      uri: uriEm('2027-01'),
      code: IcdCode.parse('6A2Z'),
      titleEs: 'Esquizofrenia u otros trastornos psicóticos primarios, sin especificación',
      titleEn: null,
      chapter: '06',
      release: '2027-01',
      kind: 'stem',
      isLeaf: true,
      parentUri: null,
    };

    const catalogo2027 = () => new InMemoryTerminology([CAP_2027, CONCEITO_2027]);

    it('getByUri com a URI de OUTRO release (a que o mapa do ClickUp guardou) RESOLVE o mesmo conceito', async () => {
      const entity = await catalogo2027().getByUri(uriEm('2026-01'));
      expect(entity).not.toBeNull();
      expect(entity?.release).toBe('2027-01');
      expect(entity?.code.value).toBe('6A2Z');
      // A URI devolvida é a do release VIGENTE, nunca a que entrou.
      expect(entity?.uri).toBe(uriEm('2027-01'));
    });

    it('ancestorsOf com a URI de outro release resolve o capítulo do release vigente', async () => {
      const { chapter } = await catalogo2027().ancestorsOf(uriEm('2026-01'));
      expect(chapter).toEqual({ code: '06', title: CAP_2027.titleEs });
    });

    it('URI de OUTRO conceito continua não resolvendo — a normalização não afrouxa a identidade', async () => {
      expect(await catalogo2027().getByUri(uriEm('2026-01').replace('405565289', '999999999'))).toBeNull();
    });

    it('URI SEM segmento de release (fixture `test://`) passa intacta — comportamento de sempre', async () => {
      const entity = await makeFake().getByUri(ESQUIZOFRENIA.uri);
      expect(entity).toEqual(ESQUIZOFRENIA);
    });
  });
});
