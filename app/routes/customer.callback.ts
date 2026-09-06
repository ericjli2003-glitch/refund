import type { LoaderFunctionArgs } from "react-router";
import { finishCustomerLogin } from "../services/customer-session.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  finishCustomerLogin(request);
