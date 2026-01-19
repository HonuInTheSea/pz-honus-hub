export interface LocaleOption {
  label: string;
  value: string;
  flag: string;
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { label: 'English (United States)', value: 'en-US', flag: 'US' },
  { label: 'English (United Kingdom)', value: 'en-GB', flag: 'GB' },
  { label: 'English (Canada)', value: 'en-CA', flag: 'CA' },
  { label: 'Spanish (Argentina)', value: 'es-AR', flag: 'AR' },
  { label: 'Spanish (Spain)', value: 'es-ES', flag: 'ES' },
  { label: 'Spanish (Mexico)', value: 'es-MX', flag: 'MX' },
  { label: 'Catalan (Spain)', value: 'ca-ES', flag: 'ES' },
  { label: 'French (France)', value: 'fr-FR', flag: 'FR' },
  { label: 'French (Canada)', value: 'fr-CA', flag: 'CA' },
  { label: 'German (Germany)', value: 'de-DE', flag: 'DE' },
  { label: 'Italian (Italy)', value: 'it-IT', flag: 'IT' },
  { label: 'Portuguese (Brazil)', value: 'pt-BR', flag: 'BR' },
  { label: 'Portuguese (Portugal)', value: 'pt-PT', flag: 'PT' },
  { label: 'Dutch (Netherlands)', value: 'nl-NL', flag: 'NL' },
  { label: 'Swedish (Sweden)', value: 'sv-SE', flag: 'SE' },
  { label: 'Norwegian (Norway)', value: 'nb-NO', flag: 'NO' },
  { label: 'Danish (Denmark)', value: 'da-DK', flag: 'DK' },
  { label: 'Finnish (Finland)', value: 'fi-FI', flag: 'FI' },
  { label: 'Polish (Poland)', value: 'pl-PL', flag: 'PL' },
  { label: 'Czech (Czechia)', value: 'cs-CZ', flag: 'CZ' },
  { label: 'Hungarian (Hungary)', value: 'hu-HU', flag: 'HU' },
  { label: 'Indonesian (Indonesia)', value: 'id-ID', flag: 'ID' },
  { label: 'Romanian (Romania)', value: 'ro-RO', flag: 'RO' },
  { label: 'Thai (Thailand)', value: 'th-TH', flag: 'TH' },
  { label: 'Filipino (Philippines)', value: 'fil-PH', flag: 'PH' },
  { label: 'Turkish (Turkey)', value: 'tr-TR', flag: 'TR' },
  { label: 'Russian (Russia)', value: 'ru-RU', flag: 'RU' },
  { label: 'Ukrainian (Ukraine)', value: 'uk-UA', flag: 'UA' },
  { label: 'Chinese (Simplified)', value: 'zh-CN', flag: 'CN' },
  { label: 'Chinese (Traditional)', value: 'zh-TW', flag: 'TW' },
  { label: 'Japanese (Japan)', value: 'ja-JP', flag: 'JP' },
  { label: 'Korean (Korea)', value: 'ko-KR', flag: 'KR' },
];

export const SUPPORTED_LOCALES = LOCALE_OPTIONS.map((option) => option.value);
