import { randomInt } from "node:crypto";
import * as z from "zod/v4";

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    /["\\\s]/.test(email) ||
    !z.email().safeParse(email).success
  )
    throw new Error("That doesn't look like an email address.");
  return email;
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.min(Math.max(local.length - 1, 2), 5))}@${domain}`;
}

// Three numbers to choose from, including the one shown where the request
// started. Someone who types another person's email can't see that number.
export function numberChoices(matchNumber: number) {
  const choices = new Set([matchNumber]);
  while (choices.size < 3) choices.add(randomInt(10, 100));
  return [...choices].sort((left, right) => left - right);
}
