import { randomInt, randomUUID } from "node:crypto";

// No 0/O/1/I/L to avoid confusion when players share codes verbally
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Public player code like PC-8K3F9Q. ~887M combinations at length 6. */
export function generatePlayerCode(length = 6): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return `PC-${s}`;
}

export function generateId(): string {
  return randomUUID();
}

/** 6-digit numeric one-time code */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
