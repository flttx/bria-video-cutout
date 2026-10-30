import '../apps/api/src/env.ts';

// Match the default local webpage; an explicit origin in API configuration wins.
process.env.WEB_ORIGIN ||= 'http://localhost:8080';
await import('../apps/api/src/server.ts');
