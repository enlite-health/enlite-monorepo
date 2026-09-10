import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useGooglePlacesAutocomplete } from '@presentation/hooks/useGooglePlacesAutocomplete';

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

/**
 * Campo de endereço com rótulo e moldura próprios (cadastro do prestador).
 *
 * A ligação com o Google — e com ela a disciplina que segura a conta do Places —
 * mora no `useGooglePlacesAutocomplete`, não aqui. Uma tela com outro desenho
 * (formulário denso do painel) usa o HOOK, nunca uma cópia desta ligação.
 */
export const GooglePlacesAutocomplete = forwardRef<HTMLInputElement, GooglePlacesAutocompleteProps>(
  ({ label, error, containerClassName = '', className = '', onPlaceSelected, onChange, onValidationChange, value, requireSelection = true, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [inputValue, setInputValue] = useState(value || '');
    const [placeSelected, setPlaceSelected] = useState(!!value); // Se tem valor inicial, considera selecionado
    const [showValidationError, setShowValidationError] = useState(false);

    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    // Arrow inline de propósito: o hook lê sempre a versão mais recente por ref, e
    // é isso que permite UM widget por campo em vez de um por tecla.
    const { apiError } = useGooglePlacesAutocomplete({
      inputRef,
      onPlaceApplied: (place) => {
        const formatted = place.formatted_address as string;
        setInputValue(formatted);
        setPlaceSelected(true);
        setShowValidationError(false);
        onChange?.(formatted);
        onPlaceSelected?.(place);
        onValidationChange?.(true);
      },
    });

    useEffect(() => {
      if (value !== undefined) {
        setInputValue(value);
      }
    }, [value]);

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
