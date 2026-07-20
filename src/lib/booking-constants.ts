export const bookingDurationOptions = [15, 30, 45, 60, 75, 90, 105, 120] as const;

// Fascia oraria di apertura di default (ora locale del fuso configurato). Sono i valori usati
// quando APP_OPENING_HOUR / APP_CLOSING_HOUR non sono impostate e i fallback lato client prima
// che l'endpoint availability risponda con le impostazioni reali.
export const defaultOpeningHour = 8;
export const defaultClosingHour = 22;
