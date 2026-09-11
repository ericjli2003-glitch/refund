import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function storefrontConfig(source) {
  // application_url is a top-level Shopify TOML setting. Restrict this reader to
  // a single quoted scalar; reject ambiguous input instead of guessing a host.
  const topLevel = source.split(/^\s*\[/m)[0];
  const values = [
    ...topLevel.matchAll(
      /^application_url\s*=\s*("[^"\n]*"|'[^'\n]*')\s*(?:#.*)?$/gm,
    ),
  ];
  if (values.length !== 1)
    throw new Error(
      "Expected one application_url in the Shopify app configuration.",
    );
  const value = values[0][1];
  const url = new URL(
    value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1),
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Storefront deployment requires an HTTPS application_url origin without credentials, a path, or query parameters.",
    );
  if (!/^[a-z0-9.:-]+$/i.test(url.host))
    throw new Error("Unsupported application host.");
  return `{% comment %}Generated from the selected Shopify app configuration. Run npm run storefront:configure; do not edit.{% endcomment %}\n{{- '${url.origin}' -}}\n`;
}

export async function configureStorefront(
  configPath = "shopify.app.toml",
  check = false,
) {
  const output =
    "extensions/refund-site-tools/snippets/refund-app-origin.liquid";
  const expected = storefrontConfig(await readFile(configPath, "utf8"));
  if (check) {
    if ((await readFile(output, "utf8")) !== expected)
      throw new Error(
        "Storefront URLs do not match this Shopify app configuration. Run npm run storefront:configure.",
      );
  } else {
    await writeFile(output, expected);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  await configureStorefront(
    args.find((arg) => arg !== "--check"),
    args.includes("--check"),
  );
}
