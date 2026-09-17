import FundedReturnsSandboxView from "../components/funded-return-sandbox";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fundedReturnsAction,
  fundedReturnsLoader,
} from "../services/funded-returns-admin.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  fundedReturnsLoader(request, authenticate.admin);

export const action = ({ request }: ActionFunctionArgs) =>
  fundedReturnsAction(request, authenticate.admin);

export default function FundedReturnsSandbox() {
  const { cases, payments, actionId } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  return (
    <FundedReturnsSandboxView
      cases={cases}
      payments={payments}
      actionId={actionId}
      error={result?.error}
      notice={result?.notice}
      busy={navigation.state !== "idle"}
      onSubmit={(values) => submit(values, { method: "post" })}
    />
  );
}

export const headers: HeadersFunction = (args) => {
  const responseHeaders = new Headers(boundary.headers(args));
  responseHeaders.set("Cache-Control", "no-store");
  return responseHeaders;
};
