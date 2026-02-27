# MCP Tool Reference

The Shopify Agent Channel exposes an MCP (Model Context Protocol) server at `/mcp` for each shop. AI assistants connect here to browse products, build carts, and initiate checkout.

---

## Connection

**Endpoint:** `POST /mcp`

**Transport:** Streamable HTTP (JSON-RPC 2.0 over HTTP with optional SSE streaming)

The server uses the standard MCP Streamable HTTP transport. Each request creates a fresh MCP server instance scoped to the resolved shop.

### Session Management

- The server generates a session ID (UUID v4) per connection
- SSE streams include a 30-second heartbeat to keep connections alive through proxies
- Maximum SSE stream duration: 5 minutes

### Initialize Handshake

Send a JSON-RPC `initialize` request to establish the session:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "my-agent", "version": "1.0.0" }
  }
}
```

The response includes server info and the session ID in the `Mcp-Session-Id` header. Include this header in subsequent requests.

---

## Tools

List tools with `tools/list`. Call them with `tools/call`.

### search_products

Search the store's product catalog.

| Property | Value |
|----------|-------|
| Safety   | low   |
| Auth     | none  |
| Type     | search |

**Input schema:**

```json
{
  "query": "red sneakers",
  "filters": {
    "color": "red",
    "minPrice": 50,
    "maxPrice": 150,
    "size": "10",
    "inStock": true,
    "productType": "Shoes",
    "vendor": "Nike"
  },
  "limit": 20
}
```

Only `query` is required. All filters are optional.

**Output:** `{ "results": [...], "totalFound": 42 }`

---

### get_product

Get full details for a specific product.

| Property | Value |
|----------|-------|
| Safety   | low   |
| Auth     | none  |
| Type     | read  |

**Input schema:**

```json
{
  "product_id": "gid://shopify/Product/123"
}
```

**Output:** `{ "product": { "id": "...", "title": "...", "variants": [...], "images": [...] } }`

---

### create_cart

Create a shopping cart with one or more line items. Requires authentication.

| Property | Value  |
|----------|--------|
| Safety   | medium |
| Auth     | Bearer token via `_meta.authToken` |
| Type     | cart   |

**Input schema:**

```json
{
  "lines": [
    { "variant_id": "gid://shopify/ProductVariant/456", "quantity": 2 }
  ]
}
```

**Output:** `{ "cart_id": "...", "lines": [...], "subtotal": "59.98", "currency": "USD" }`

---

### initiate_checkout

Generate a Shopify checkout URL for a cart. The user completes payment through Shopify's native checkout (Shop Pay, Apple Pay, etc.). Requires authentication.

| Property | Value  |
|----------|--------|
| Safety   | high   |
| Auth     | Bearer token via `_meta.authToken` |
| Type     | checkout |
| Confirmation | required |

**Input schema:**

```json
{
  "cart_id": "gid://shopify/Cart/abc123"
}
```

**Output:** `{ "checkout_url": "https://store.myshopify.com/checkouts/abc123", "expires_at": "..." }`

---

## Authentication for Write Tools

Read tools (`search_products`, `get_product`) require no authentication.

Write tools (`create_cart`, `initiate_checkout`) require a Bearer token passed in `_meta.authToken` within the `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_cart",
    "arguments": {
      "lines": [{ "variant_id": "gid://shopify/ProductVariant/456", "quantity": 1 }]
    },
    "_meta": {
      "authToken": "your-bearer-token-here"
    }
  }
}
```

If a write tool is called without a valid token, the response will be:

```json
{
  "content": [{ "type": "text", "text": "Authentication required. Provide a valid API token in _meta.authToken." }],
  "isError": true
}
```

---

## Safety Levels

| Level  | Meaning | Tools |
|--------|---------|-------|
| low    | Read-only, no side effects | `search_products`, `get_product` |
| medium | Creates server-side state (cart) | `create_cart` |
| high   | Initiates a financial transaction | `initiate_checkout` |

Agents should display appropriate confirmation prompts for medium and high safety tools. The `initiate_checkout` tool has `requiresConfirmation: true` in the manifest -- the user always completes payment through Shopify's native checkout page.

---

## Error Handling

Tool call errors return `isError: true` with a text description:

```json
{
  "content": [{ "type": "text", "text": "Error: Product not found" }],
  "isError": true
}
```

Unknown tool names return:

```json
{
  "content": [{ "type": "text", "text": "Unknown tool: bad_tool_name" }],
  "isError": true
}
```
