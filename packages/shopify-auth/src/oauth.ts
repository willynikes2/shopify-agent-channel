import { createHmac, timingSafeEqual } from 'crypto';

const SHOPIFY_SCOPES =
  'read_products,read_product_listings,read_inventory,read_orders';

export async function generateInstallUrl(shopDomain: string): Promise<string> {
  const apiKey = process.env['SHOPIFY_API_KEY'] ?? '';
  const appUrl = process.env['SHOPIFY_APP_URL'] ?? '';
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: SHOPIFY_SCOPES,
    redirect_uri: `${appUrl}/auth/shopify/callback`,
  });
  return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

export async function handleOAuthCallback(params: {
  shop: string;
  code: string;
  hmac: string;
  timestamp: string;
}): Promise<{ accessToken: string; scopes: string }> {
  const secret = process.env['SHOPIFY_API_SECRET'] ?? '';

  // Build message from all params except hmac, sorted
  const { hmac, ...rest } = params;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k as keyof typeof rest]}`)
    .join('&');

  const expected = createHmac('sha256', secret).update(message).digest('hex');
  const actual = Buffer.from(hmac, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    throw new Error('Invalid HMAC signature');
  }

  const apiKey = process.env['SHOPIFY_API_KEY'] ?? '';
  const apiSecret = process.env['SHOPIFY_API_SECRET'] ?? '';
  const response = await fetch(`https://${params.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code: params.code }),
  });
  if (!response.ok) {
    throw new Error(`Shopify token exchange failed: ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string; scope: string };
  return { accessToken: data.access_token, scopes: data.scope };
}

export function verifyShopifyWebhook(
  body: string,
  hmacHeader: string,
  secret: string,
): boolean {
  try {
    const computed = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    const computedBuf = Buffer.from(computed, 'base64');
    const headerBuf = Buffer.from(hmacHeader, 'base64');
    if (computedBuf.length !== headerBuf.length) return false;
    return timingSafeEqual(computedBuf, headerBuf);
  } catch {
    return false;
  }
}
