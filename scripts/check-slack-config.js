import { loadSlackConfig } from '../src/config.js';

try {
  loadSlackConfig();
  console.log('Slack configuration OK: bot and app tokens loaded from the environment.');
} catch (error) {
  console.error(`Slack configuration error: ${error.message}`);
  process.exitCode = 1;
}
