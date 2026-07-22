export const bookingDurationOptions = [15, 30, 45, 60, 75, 90, 105, 120] as const;

// Fuso orario del campo, usato dal client come fallback finche' l'availability non risponde con
// il valore configurato (APP_TIME_ZONE). Gli orari della griglia sono "ora di parete" del campo:
// il dispositivo dell'utente non deve mai entrarci, altrimenti chi prenota dall'estero (o con il
// telefono su un altro fuso) sposterebbe la partita senza accorgersene.
export const defaultTimeZone = "Europe/Rome";
