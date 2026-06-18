import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import PhoneInput, { Country, getCountryCallingCode, parsePhoneNumber } from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import { extractNationalNumber, getMaxDigitsForCountry, getPlaceholderForCountry, getSortedCountries } from './phoneInputHelpers';

interface PhoneInputIntlProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  defaultCountry?: Country;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  icon?: React.ReactNode;
  /** 'default' = ~56px; 'compact' = 48px (alinha com o Select do design system) */
  inputSize?: 'default' | 'compact';
}

export function PhoneInputIntl({
  value,
  onChange,
  placeholder,
  defaultCountry = 'AR',
  disabled = false,
  readOnly = false,
  className = '',
  icon,
  inputSize = 'default',
}: PhoneInputIntlProps): JSX.Element {
  const minHeightPx = inputSize === 'compact' ? 48 : 56;
  const inputFontPx = inputSize === 'compact' ? 14 : 16;
  const [country, setCountry] = useState<Country>(defaultCountry);
  const [nationalNumber, setNationalNumber] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);
  const sortedCountries = useRef<Country[]>(getSortedCountries()).current;

  // Extrair número nacional
  useEffect(() => {
    const countryCode = getCountryCallingCode(country);
    const national = extractNationalNumber(value, countryCode);
    setNationalNumber(national);
  }, [value, country]);

  // Detectar país por prefixo
  useEffect(() => {
    if (value && value.startsWith('+')) {
      try {
        const parsed = parsePhoneNumber(value);
        if (parsed?.country && parsed.country !== country) {
          setCountry(parsed.country as Country);
        }
      } catch {
        // Ignora erro
      }
    }
  }, [value, country]);

  const handleCountryChange = useCallback((newCountry: Country | undefined): void => {
    if (!newCountry || newCountry === country) return;
    
    // Manter número ao trocar país
    const newCountryCode = getCountryCallingCode(newCountry);
    const newValue = nationalNumber ? `+${newCountryCode}${nationalNumber}` : '';
    
    setCountry(newCountry);
    onChange(newValue);
  }, [country, nationalNumber, onChange]);

  const handleChange = useCallback((newValue: string | undefined): void => {
    if (!newValue) {
      onChange('');
      return;
    }

    // Extrair apenas dígitos nacionais para aplicar limite por país
    const countryCode = getCountryCallingCode(country);
    const nationalDigits = extractNationalNumber(newValue, countryCode).replace(/\D/g, '');
    const maxDigits = getMaxDigitsForCountry(country);

    // Se exceder o limite, truncar apenas os dígitos nacionais
    if (nationalDigits.length > maxDigits) {
      const truncatedNational = nationalDigits.slice(0, maxDigits);
      onChange(`+${countryCode}${truncatedNational}`);
      return;
    }

    onChange(newValue);
  }, [onChange, country]);

  const dynamicPlaceholder = placeholder || getPlaceholderForCountry(country);

  return (
    <div ref={containerRef} className={`phone-input-wrapper ${className}`}>
      <PhoneInput
        value={value}
        onChange={handleChange}
        country={country}
        onCountryChange={handleCountryChange}
        placeholder={dynamicPlaceholder}
        disabled={disabled}
        readOnly={readOnly}
        international
        countryCallingCodeEditable={false}
        defaultCountry={defaultCountry}
        countries={sortedCountries}
        countrySelectComponent={({ value: countryValue, onChange: onCountrySelectChange, disabled: selectDisabled, ...rest }) => (
          <CountrySelect
            value={countryValue as Country}
            onChange={onCountrySelectChange}
            countries={sortedCountries}
            disabled={selectDisabled || disabled || readOnly}
            {...rest}
          />
        )}
      />
      
      {icon && <span className="phone-input-icon">{icon}</span>}

      <style>{`
        .phone-input-wrapper {
          display: flex;
          align-items: center;
          min-height: ${minHeightPx}px;
          padding: 0 16px;
          border-radius: 10px;
          border: 1.5px solid #D9D9D9;
          background: white;
          gap: 8px;
          transition: border-color 0.2s ease;
        }
        
        .phone-input-wrapper:focus-within {
          border-color: #180149;
        }
        
        .phone-input-wrapper .PhoneInput {
          display: flex;
          align-items: center;
          width: 100%;
          gap: 12px;
        }
        
        .phone-input-wrapper .PhoneInputCountry {
          display: flex;
          align-items: center;
          position: relative;
        }
        
        .phone-input-wrapper .PhoneInputCountryIcon {
          width: 24px;
          height: 18px;
          border-radius: 2px;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.1);
        }
        
        .phone-input-wrapper .PhoneInputCountrySelect {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
        }
        
        .phone-input-wrapper .PhoneInputInput {
          flex: 1;
          border: none;
          outline: none;
          background: transparent;
          font-family: 'Lexend', sans-serif;
          font-size: ${inputFontPx}px;
          font-weight: 500;
          color: #374151;
        }
        
        .phone-input-wrapper .PhoneInputInput::placeholder {
          color: #D9D9D9;
        }
        
        .phone-input-icon {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

// Componente de seleção de país
interface CountrySelectProps {
  value: Country;
  onChange: (value: Country | undefined) => void;
  countries: Country[];
  disabled?: boolean;
}

function CountrySelect({ value, onChange, countries, disabled }: CountrySelectProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selectedCountry = value || 'AR';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (country: Country): void => {
    onChange(country);
    setIsOpen(false);
    setSearchTerm('');
  };

  const getCountryName = (country: Country): string => {
    return t(`countries.${country}`, country);
  };

  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    border: 'none',
    background: 'transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'Lexend, sans-serif',
    fontSize: '14px',
    fontWeight: 500,
    color: '#374151',
  };

  const flagStyle: React.CSSProperties = {
    width: '24px',
    height: '18px',
    borderRadius: '2px',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.1)',
    objectFit: 'cover',
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        style={buttonStyle}
        aria-label="Phone number country"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <img
          src={`https://flagcdn.com/w40/${selectedCountry.toLowerCase()}.png`}
          alt={selectedCountry}
          style={flagStyle}
        />
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1L5 5L9 1" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          width: '280px',
          maxHeight: '320px',
          background: 'white',
          border: '1px solid #D9D9D9',
          borderRadius: '10px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          zIndex: 1000,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #F0F0F0' }}>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('common.searchCountry', 'Buscar país...')}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #D9D9D9',
                borderRadius: '6px',
                fontFamily: 'Lexend, sans-serif',
                fontSize: '16px',
                outline: 'none',
              }}
              autoFocus
            />
          </div>
          
          <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
            {countries
              .filter(c => {
                const name = getCountryName(c).toLowerCase();
                const code = getCountryCallingCode(c);
                const search = searchTerm.toLowerCase();
                return name.includes(search) || code.includes(search);
              })
              .map(country => (
                <button
                  key={country}
                  type="button"
                  onClick={() => handleSelect(country)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    width: '100%',
                    padding: '10px 16px',
                    border: 'none',
                    background: country === selectedCountry ? '#FFF9FC' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'Lexend, sans-serif',
                    fontSize: '14px',
                    textAlign: 'left',
                  }}
                >
                  <img
                    src={`https://flagcdn.com/w40/${country.toLowerCase()}.png`}
                    alt={country}
                    style={flagStyle}
                  />
                  <span style={{ flex: 1, color: '#374151' }}>{getCountryName(country)}</span>
                  <span style={{ color: '#737373', fontSize: '13px' }}>+{getCountryCallingCode(country)}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
