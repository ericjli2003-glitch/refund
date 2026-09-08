import type { ReactNode } from "react";
import { Link } from "react-router";

import styles from "../styles/public.module.css";

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <Link className={styles.brand} to="/">
            <span className={styles.brandMark} aria-hidden="true" />
            Refund
          </Link>
          <nav className={styles.nav} aria-label="Public navigation">
            <Link to="/stores">Find your store</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/support">Support</Link>
          </nav>
        </header>
        {children}
        <footer className={styles.footer}>
          <span>Refund for Shopify merchants</span>
          <div className={styles.footerLinks}>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/support">Support</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
