import type { LoaderFunctionArgs } from "react-router";
import { startCustomerLogin } from "../services/customer-session.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  startCustomerLogin(request);
