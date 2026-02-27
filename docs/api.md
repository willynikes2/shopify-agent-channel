# HTTP API Reference

Base URL: `https://{shop-domain}.shopify-agent-channel.dev` or `/shop/{shop-domain}/` path-prefix mode.

All responses are JSON. The edge worker resolves the shop from the `Host` header, `X-Shop-Domain` header, or `/shop/:domain/` path prefix.

---

## Public Routes

No authentication required. Rate limited at 200 requests/minute per IP.

### GET `/.well-known/agents.json`

Returns the active agent manifest for the shop.

```json
{
  "schema_version": "1.0",
  "name": "My Store Agent",
  "capabilities": [
    { "id": "search_products", "type": "search", "safety": "low", ... },
    { "id": "get_product", "type": "read", "safety": "low", ... },
    { "id": "create_cart", "type": "cart", "safety": "medium", ... },
    { "id": "initiate_checkout", "type": "checkout", "safety": "high", ... }
  ]
}
```

### GET `/api/products/search`

Search the store's product catalog.

**Query parameters:**

| Param       | Type    | Required | Description              |
|-------------|---------|----------|--------------------------|
| `q`         | string  | yes      | Search query             |
| `size`      | string  | no       | Filter by size           |
| `color`     | string  | no       | Filter by color          |
| `min_price` | number  | no       | Minimum price            |
| `max_price` | number  | no       | Maximum price            |
| `in_stock`  | boolean | no       | Only in-stock items      |
| `limit`     | integer | no       | Max results (default 20) |

**Response (200):**

```json
{
  "results": [
    {
      "id": "gid://shopify/Product/123",
      "title": "Classic T-Shirt",
      "vendor": "BrandName",
      "price": "29.99",
      "currency": "USD",
      "available": true,
      "image_url": "https://cdn.shopify.com/..."
    }
  ],
  "totalFound": 42
}
```

### GET `/api/products/:product_id`

Get full details for a single product.

**Response (200):**

```json
{
  "product": {
    "id": "gid://shopify/Product/123",
    "title": "Classic T-Shirt",
    "description": "A comfortable everyday tee.",
    "vendor": "BrandName",
    "variants": [
      {
        "id": "gid://shopify/ProductVariant/456",
        "title": "Medium / Black",
        "price": "29.99",
        "available": true,
        "sku": "TSHIRT-M-BLK"
      }
    ],
    "images": ["https://cdn.shopify.com/..."]
  }
}
```

**Response (404):**

```json
{ "error": "Product not found" }
```

### GET `/api/success-score`

Returns success score metrics for the shop.

```json
{
  "scores": [
    { "shopId": "shop_abc", "metric": "conversion_rate", "value": 0.12, "period": "7d" }
  ]
}
```

---

## Authenticated Routes

Require `Authorization: Bearer <token>` header. Rate limited at 30 requests/minute per token.

### POST `/api/cart`

Create a shopping cart.

**Request:**

```json
{
  "lines": [
    { "variant_id": "gid://shopify/ProductVariant/456", "quantity": 2 },
    { "variant_id": "gid://shopify/ProductVariant/789", "quantity": 1 }
  ]
}
```

**Response (201):**

```json
{
  "cart_id": "gid://shopify/Cart/abc123",
  "lines": [
    { "variant_id": "gid://shopify/ProductVariant/456", "quantity": 2, "price": "29.99" }
  ],
  "subtotal": "89.97",
  "currency": "USD"
}
```

### POST `/api/cart/:cart_id/checkout`

Get a Shopify checkout URL for the cart. The user completes payment through Shopify's native checkout (Shop Pay, Apple Pay, etc.).

**Response (200):**

```json
{
  "checkout_url": "https://my-store.myshopify.com/checkouts/abc123",
  "expires_at": "2026-02-28T12:00:00Z"
}
```

---

## Admin Routes

Require `Authorization: Bearer <ADMIN_API_KEY>` header. Rate limited at 10 requests/minute per IP.

### POST `/admin/shops`

Look up a registered shop.

**Request:**

```json
{ "shop_domain": "my-store.myshopify.com" }
```

**Response (200):**

```json
{ "shop": { "id": "shop_abc", "shopDomain": "my-store.myshopify.com", ... } }
```

### POST `/admin/shops/:id/sync`

Trigger an async product catalog sync for a shop. Returns immediately.

**Response (202):**

```json
{ "ok": true, "shopId": "shop_abc", "message": "Sync triggered" }
```

### GET `/admin/shops/:id/manifest`

Retrieve the active agents.json manifest for a shop.

### GET `/admin/shops/:id/runs`

List recent tool execution runs. Accepts `?limit=N` (default 20).

**Response (200):**

```json
{
  "runs": [
    { "id": "run_1", "shopId": "shop_abc", "toolName": "search_products", "status": "success", "createdAt": "..." }
  ]
}
```

### POST `/internal/reverify`

Trigger nightly reverification of shop access tokens and catalog freshness.

**Response (200):**

```json
{ "ok": true, "message": "Reverification scheduled" }
```

---

## Auth Routes

### GET `/auth/shopify?shop=my-store.myshopify.com`

Starts the Shopify OAuth install flow. Redirects to Shopify's authorization page.

### GET `/auth/shopify/callback`

OAuth callback. Exchanges the authorization code for an access token.

### POST `/webhooks/shopify`

Receives Shopify webhooks. Validates the `X-Shopify-Hmac-Sha256` signature against `SHOPIFY_API_SECRET`.

Handled topics:
- `app/uninstalled` -- marks shop as uninstalled
- `products/update` -- triggers catalog update

---

## Error Responses

All errors follow the same shape:

```json
{ "error": "Description of what went wrong" }
```

| Status | Meaning                          |
|--------|----------------------------------|
| 400    | Bad request / missing parameters |
| 401    | Authentication required or invalid |
| 404    | Resource not found               |
| 429    | Rate limit exceeded (includes `Retry-After` header) |
| 500    | Internal server error            |

---

## Rate Limits

Sliding window of 60 seconds.

| Tier  | Routes                        | Limit         |
|-------|-------------------------------|---------------|
| read  | GET `/api/*`, `/.well-known/*` | 200 req/min  |
| write | POST `/api/cart*`             | 30 req/min   |
| admin | `/admin/*`, `/internal/*`     | 10 req/min   |

Rate limit headers: `X-RateLimit-Remaining`, `Retry-After` (on 429).
