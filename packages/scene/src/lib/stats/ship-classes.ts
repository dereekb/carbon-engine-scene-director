/**
 * The ship classes the class values key on: the flight numbers when the EVE data cannot name the hull (the page's
 * flight.ts) and the stand-in combat numbers without EVE data (combat/stand-ins.ts).
 */

export const SHIP_CLASSES = ['frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'capital', 'titan'] as const;

export type ShipClass = (typeof SHIP_CLASSES)[number];
