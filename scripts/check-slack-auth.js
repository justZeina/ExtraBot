import { loadSlackConfig } from '../src/config.js';

const { botToken } = loadSlackConfig();
try {
  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST', headers: { Authorization: `Bearer ${botToken}` }
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || 'authentication failed');
  const scopes = (response.headers.get('x-oauth-scopes') || '').split(',').map(x => x.trim()).filter(Boolean);
  const required = ['commands', 'chat:write', 'im:write'];
  const missing = required.filter(scope => !scopes.includes(scope));
  console.log(`Slack bot authentication OK. Required scopes: ${missing.length ? `missing ${missing.join(', ')}` : 'all present'}.`);
  if (missing.length) process.exitCode = 1;
} catch (error) {
  console.error(`Slack authentication check failed: ${error.message}`);
  process.exitCode = 1;
}
