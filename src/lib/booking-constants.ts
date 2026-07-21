export const bookingDurationOptions = [15, 30, 45, 60, 75, 90, 105, 120] as const;

// Fascia oraria di apertura di default (ora locale del fuso configurato). Sono i valori usati
// quando APP_OPENING_HOUR / APP_CLOSING_HOUR non sono impostate e i fallback lato client prima
// che l'endpoint availability risponda con le impostazioni reali. Il default e' la giornata
// piena (00-24, ultimo slot 23:45): il campo aziendale non ha orari, resta solo il vincolo che
// la partita finisca entro la mezzanotte. Una fascia ridotta si riattiva via env.
export const defaultOpeningHour = 0;
export const defaultClosingHour = 24;
