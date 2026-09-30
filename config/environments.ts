import type { ProductionPolicy, TestEnvironment } from '../src/shared/types';

const disabledProductionPolicy: ProductionPolicy = {
  enabled: false,
  maxConcurrency: 1,
  requireTestAccount: true,
  blockedActions: ['delete', 'purchase', 'sendEmail', 'sendSms'],
  blockedPathPatterns: ['/delete(?:/|$)', '/payments?(?:/|$)', '/checkout(?:/|$)', '/send[-_/]?(?:email|sms)(?:/|$)', '/billing(?:/|$)'],
  blockedMethods: ['DELETE', 'POST', 'PUT', 'PATCH'],
  requestsPerMinute: 120,
};

/** Only deployment configuration can enable production; test JSON cannot. */
export function loadEnvironments(): TestEnvironment[] {
  const localURL = process.env.ENGINE_LOCAL_URL || 'http://localhost:3210';
  const stagingURL = process.env.ENGINE_STAGING_URL || 'http://localhost:3210';
  const productionURL = process.env.ENGINE_PRODUCTION_URL || 'https://app.example.com';
  const extraDomains = (process.env.ENGINE_ALLOWED_DOMAINS || '').split(',').map(v => v.trim()).filter(Boolean);
  return [
    { name: 'local', baseURL: localURL, production: false, allowedDomains: [new URL(localURL).hostname, 'localhost', '127.0.0.1'] },
    { name: 'development', baseURL: localURL, production: false, allowedDomains: [new URL(localURL).hostname, 'localhost', '127.0.0.1'] },
    { name: 'staging', baseURL: stagingURL, production: false, allowedDomains: [new URL(stagingURL).hostname, ...extraDomains] },
    { name: 'production', baseURL: productionURL, production: true, allowedDomains: [new URL(productionURL).hostname, ...extraDomains], policy: { ...disabledProductionPolicy, enabled: process.env.ENGINE_PRODUCTION_ENABLED === 'true', testAccount: process.env.ENGINE_TEST_ACCOUNT } },
  ];
}
