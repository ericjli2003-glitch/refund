import type { ActionFunctionArgs } from "react-router";

import { shopUpdateWebhookAction } from "../services/merchant-maintenance.server";
import { authenticate } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  shopUpdateWebhookAction(request, authenticate.webhook);
