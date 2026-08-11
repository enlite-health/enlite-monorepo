import axios from 'axios';
import { createPeriskopeHttpClient, PERISKOPE_BASE_URL } from '../periskopeHttpClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('createPeriskopeHttpClient', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.PERISKOPE_BASE_URL;
    mockedAxios.create.mockReturnValue({ marker: 'instance' } as never);
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('monta o cliente com baseURL, Bearer e x-phone', () => {
    process.env.PERISKOPE_API_KEY = 'k-123';
    process.env.PERISKOPE_PHONE = '5491176360496';

    const client = createPeriskopeHttpClient();

    expect(client).not.toBeNull();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: PERISKOPE_BASE_URL,
      headers: {
        Authorization: 'Bearer k-123',
        'x-phone': '5491176360496',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  });

  it('PERISKOPE_BASE_URL do ambiente sobrepõe a constante (usado só pelo e2e)', () => {
    process.env.PERISKOPE_API_KEY = 'k';
    process.env.PERISKOPE_PHONE = 'p';
    process.env.PERISKOPE_BASE_URL = 'http://localhost:9911/v1';

    createPeriskopeHttpClient();

    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:9911/v1' }),
    );
    delete process.env.PERISKOPE_BASE_URL;
  });

  it('PERISKOPE_BASE_URL vazia cai na constante de produção', () => {
    process.env.PERISKOPE_API_KEY = 'k';
    process.env.PERISKOPE_PHONE = 'p';
    process.env.PERISKOPE_BASE_URL = '';

    createPeriskopeHttpClient();

    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: PERISKOPE_BASE_URL }),
    );
    delete process.env.PERISKOPE_BASE_URL;
  });

  it('aceita timeout customizado', () => {
    process.env.PERISKOPE_API_KEY = 'k';
    process.env.PERISKOPE_PHONE = 'p';
    createPeriskopeHttpClient(999);
    expect(mockedAxios.create).toHaveBeenCalledWith(expect.objectContaining({ timeout: 999 }));
  });

  it.each([
    ['sem API key', undefined, '5491176360496'],
    ['sem phone', 'k-123', undefined],
    ['sem nenhum dos dois', undefined, undefined],
  ])('devolve null %s (e não chama axios.create)', (_label, key, phone) => {
    delete process.env.PERISKOPE_API_KEY;
    delete process.env.PERISKOPE_PHONE;
    if (key) process.env.PERISKOPE_API_KEY = key;
    if (phone) process.env.PERISKOPE_PHONE = phone;

    expect(createPeriskopeHttpClient()).toBeNull();
    expect(mockedAxios.create).not.toHaveBeenCalled();
  });

  it('string vazia conta como ausente', () => {
    process.env.PERISKOPE_API_KEY = '';
    process.env.PERISKOPE_PHONE = 'p';
    expect(createPeriskopeHttpClient()).toBeNull();
  });

  // ── escopo por número: LER é da org, ENVIAR é de um número ────────────────

  it('scopeToPhone: false OMITE o x-phone — a leitura é da ORG inteira', () => {
    // Medido contra a API real em 09/08/2026: com o header, GET /chats devolvia
    // os grupos de UM número; sem ele, os de todos os números do token. O
    // fornecedor documenta isso ("omit to return data across all phones").
    process.env.PERISKOPE_API_KEY = 'k-123';
    process.env.PERISKOPE_PHONE = '5491176360496';

    createPeriskopeHttpClient(15000, { scopeToPhone: false });

    const cfg = mockedAxios.create.mock.calls[0][0] as { headers: Record<string, string> };
    expect(cfg.headers).not.toHaveProperty('x-phone');
    expect(cfg.headers.Authorization).toBe('Bearer k-123');
  });

  it('sem PERISKOPE_PHONE, a LEITURA ainda funciona', () => {
    // O número é variável de ENVIO. Exigi-lo para ler transformaria a falta de
    // uma config de envio numa tela de vinculação vazia, sem erro nenhum.
    process.env.PERISKOPE_API_KEY = 'k-123';
    delete process.env.PERISKOPE_PHONE;

    expect(createPeriskopeHttpClient(15000, { scopeToPhone: false })).not.toBeNull();
  });

  it('sem PERISKOPE_PHONE, o ENVIO continua recusando (null)', () => {
    // Escopado sem número não tem de qual número mandar — melhor null do que
    // deixar o fornecedor escolher.
    process.env.PERISKOPE_API_KEY = 'k-123';
    delete process.env.PERISKOPE_PHONE;

    expect(createPeriskopeHttpClient()).toBeNull();
  });

  it('sem API key, nenhum dos dois modos monta cliente', () => {
    delete process.env.PERISKOPE_API_KEY;
    process.env.PERISKOPE_PHONE = '549';

    expect(createPeriskopeHttpClient()).toBeNull();
    expect(createPeriskopeHttpClient(15000, { scopeToPhone: false })).toBeNull();
  });
});
