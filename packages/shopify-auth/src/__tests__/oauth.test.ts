import { createHmac } from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyShopifyWebhook, generateInstallUrl } from '../oauth.js';

describe('verifyShopifyWebhook', () => {
  const SECRET = 'test_shopify_secret';
  const BODY = JSON.stringify({ topic: 'app/uninstalled', shop_domain: 'test.myshopify.com' });

  it('returns true for a valid HMAC', () => {
    const hmac = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('base64');
    expect(verifyShopifyWebhook(BODY, hmac, SECRET)).toBe(true);
  });

  it('returns false for an invalid HMAC', () => {
    expect(verifyShopifyWebhook(BODY, 'invalid_hmac_value', SECRET)).toBe(false);
  });

  it('returns false when body is tampered after signing', () => {
    const hmac = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('base64');
    expect(verifyShopifyWebhook(BODY + 'x', hmac, SECRET)).toBe(false);
  });

  it('returns false when wrong secret is used', () => {
    const hmac = createHmac('sha256', 'wrong_secret').update(BODY, 'utf8').digest('base64');
    expect(verifyShopifyWebhook(BODY, hmac, SECRET)).toBe(false);
  });
});

describe('generateInstallUrl', () => {
  beforeEach(() => {
    process.env['SHOPIFY_API_KEY'] = 'test_api_key';
    process.env['SHOPIFY_APP_URL'] = 'https://my-app.example.com';
  });

  it('contains the shop domain', async () => {
    const url = await generateInstallUrl('cool-kicks.myshopify.com');
    expect(url).toContain('cool-kicks.myshopify.com');
  });

  it('points to the Shopify OAuth authorize endpoint', async () => {
    const url = await generateInstallUrl('cool-kicks.myshopify.com');
    expect(url).toContain('/admin/oauth/authorize');
  });

  it('includes required read scopes', async () => {
    const url = await generateInstallUrl('cool-kicks.myshopify.com');
    expect(url).toContain('read_products');
    expect(url).toContain('read_inventory');
  });

  it('includes client_id and redirect_uri', async () => {
    const url = await generateInstallUrl('cool-kicks.myshopify.com');
    expect(url).toContain('client_id=test_api_key');
    expect(url).toContain('redirect_uri=');
  });
});
