/**
 * eRepublik countryId → ISO 3166-1 alpha-2 code mapping. Used to derive the
 * Unicode regional-indicator flag emoji at render time (instead of shipping
 * 74 hardcoded surrogate-pair strings). IDs are not sequential — they are
 * the platform-assigned values used in `/en/military/campaignsJson/list`
 * and related endpoints.
 */
const ISO_BY_COUNTRY_ID: Readonly<Record<number, string>> = {
  1: 'RO', // Romania
  9: 'BR', // Brazil
  10: 'IT', // Italy
  11: 'FR', // France
  12: 'DE', // Germany
  13: 'HU', // Hungary
  14: 'CN', // China
  15: 'ES', // Spain
  23: 'CA', // Canada
  24: 'US', // USA
  26: 'MX', // Mexico
  27: 'AR', // Argentina
  28: 'VE', // Venezuela
  29: 'GB', // United Kingdom
  30: 'CH', // Switzerland
  31: 'NL', // Netherlands
  32: 'BE', // Belgium
  33: 'AT', // Austria
  34: 'CZ', // Czech Republic
  35: 'PL', // Poland
  36: 'SK', // Slovakia
  37: 'NO', // Norway
  38: 'SE', // Sweden
  39: 'FI', // Finland
  40: 'UA', // Ukraine
  41: 'RU', // Russia
  42: 'BG', // Bulgaria
  43: 'TR', // Turkey
  44: 'GR', // Greece
  45: 'JP', // Japan
  47: 'KR', // South Korea
  48: 'IN', // India
  49: 'ID', // Indonesia
  50: 'AU', // Australia
  51: 'ZA', // South Africa
  52: 'MD', // Moldova
  53: 'PT', // Portugal
  54: 'IE', // Ireland
  55: 'DK', // Denmark
  56: 'IR', // Iran
  57: 'PK', // Pakistan
  58: 'IL', // Israel
  59: 'TH', // Thailand
  61: 'SI', // Slovenia
  63: 'HR', // Croatia
  64: 'CL', // Chile
  65: 'RS', // Serbia
  66: 'MY', // Malaysia
  67: 'PH', // Philippines
  68: 'SG', // Singapore
  69: 'BA', // Bosnia and Herzegovina
  70: 'EE', // Estonia
  71: 'LV', // Latvia
  72: 'LT', // Lithuania
  73: 'KP', // North Korea
  74: 'UY', // Uruguay
  75: 'PY', // Paraguay
  76: 'BO', // Bolivia
  77: 'PE', // Peru
  78: 'CO', // Colombia
  79: 'MK', // North Macedonia
  80: 'ME', // Montenegro
  81: 'TW', // Taiwan (Republic of China)
  82: 'CY', // Cyprus
  83: 'BY', // Belarus
  84: 'NZ', // New Zealand
  164: 'SA', // Saudi Arabia
  165: 'EG', // Egypt
  166: 'AE', // United Arab Emirates
  167: 'AL', // Albania
  168: 'GE', // Georgia
  169: 'AM', // Armenia
  170: 'NG', // Nigeria
  171: 'CU', // Cuba
};

/** Base offset between ASCII uppercase A (65) and the Regional Indicator A (0x1F1E6 = 127462). */
const REGIONAL_INDICATOR_OFFSET = 127397;

/**
 * Returns the flag emoji for an eRepublik countryId, or 🏳️ when the mapping
 * is missing (e.g., a newly added country that hasn't been catalogued yet).
 */
export function flagFor(countryId: number): string {
  const code = ISO_BY_COUNTRY_ID[countryId];
  if (!code) return '🏳️';
  return code
    .toUpperCase()
    .split('')
    .map((ch) => String.fromCodePoint(REGIONAL_INDICATOR_OFFSET + ch.charCodeAt(0)))
    .join('');
}

/** Exposed only for tests / debugging. */
export function isoCodeFor(countryId: number): string | undefined {
  return ISO_BY_COUNTRY_ID[countryId];
}
