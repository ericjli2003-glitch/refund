import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

// Proxima Nova is licensed, so it loads only from an Adobe Fonts kit set in
// ADOBE_FONTS_KIT_ID; pages fall back to similar fonts without one.
export const loader = () => {
  const kit = process.env.ADOBE_FONTS_KIT_ID;
  return { adobeFontsKit: kit && /^[a-z0-9]{5,12}$/.test(kit) ? kit : null };
};

export default function App() {
  const { adobeFontsKit } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {adobeFontsKit && (
          <link
            rel="stylesheet"
            href={`https://use.typekit.net/${adobeFontsKit}.css`}
          />
        )}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
