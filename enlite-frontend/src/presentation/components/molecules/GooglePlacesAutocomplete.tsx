import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { googleMapsScriptUrl } from '@infrastructure/services/googleMapsScriptUrl';

interface GooglePlacesAutocompleteProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  error?: string;
  containerClassName?: string;
  onPlaceSelected?: (place: google.maps.places.PlaceResult) => void;
  onChange?: (value: string) => void;
  onValidationChange?: (isValid: boolean) => void;
  value?: string;
  requireSelection?: boolean;
}

export const GooglePlacesAutocomplete = forwardRef<HTMLInputElement, GooglePlacesAutocompleteProps>(
  ({ label, error, containerClassName = '', className = '', onPlaceSelected, onChange, onValidationChange, value, requireSelection = true, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
    const [inputValue, setInputValue] = useState(value || '');
    const [apiError, setApiError] = useState<string | null>(null);
    const [placeSelected, setPlaceSelected] = useState(!!value); // Se tem valor inicial, considera selecionado
    const [showValidationError, setShowValidationError] = useState(false);

    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    /**
     * ⚠️ Os callbacks vivem em REF, e não nas dependências do efeito de inicialização.
     *
     * O widget do Google é caro de criar: cada `new google.maps.places.Autocomplete()`
     * abre uma SESSÃO nova de Places. Quando esses três callbacks estavam no array de
     * dependências, qualquer pai que passasse arrow inline (`onChange={(v) => ...}`,
     * que é o caso do `WorkerEditModal`) trocava a identidade deles a cada render — e o
     * campo re-renderiza a cada tecla, porque `handleInputChange` chama `setInputValue`.
     * Resultado: um widget novo POR TECLA, cada um pedindo suas próprias predições e
     * nenhum vivendo o bastante para fechar a sessão num Place Details.
     *
     * Medido em produção (07/09/2026), uma corrida do `worker-journey` do e2e-prod
     * digitando UM endereço de 19 caracteres: **309 chamadas de Autocomplete para 1
     * Place Details**. Sessão que não termina em Details é a linha CARA do Places
     * (US$ 17/1.000, franquia de 5.000/mês, contra grátis quando fecha em Details).
     *
     * O padrão aqui é o "latest ref": o efeito roda UMA vez e sempre enxerga o callback
     * mais recente. Não trocar por `useCallback` no pai — isso empurraria a correção para
     * cada consumidor e o defeito voltaria no primeiro que esquecesse.
     */
    const onChangeRef = useRef(onChange);
    const onPlaceSelectedRef = useRef(onPlaceSelected);
    const onValidationChangeRef = useRef(onValidationChange);
    useEffect(() => {
      onChangeRef.current = onChange;
      onPlaceSelectedRef.current = onPlaceSelected;
      onValidationChangeRef.current = onValidationChange;
    });

    useEffect(() => {
      if (value !== undefined) {
        setInputValue(value);
      }
    }, [value]);

    useEffect(() => {
      // O <input> é capturado AGORA: no unmount o React já zerou `inputRef.current`
      // antes de rodar este cleanup, e a limpeza dos listeners do campo era pulada em
      // silêncio. (Pego pelo teste "limpa os listeners do widget E do input".)
      const inputEl = inputRef.current;

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
            componentRestrictions: { country: ['ar', 'br', 'cl', 'co', 'mx', 'pe', 'uy'] },
            fields: ['formatted_address', 'geometry', 'address_components', 'name'],
          });

          const applyPlace = (place: google.maps.places.PlaceResult): void => {
            if (!place.formatted_address) return;
            setInputValue(place.formatted_address);
            setPlaceSelected(true);
            setShowValidationError(false);
            onChangeRef.current?.(place.formatted_address);
            onPlaceSelectedRef.current?.(place);
            onValidationChangeRef.current?.(true);
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
                componentRestrictions: { country: ['ar', 'br', 'cl', 'co', 'mx', 'pe', 'uy'] },
              },
              (predictions, status) => {
                const first = predictions?.[0];
                if (status !== google.maps.places.PlacesServiceStatus.OK || !first) return;
                const details = new google.maps.places.PlacesService(document.createElement('div'));
                details.getDetails(
                  {
                    placeId: first.place_id,
                    fields: ['formatted_address', 'geometry', 'address_components', 'name'],
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

          setApiError(null);
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
      // Dependências VAZIAS de propósito: inicializa uma vez. Os callbacks são lidos por
      // ref (ver o bloco no topo do componente) — pôr qualquer um deles aqui reintroduz
      // um widget novo por tecla, e com ele a conta do Places. O teste
      // `GooglePlacesAutocomplete.test.tsx` trava isso: com os 3 callbacks de volta aqui,
      // ele conta 20 instâncias para 19 teclas e fica vermelho.
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
      const newValue = e.target.value;
      setInputValue(newValue);
      
      // If user is typing, mark as not selected from autocomplete
      if (placeSelected) {
        setPlaceSelected(false);
        onValidationChange?.(false);
      }
      
      onChange?.(newValue);
    };

    const handleBlur = (): void => {
      // Show validation error if field has value but no place was selected
      if (requireSelection && inputValue && !placeSelected) {
        setShowValidationError(true);
        onValidationChange?.(false);
      }
    };

    return (
      <div className={`flex flex-col items-start gap-1 relative ${containerClassName}`}>
        <label className="relative w-fit mt-[-1.00px] font-lexend font-semibold text-[#374151] text-[16px] leading-[150%] whitespace-nowrap">
          {label}
        </label>
        <div className={`relative self-stretch w-full h-12 rounded-[10px] overflow-hidden border-[1.5px] border-solid transition-colors ${error || showValidationError ? 'border-red-500' : 'border-[#4B5563] focus-within:border-primary'}`}>
          <input
            ref={inputRef}
            data-testid="address-autocomplete-input"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleBlur}
            className={`absolute top-0 left-0 w-full h-full px-4 font-lexend font-medium text-[#374151] text-[14px] leading-[150%] bg-transparent outline-none placeholder:text-[#9CA3AF] ${className}`}
            {...props}
          />
        </div>
        {apiError && (
          <div className="flex items-center gap-1 mt-1 text-amber-600 text-xs">
            <AlertCircle size={12} />
            <span>{apiError}</span>
          </div>
        )}
        {showValidationError && !error && (
          <span className="absolute -bottom-5 text-red-500 text-xs">
            Por favor, selecione um endereço da lista de sugestões
          </span>
        )}
        {error && <span className="absolute -bottom-5 text-red-500 text-xs">{error}</span>}
      </div>
    );
  }
);

GooglePlacesAutocomplete.displayName = 'GooglePlacesAutocomplete';
