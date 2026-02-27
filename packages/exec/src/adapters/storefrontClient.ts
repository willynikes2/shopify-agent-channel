const STOREFRONT_API_VERSION = '2024-01';

export interface CartLine {
  id: string;
  quantity: number;
  title: string;
  price: string;
}

export interface CartCreateResult {
  id: string;
  checkoutUrl: string;
  lines: CartLine[];
  subtotal: string;
  currency: string;
}

export interface CartGetResult {
  id: string;
  checkoutUrl: string;
}

const CART_CREATE_MUTATION = `
  mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        id
        checkoutUrl
        lines(first: 10) {
          edges {
            node {
              id
              quantity
              merchandise {
                ... on ProductVariant {
                  id
                  title
                  price { amount currencyCode }
                  product { title }
                }
              }
            }
          }
        }
        cost {
          subtotalAmount { amount currencyCode }
        }
      }
      userErrors { field message }
    }
  }
`;

const CART_GET_QUERY = `
  query getCart($cartId: ID!) {
    cart(id: $cartId) {
      id
      checkoutUrl
    }
  }
`;

export class StorefrontClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(shopDomain: string, storefrontAccessToken: string) {
    this.url = `https://${shopDomain}/api/${STOREFRONT_API_VERSION}/graphql.json`;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': storefrontAccessToken,
    };
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Storefront API error: ${res.status}`);
    const json = (await res.json()) as { data: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(`Storefront GraphQL error: ${json.errors[0]!.message}`);
    }
    return json.data;
  }

  async cartCreate(lines: { merchandiseId: string; quantity: number }[]): Promise<CartCreateResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ cartCreate: { cart: any; userErrors: any[] } }>(
      CART_CREATE_MUTATION,
      { input: { lines } },
    );
    if (data.cartCreate.userErrors.length) {
      throw new Error(`Cart error: ${data.cartCreate.userErrors[0]!.message}`);
    }
    const cart = data.cartCreate.cart;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cartLines: CartLine[] = (cart.lines?.edges ?? []).map(({ node }: any) => ({
      id: node.id,
      quantity: node.quantity,
      title: `${node.merchandise?.product?.title ?? ''} / ${node.merchandise?.title ?? ''}`.trim(),
      price: node.merchandise?.price?.amount ?? '0.00',
    }));
    return {
      id: cart.id,
      checkoutUrl: cart.checkoutUrl,
      lines: cartLines,
      subtotal: cart.cost?.subtotalAmount?.amount ?? '0.00',
      currency: cart.cost?.subtotalAmount?.currencyCode ?? 'USD',
    };
  }

  async getCart(cartId: string): Promise<CartGetResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.graphql<{ cart: any }>(CART_GET_QUERY, { cartId });
    if (!data.cart) throw new Error(`Cart ${cartId} not found`);
    return { id: data.cart.id, checkoutUrl: data.cart.checkoutUrl };
  }
}
