/**
 * ChatwootClient — reencontrar o contato certo pelo telefone.
 *
 * Caso de origem (Carina, 07/08): a pessoa entra pelo WhatsApp como
 * +54 9 11 7114-8942 e sai da nossa base como +54 11 7114-8942. A comparação
 * digits-only dizia "são diferentes" → o espelho criava um SEGUNDO contato e o
 * histórico ficava partido: convs 1112/1114 num contato, 1148/1149 no outro.
 * Quem atendia via metade da conversa.
 */
import axios from 'axios';
import { ChatwootClient, phoneMatchKey } from '../ChatwootClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('phoneMatchKey', () => {
  it('as duas formas do MESMO número argentino batem', () => {
    expect(phoneMatchKey('+5491171148942')).toBe(phoneMatchKey('+541171148942'));
  });

  it('formatação (espaços, hífens, parênteses) não muda o resultado', () => {
    expect(phoneMatchKey('+54 9 11 7114-8942')).toBe(phoneMatchKey('5491171148942'));
  });

  it('números diferentes continuam diferentes', () => {
    // Dígitos trocados (7114 × 1714) — é a colisão do registro importado dela.
    expect(phoneMatchKey('+5491171148942')).not.toBe(phoneMatchKey('+5491117148942'));
  });

  it('número brasileiro passa intacto (a regra do 9 é só AR)', () => {
    expect(phoneMatchKey('+5511987654321')).toBe('5511987654321');
  });

  it('vazio/nulo não vira chave', () => {
    expect(phoneMatchKey(null)).toBe('');
    expect(phoneMatchKey(undefined)).toBe('');
    expect(phoneMatchKey('')).toBe('');
  });
});

describe('ChatwootClient.searchContactByPhone (via mirrorOutgoingMessage)', () => {
  const cfg = {
    baseUrl: 'https://chatwoot.test',
    apiToken: 'tok',
    accountId: 1,
    inboxId: 1,
  };

  const makeHttp = (searchPayload: unknown[]) => {
    const post = jest.fn().mockImplementation((url: string) => {
      if (url === '/contacts') {
        return Promise.resolve({
          data: {
            payload: {
              contact: { id: 999 },
              contact_inbox: { source_id: 'whatsapp:+541171148942' },
            },
          },
        });
      }
      return Promise.resolve({ data: { id: 77 } });
    });
    const get = jest.fn().mockImplementation((url: string) => {
      if (url === '/contacts/search') return Promise.resolve({ data: { payload: searchPayload } });
      return Promise.resolve({ data: { payload: [{ id: 55, inbox_id: 1, status: 'open' }] } });
    });
    mockedAxios.create.mockReturnValue({ get, post } as never);
    return { get, post };
  };

  it('acha o contato do inbound mesmo mandando o número SEM o 9 — não cria outro', async () => {
    const { post } = makeHttp([
      {
        id: 102,
        phone_number: '+5491171148942', // como o WhatsApp criou
        contact_inboxes: [{ source_id: 'whatsapp:+5491171148942', inbox: { id: 1 } }],
      },
    ]);
    const client = new ChatwootClient(cfg);

    await client.mirrorOutgoingMessage({
      phone: '+541171148942', // como está no nosso cadastro
      content: 'hola',
      twilioSid: 'SM1',
    });

    // Nenhum POST /contacts = nenhum contato duplicado criado.
    const contactCreations = post.mock.calls.filter((c) => c[0] === '/contacts');
    expect(contactCreations).toHaveLength(0);
  });

  it('busca pelos últimos 10 dígitos — é o que as duas variantes têm em comum', async () => {
    const { get } = makeHttp([]);
    const client = new ChatwootClient(cfg);

    await client.mirrorOutgoingMessage({ phone: '+541171148942', content: 'x', twilioSid: 'SM2' });

    const searchCall = get.mock.calls.find((c) => c[0] === '/contacts/search');
    expect(searchCall?.[1]?.params?.q).toBe('1171148942');
  });

  it('com vários candidatos e nenhum casamento exato, NÃO chuta — cria contato novo', async () => {
    // Mandar pra pessoa errada é pior que criar um contato a mais.
    const { post } = makeHttp([
      { id: 1, phone_number: '+5491171148000' },
      { id: 2, phone_number: '+5491171148999' },
    ]);
    const client = new ChatwootClient(cfg);

    await client.mirrorOutgoingMessage({ phone: '+541171148942', content: 'x', twilioSid: 'SM3' });

    const contactCreations = post.mock.calls.filter((c) => c[0] === '/contacts');
    expect(contactCreations).toHaveLength(1);
  });

  it('com o par já duplicado, escolhe o contato que TEM thread neste inbox', async () => {
    // Estado real da Carina hoje: 102 (com o 9, veio do WhatsApp, tem a thread)
    // e 1008 (sem o 9, criado pelo espelho). Alimentar o 1008 perpetuaria a divisão.
    const { get } = makeHttp([
      { id: 1008, phone_number: '+541171148942' }, // sem contact_inboxes
      {
        id: 102,
        phone_number: '+5491171148942',
        contact_inboxes: [{ source_id: 'whatsapp:+5491171148942', inbox: { id: 1 } }],
      },
    ]);
    const client = new ChatwootClient(cfg);

    await client.mirrorOutgoingMessage({ phone: '+541171148942', content: 'x', twilioSid: 'SM5' });

    const convCall = get.mock.calls.find((c) => String(c[0]).includes('/conversations'));
    expect(convCall?.[0]).toBe('/contacts/102/conversations');
  });

  it('candidato único sem match canônico segue aceito (comportamento antigo preservado)', async () => {
    const { post } = makeHttp([
      { id: 9, phone_number: '1171148942', contact_inboxes: [{ source_id: 's', inbox: { id: 1 } }] },
    ]);
    const client = new ChatwootClient(cfg);

    await client.mirrorOutgoingMessage({ phone: '+541171148942', content: 'x', twilioSid: 'SM4' });

    expect(post.mock.calls.filter((c) => c[0] === '/contacts')).toHaveLength(0);
  });
});
