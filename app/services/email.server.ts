// Transactional email through Resend. Only confirmation emails that a
// customer's own assistant request triggers are sent.
export const emailConfigured = () =>
  Boolean(process.env.RESEND_API_KEY && process.env.REFUND_EMAIL_FROM);

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export async function sendEmail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}) {
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
    body: JSON.stringify({
      from: process.env.REFUND_EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  // Never echo the provider's response: it can include the address.
  if (!response.ok) throw new Error("Gooper.io couldn't send the email.");
}
