export interface ShopifyVariant {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  status: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  updatedAt: string | null;
}

export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
  description: string | null;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ShopInfo {
  name: string;
  currency: string;
  domain: string;
  myshopifyDomain: string;
  plan: string;
}

const ADMIN_API_VERSION = '2024-01';

const SHOP_QUERY = `
  query {
    shop {
      name
      currencyCode
      myshopifyDomain
      primaryDomain { url }
      plan { displayName }
    }
  }
`;

const PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id title description productType vendor tags status updatedAt
          variants(first: 100) {
            edges { node { id title price sku inventoryQuantity selectedOptions { name value } } }
          }
          images(first: 10) {
            edges { node { url altText } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COLLECTIONS_QUERY = `
  query getCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges { node { id title handle description } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export class ShopifyClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(shopDomain: string, accessToken: string) {
    this.url = `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    };
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
    const json = (await res.json()) as {
      data: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${json.errors[0]!.message}`);
    }
    return json.data;
  }

  async fetchShopInfo(): Promise<ShopInfo> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ shop: any }>(SHOP_QUERY);
    const s = data.shop;
    return {
      name: s.name,
      currency: s.currencyCode,
      domain: s.primaryDomain?.url ?? '',
      myshopifyDomain: s.myshopifyDomain,
      plan: s.plan?.displayName ?? 'unknown',
    };
  }

  async fetchProducts(
    cursor?: string,
    limit = 50,
  ): Promise<{ products: ShopifyProduct[]; pageInfo: PageInfo }> {
    const data = await this.graphql<{ products: { edges: { node: unknown }[]; pageInfo: PageInfo } }>(
      PRODUCTS_QUERY,
      { first: limit, after: cursor ?? null },
    );
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      products: data.products.edges.map(({ node }: any) => ({
        id: node.id,
        title: node.title,
        description: node.description ?? null,
        productType: node.productType ?? null,
        vendor: node.vendor ?? null,
        tags: node.tags ?? [],
        status: (node.status as string).toLowerCase(),
        variants: (node.variants?.edges ?? []).map(({ node: v }: any) => ({
          id: v.id,
          title: v.title,
          price: v.price,
          sku: v.sku ?? null,
          inventoryQuantity: v.inventoryQuantity ?? 0,
          selectedOptions: v.selectedOptions ?? [],
        })),
        images: (node.images?.edges ?? []).map(({ node: img }: any) => ({
          url: img.url,
          altText: img.altText ?? null,
        })),
        updatedAt: node.updatedAt ?? null,
      })),
      pageInfo: data.products.pageInfo,
    };
  }

  async fetchCollections(
    cursor?: string,
    limit = 50,
  ): Promise<{ collections: ShopifyCollection[]; pageInfo: PageInfo }> {
    const data = await this.graphql<{ collections: { edges: { node: unknown }[]; pageInfo: PageInfo } }>(
      COLLECTIONS_QUERY,
      { first: limit, after: cursor ?? null },
    );
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collections: data.collections.edges.map(({ node }: any) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        description: node.description ?? null,
      })),
      pageInfo: data.collections.pageInfo,
    };
  }
}
