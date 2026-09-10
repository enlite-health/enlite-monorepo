import { useEffect, useRef, useState, type RefObject } from 'react';
import { googleMapsScriptUrl } from '@infrastructure/services/googleMapsScriptUrl';

/**
 * Liga o widget de autocomplete do Google a um `<input>` qualquer.
 *
 * ⚠️ Por que isto é um HOOK e não vive dentro do `GooglePlacesAutocomplete`:
 * o componente traz rótulo e borda próprios (16px semibold, `h-12` com moldura),
 * desenhados para o cadastro do prestador. O painel de admin monta formulário
 * denso com `FormField` + `InputWithIcon` compacto — plugar o componente inteiro
 * ali renderiza DOIS rótulos e quebra a grade. A saída errada seria copiar a
 * ligação com o Google para o segundo lugar; a certa é ter UMA ligação e duas
 * apresentações.
 *
 * Isso não é preferência de estilo: a lógica aqui dentro é a que segura a CONTA
 * do Places (ver o bloco do efeito, abaixo). Duplicá-la é reabrir o defeito de
 * 07/09/2026 no primeiro consumidor que esquecer — o modo de falha que já custou
 * 309 chamadas de Autocomplete para 1 Place Details.
 */

/** Países onde a Enlite opera. Fora deles o Google não sugere nada. */
const COUNTRIES = ['ar', 'br', 'cl', 'co', 'mx', 'pe', 'uy'];

/**
 * O que pedimos ao Google por endereço escolhido.
 *
 * `geometry` não é enfeite: é a coordenada que dispensa o geocoding do
 * `ServiceAreaMap`. Quem tirar daqui faz o mapa voltar a geocodificar o texto a
 * cada tecla — que é exatamente o custo que este campo existe para não pagar.
 */
const PLACE_FIELDS = ['formatted_address', 'geometry', 'address_components', 'name'];

/**
 * ⚠️ PRIVACIDADE (lex, condição C1 do parecer de 10/09/2026).
 *
 * O widget legado do Google NÃO renderiza as sugestões dentro do `<input>`: ele
 * cria um `div.pac-container` e o pendura em `document.body` — FORA da subárvore
 * do formulário. Isso importa porque o Microsoft Clarity mascara texto de
 * `<input>` em todos os modos, mas `div` solto é texto comum: o domicílio do
 * paciente entraria em session replay, dando a um SEGUNDO controlador (Microsoft,
 * EUA) um dado que hoje só o Google recebe.
 *
 * `data-clarity-mask` no wrapper do campo NÃO resolve — o nó não é descendente
 * dele. Tem de ser marcado no PRÓPRIO nó, onde quer que o Google o pendure.
 */
const CLARITY_MASK_ATTR = 'data-clarity-mask';
const PAC_CONTAINER_SELECTOR = '.pac-container';

function maskPacContainers(): void {
  document
    .querySelectorAll(PAC_CONTAINER_SELECTOR)
    .forEach((el) => el.setAttribute(CLARITY_MASK_ATTR, 'True'));
}

/**
 * ⚠️ A recusa da chave NÃO passa pelo caminho de erro do carregamento.
 *
 * Medido em navegador real em 10/09/2026: com a chave recusada, o `<script>` do Maps carrega
 * com **200** e a `AuthenticationService.Authenticate` também — o erro só aparece depois, e a
 * ÚNICA notificação programática que a API dá é chamar `window.gm_authFailure`. Sem escutar
 * esse global, `apiError` fica `null` para sempre e a tela jura que está tudo bem.
 *
 * E o estrago é maior do que "sem sugestões": o widget **desabilita o `<input>`** e troca o
 * placeholder por *"Se ha producido un error."*. Como o domicílio do paciente só pode nascer de
 * uma escolha na lista, o operador fica sem nenhuma saída — e, sem este aviso, sem nenhuma pista
 * de por quê. Os gatilhos reais: quota estourada, faturamento suspenso, restrição de referrer
 * alterada, origem nova não cadastrada.
 *
 * O global é UM só para a página inteira, então quem instala é o módulo, e cada campo montado
 * se inscreve. A flag persiste: um campo montado DEPOIS da falha também precisa saber.
 */
const AUTH_FAILURE_MESSAGE = 'O buscador de endereços do Google recusou esta aplicação.';
type Ouvinte = () => void;
const ouvintesDeFalhaDeChave = new Set<Ouvinte>();
let chaveJaRecusada = false;

interface JanelaComGoogleAuth extends Window {
  gm_authFailure?: () => void;
}

function instalarEscutaDeFalhaDeChave(): void {
  const w = window as JanelaComGoogleAuth;
  // Não sequestra um handler que não é nosso: se alguém já registrou o seu, respeitamos.
  if (w.gm_authFailure) return;
  w.gm_authFailure = (): void => {
    chaveJaRecusada = true;
    ouvintesDeFalhaDeChave.forEach((o) => o());
  };
}

interface UseGooglePlacesAutocompleteOptions {
  /** O `<input>` a ligar. Precisa ser um ref ESTÁVEL (`useRef`), não recriado por render. */
  inputRef: RefObject<HTMLInputElement>;
  /**
   * Chamado com o place JÁ garantido a ter `formatted_address` — inclusive no
   * caminho do teclado, que o widget do Google entrega pela metade.
   * Pode ser arrow inline: o hook lê sempre a versão mais recente (latest ref).
   */
  onPlaceApplied: (place: google.maps.places.PlaceResult) => void;
  /**
   * `false` não carrega script nem cria widget. Serve à tela que renderiza o
   * campo condicionalmente (drawer em modo leitura): sem isto, ela baixaria o
   * Maps e mostraria "erro ao carregar" num campo que nem está na tela.
   */
  enabled?: boolean;
}

interface UseGooglePlacesAutocompleteResult {
  /** Mensagem de degradação para texto livre. `null` = widget vivo. */
  apiError: string | null;
}

export function useGooglePlacesAutocomplete({
  inputRef,
  onPlaceApplied,
  enabled = true,
}: UseGooglePlacesAutocompleteOptions): UseGooglePlacesAutocompleteResult {
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  /**
   * ⚠️ O callback vive em REF, e não nas dependências do efeito de inicialização.
   *
   * O widget do Google é caro de criar: cada `new google.maps.places.Autocomplete()`
   * abre uma SESSÃO nova de Places. Quando o callback estava no array de
   * dependências, qualquer pai que passasse arrow inline (`onChange={(v) => ...}`,
   * que é o caso do `WorkerEditModal`) trocava a identidade dele a cada render — e
   * o campo re-renderiza a cada tecla. Resultado: um widget novo POR TECLA, cada um
   * pedindo suas próprias predições e nenhum vivendo o bastante para fechar a
   * sessão num Place Details.
   *
   * Medido em produção (07/09/2026), uma corrida do `worker-journey` do e2e-prod
   * digitando UM endereço de 19 caracteres: **309 chamadas de Autocomplete para 1
   * Place Details**. Sessão que não termina em Details é a linha CARA do Places
   * (US$ 17/1.000, franquia de 5.000/mês, contra grátis quando fecha em Details).
   *
   * Não trocar por `useCallback` no consumidor — isso empurraria a correção para
   * cada tela e o defeito voltaria na primeira que esquecesse.
   */
  const onPlaceAppliedRef = useRef(onPlaceApplied);
  useEffect(() => {
    onPlaceAppliedRef.current = onPlaceApplied;
  });

  useEffect(() => {
    if (!enabled) return;

    instalarEscutaDeFalhaDeChave();
    if (chaveJaRecusada) setApiError(AUTH_FAILURE_MESSAGE);
    const aoRecusarChave = (): void => setApiError(AUTH_FAILURE_MESSAGE);
    ouvintesDeFalhaDeChave.add(aoRecusarChave);

    // O <input> é capturado AGORA: no unmount o React já zerou `inputRef.current`
    // antes de rodar este cleanup, e a limpeza dos listeners do campo era pulada
    // em silêncio. (Pego pelo teste "limpa os listeners do widget E do input".)
    const inputEl = inputRef.current;

    // A escuta começa ANTES de o widget existir — e é por isso que UM mecanismo basta: o
    // construtor do Google só pendura o dropdown depois que o script carrega, bem depois
    // desta linha. Houve aqui uma varredura inicial "por garantia"; ela foi removida em
    // 10/09/2026 porque NENHUMA sabotagem conseguia matá-la — nenhum teste distinguia a
    // sua presença da sua ausência, e linha que nenhum teste distingue é instrumento morto,
    // não rede de segurança. Quem quiser trazê-la de volta traz junto o caso que só ela salva.
    const observer = new MutationObserver(maskPacContainers);
    observer.observe(document.body, { childList: true });

    const loadGoogleMapsScript = (): Promise<void> => {
      return new Promise((resolve, reject) => {
        if (typeof google !== 'undefined' && google.maps && google.maps.places && google.maps.places.Autocomplete) {
          resolve();
          return;
        }

        const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
          console.error('Google Maps API key not found in environment variables');
          reject(new Error('Google Maps API key not configured'));
          return;
        }

        // Check if script is already loading
        const existingScript = document.querySelector(`script[src*="maps.googleapis.com"]`);
        if (existingScript) {
          // Wait for existing script to load
          existingScript.addEventListener('load', () => {
            // Give it a moment to initialize
            setTimeout(() => resolve(), 100);
          });
          existingScript.addEventListener('error', () => reject(new Error('Failed to load Google Maps script')));
          return;
        }

        const script = document.createElement('script');
        script.src = googleMapsScriptUrl(apiKey);
        script.async = true;
        script.defer = true;
        script.onload = () => {
          // Give the API a moment to fully initialize
          setTimeout(() => resolve(), 100);
        };
        script.onerror = () => reject(new Error('Failed to load Google Maps script'));
        document.head.appendChild(script);
      });
    };

    const initAutocomplete = async (): Promise<void> => {
      try {
        await loadGoogleMapsScript();

        // ⚠️ Guarda no REF VIVO, não no `inputEl` capturado: é assim que se detecta que
        // o componente foi DESMONTADO enquanto o script do Maps carregava. Trocar por
        // `if (!inputEl)` faz o widget ser criado sobre um input que já saiu da tela —
        // tentei, e o teste "desmontar antes do Maps carregar" ficou vermelho na hora.
        if (!inputRef.current) return;

        // Verify that Google Maps Places API is fully available
        if (typeof google === 'undefined' || !google.maps || !google.maps.places || !google.maps.places.Autocomplete) {
          throw new Error('Google Maps Places API not fully loaded');
        }

        autocompleteRef.current = new google.maps.places.Autocomplete(inputRef.current, {
          types: ['address'],
          componentRestrictions: { country: COUNTRIES },
          fields: PLACE_FIELDS,
        });

        const applyPlace = (place: google.maps.places.PlaceResult): void => {
          if (!place.formatted_address) return;
          onPlaceAppliedRef.current?.(place);
        };

        // Confirmação por TECLADO (ArrowDown + Enter): o widget do Google dispara
        // `place_changed` com um place SEM `formatted_address` — só o texto digitado.
        // A versão anterior guardava em `if (place.formatted_address)` e DESCARTAVA
        // a seleção: o endereço se perdia em silêncio. Medido em prod e reproduzido
        // localmente (A/B: mouse gravava, teclado não gravava em 60s).
        //
        // Aqui resolvemos a 1ª predição na mão — é o caminho que o widget não
        // completa sozinho. Só roda no caminho do teclado, então não adiciona
        // chamada nenhuma ao fluxo de quem usa o mouse.
        const resolveFirstPrediction = (typed: string): void => {
          if (!typed.trim()) return;
          const svc = new google.maps.places.AutocompleteService();
          svc.getPlacePredictions(
            {
              input: typed,
              types: ['address'],
              componentRestrictions: { country: COUNTRIES },
            },
            (predictions, status) => {
              const first = predictions?.[0];
              if (status !== google.maps.places.PlacesServiceStatus.OK || !first) return;
              const details = new google.maps.places.PlacesService(document.createElement('div'));
              details.getDetails(
                {
                  placeId: first.place_id,
                  fields: PLACE_FIELDS,
                },
                (detail, detailStatus) => {
                  if (detailStatus !== google.maps.places.PlacesServiceStatus.OK || !detail) return;
                  applyPlace(detail);
                },
              );
            },
          );
        };

        autocompleteRef.current.addListener('place_changed', () => {
          const place = autocompleteRef.current?.getPlace();
          if (place?.formatted_address) {
            applyPlace(place);
            return;
          }
          resolveFirstPrediction(place?.name ?? inputRef.current?.value ?? '');
        });

        // Não apaga um aviso de chave recusada: o widget foi criado, mas está morto.
        if (!chaveJaRecusada) setApiError(null);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error initializing Google Places Autocomplete:', error);

        if (errorMessage.includes('API key') || errorMessage.includes('not configured')) {
          setApiError('Google Maps API key não configurada. Usando campo de texto livre.');
        } else if (errorMessage.includes('not fully loaded')) {
          setApiError('Aguardando Google Maps carregar...');
          // Retry after a delay
          setTimeout(() => initAutocomplete(), 1000);
        } else {
          setApiError('Erro ao carregar Google Places. Usando campo de texto livre.');
        }
      }
    };

    initAutocomplete();

    return () => {
      ouvintesDeFalhaDeChave.delete(aoRecusarChave);
      observer.disconnect();
      // Guarda de existência ANTES de tocar em `google`: quando o script do Maps não
      // carregou (sem chave, rede fora, bloqueador), o global não existe e o cleanup
      // lançava ao desmontar — derrubando a tela num caminho em que o campo deveria
      // apenas degradar para texto livre. (Pego pelos testes de carregamento.)
      if (typeof google === 'undefined' || !google.maps?.event) {
        autocompleteRef.current = null;
        return;
      }
      // O widget instala listeners nos DOIS lados: no objeto Autocomplete e no próprio
      // <input>. Limpar só o primeiro deixava o input com listeners de instâncias
      // antigas — que continuavam pedindo predições depois de descartadas.
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
      if (inputEl) {
        google.maps.event.clearInstanceListeners(inputEl);
      }
    };
    // `inputRef` e `enabled` são estáveis por contrato (ver as props). O que NÃO pode
    // entrar aqui é o callback: pôr `onPlaceApplied` nesta lista reintroduz um widget
    // novo por tecla, e com ele a conta do Places. O teste
    // `GooglePlacesAutocomplete.test.tsx` trava isso: com o callback de volta aqui, ele
    // conta 20 instâncias para 19 teclas e fica vermelho.
  }, [inputRef, enabled]);

  return { apiError };
}
