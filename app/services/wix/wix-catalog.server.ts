import { WixApiError, type WixApi } from "./wix-api.server";

// Wix Stores runs one of two catalogs per site. Catalog V1 groups products in
// collections; Catalog V3 replaced collections with categories. A merchant's
// final-sale list (StorePolicy.finalSaleCollectionIds) holds whichever of the
// two the site uses, as the settings page lists them with listWixCollections.
export type WixCatalogVersion = "V1_CATALOG" | "V3_CATALOG" | "STORES_NOT_INSTALLED";

// Wix Stores' app ID on order line items' catalogReference.appId.
export const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e";

export async function wixCatalogVersion(api: WixApi): Promise<WixCatalogVersion> {
  const { catalogVersion } = await api<{ catalogVersion?: string }>(
    "GET",
    "/stores/v3/provision/version",
  );
  if (catalogVersion === "V1_CATALOG" || catalogVersion === "V3_CATALOG")
    return catalogVersion;
  return "STORES_NOT_INSTALLED";
}

const COLLECTION_PAGE = 100;
// Enough for any settings page; stops a misbehaving cursor from looping.
const MAX_COLLECTION_PAGES = 20;

type Named = { id?: string | null; name?: string | null };

const named = (items: Named[] | undefined) =>
  (items ?? []).flatMap((item) =>
    item.id ? [{ id: item.id, name: item.name?.trim() || "Untitled" }] : [],
  );

// The site's Stores collections (Catalog V1) or categories (Catalog V3), for
// the merchant to pick final-sale ones from.
export async function listWixCollections(
  api: WixApi,
): Promise<Array<{ id: string; name: string }>> {
  const version = await wixCatalogVersion(api);
  const found: Array<{ id: string; name: string }> = [];
  if (version === "V1_CATALOG") {
    for (let page = 0; page < MAX_COLLECTION_PAGES; page++) {
      const { collections } = await api<{ collections?: Named[] }>(
        "POST",
        "/stores-reader/v2/collections/query",
        {
          query: {
            paging: { limit: COLLECTION_PAGE, offset: page * COLLECTION_PAGE },
          },
        },
      );
      found.push(...named(collections));
      if ((collections?.length ?? 0) < COLLECTION_PAGE) break;
    }
  } else if (version === "V3_CATALOG") {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_COLLECTION_PAGES; page++) {
      const { categories, pagingMetadata } = await api<{
        categories?: Named[];
        pagingMetadata?: { hasNext?: boolean | null; cursors?: { next?: string | null } };
      }>("POST", "/categories/v1/categories/query", {
        query: { cursorPaging: { limit: COLLECTION_PAGE, ...(cursor ? { cursor } : {}) } },
        // Wix Stores keeps exactly one category tree per site.
        treeReference: { appNamespace: "@wix/stores" },
        // A hidden category still marks its products final sale.
        returnNonVisibleCategories: true,
      });
      found.push(...named(categories));
      cursor = pagingMetadata?.cursors?.next ?? undefined;
      if (!pagingMetadata?.hasNext || !cursor) break;
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const PRODUCT_LOOKUPS_AT_ONCE = 5;

async function productGroupIds(
  api: WixApi,
  version: "V1_CATALOG" | "V3_CATALOG",
  productId: string,
) {
  const id = encodeURIComponent(productId);
  try {
    if (version === "V1_CATALOG") {
      const { product } = await api<{ product?: { collectionIds?: string[] } }>(
        "GET",
        `/stores-reader/v1/products/${id}`,
      );
      return product?.collectionIds ?? [];
    }
    // ALL_ includes parent categories, so marking a parent category final
    // sale covers its subcategories too.
    const { product } = await api<{
      product?: { allCategoriesInfo?: { categories?: Array<{ id?: string }> } };
    }>("GET", `/stores/v3/products/${id}?fields=ALL_CATEGORIES_INFO`);
    return (product?.allCategoriesInfo?.categories ?? []).flatMap((category) =>
      category.id ? [category.id] : [],
    );
  } catch (error) {
    // A product deleted since the order has no collections left, the same as
    // a Shopify line item whose product is gone.
    // UNVERIFIED: that a V3 product hidden from the storefront reads with the
    // app's permissions and not as a 404 (needs SCOPE.STORES.PRODUCT_READ_ADMIN).
    if (error instanceof WixApiError && error.status === 404) return [];
    throw error;
  }
}

// Wix Stores product IDs, among `productIds`, that sit in any of the
// final-sale collections (V1) or categories (V3).
export async function finalSaleProductIds(
  api: WixApi,
  productIds: string[],
  collectionIds: string[],
) {
  const found = new Set<string>();
  const unique = [...new Set(productIds)];
  if (!unique.length || !collectionIds.length) return found;
  const version = await wixCatalogVersion(api);
  if (version === "STORES_NOT_INSTALLED") return found;
  const wanted = new Set(collectionIds);
  for (let start = 0; start < unique.length; start += PRODUCT_LOOKUPS_AT_ONCE) {
    const batch = unique.slice(start, start + PRODUCT_LOOKUPS_AT_ONCE);
    const groups = await Promise.all(
      batch.map((productId) => productGroupIds(api, version, productId)),
    );
    batch.forEach((productId, index) => {
      if (groups[index].some((group) => wanted.has(group))) found.add(productId);
    });
  }
  return found;
}
