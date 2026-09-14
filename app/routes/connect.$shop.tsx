import { redirect } from "react-router";

// Store-specific setup pages now point to the one connection for every store.
export const loader = () => redirect("/connect");
