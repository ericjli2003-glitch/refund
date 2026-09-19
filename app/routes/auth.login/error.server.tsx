import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Open Gooper.io from your Shopify admin, or install it from the Shopify App Store." };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "That store link isn't valid. Open Gooper.io from your Shopify admin, or install it from the Shopify App Store." };
  }

  return {};
}
