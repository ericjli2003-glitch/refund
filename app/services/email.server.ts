// Transactional email through Resend. Only confirmation emails that a
// customer's own assistant request triggers are sent.
export const emailConfigured = () =>
  Boolean(process.env.RESEND_API_KEY && process.env.REFUND_EMAIL_FROM);

export const isEmailAddress = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// The address the public support and privacy pages publish, or null when it is
// unset or malformed, so neither page ever shows a broken mailto link.
export function publicSupportEmail(environment = process.env) {
  const address = environment.PUBLIC_SUPPORT_EMAIL?.trim() ?? "";
  return isEmailAddress(address) ? address : null;
}

// Mail is sent from REFUND_EMAIL_FROM on a domain whose inbound route is not
// read by anyone, so a reply to that address is lost silently. Every message
// carries a Reply-To that a person actually reads: a dedicated address when one
// is configured, otherwise the same address the support page publishes.
export function replyToAddress(environment = process.env) {
  for (const value of [
    environment.REFUND_EMAIL_REPLY_TO,
    environment.PUBLIC_SUPPORT_EMAIL,
  ]) {
    const address = value?.trim() ?? "";
    if (isEmailAddress(address)) return address;
  }
  return null;
}

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export function emailPayload(message: EmailMessage, environment = process.env) {
  const replyTo = replyToAddress(environment);
  return {
    from: environment.REFUND_EMAIL_FROM,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    // Omitted rather than sent empty when nothing is configured, so Resend
    // falls back to the From address instead of rejecting the request.
    ...(replyTo ? { reply_to: [replyTo] } : {}),
  };
}

export async function sendEmail(message: EmailMessage) {
  if (!emailConfigured()) throw new Error("Email is not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    body: JSON.stringify(emailPayload(message)),
  });
  // Never echo the provider's response: it can include the address.
  if (!response.ok) throw new Error("Gooper.io couldn't send the email.");
}
