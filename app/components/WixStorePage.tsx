import { PublicShell } from "./PublicShell";
import styles from "../styles/public.module.css";

type Props = {
  displayName: string;
  website: string | null;
  canonical: string;
  guidance: { returnPolicyUrl: string | null; returnInstructions: string | null };
};

// A Wix site's public returns page: the assistant route only.
export function WixStorePage({ displayName, website, canonical, guidance }: Props) {
  const structured = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${displayName} returns`,
    url: canonical,
    about: {
      "@type": "Organization",
      name: displayName,
      ...(website ? { url: `https://${website}` } : {}),
    },
    description:
      "Return a purchase with Gooper.io in ChatGPT or Claude and review a return estimate before anything is submitted.",
  };
  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Returns with Gooper.io</p>
        <h1>{displayName} returns.</h1>
        <p>
          Bought something from {displayName}? Your AI assistant can find the
          item and show you the refund before anything is submitted.
        </p>
        {website && (
          <p>
            Store: <a href={`https://${website}`}>{website}</a>.
          </p>
        )}
        <h2>{`Return a purchase from ${displayName}`}</h2>
        <p>
          Tell your assistant which item you want to return from {displayName}.
          Not connected yet?{" "}
          <a href="/connect">Use Gooper.io in ChatGPT or Claude</a>. One
          connection works with every store that uses Gooper.io.
        </p>
        {(guidance.returnPolicyUrl || guidance.returnInstructions) && (
          <section aria-label={`${displayName} return policy`}>
            <h2>{displayName}&apos;s return policy</h2>
            {guidance.returnPolicyUrl && (
              <p>
                <a href={guidance.returnPolicyUrl} rel="noreferrer">
                  Read the full return policy
                </a>
              </p>
            )}
            {guidance.returnInstructions && (
              <p style={{ whiteSpace: "pre-line" }}>
                {guidance.returnInstructions}
              </p>
            )}
          </section>
        )}
        <p>
          Your assistant finds your order by the email you used at checkout,
          which you confirm once from your inbox. You see the exact items and
          refund before anything is submitted.
        </p>
        <p>
          <a href="/stores">Find another store</a>
        </p>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structured).replace(/</g, "\\u003c"),
          }}
        />
      </main>
    </PublicShell>
  );
}
