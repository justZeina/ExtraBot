import { fail } from './errors.js';

export function loadConfig(env = process.env) {
  const workingWeekdays = (env.EXTRABOT_WORKING_WEEKDAYS || '0,1,2,3,4').split(',').map(value => Number(value.trim()));
  const holidays = (env.EXTRABOT_HOLIDAYS || '').split(',').map(value => value.trim()).filter(Boolean);
  const ceoSlackUserId = (env.EXTRABOT_CEO_SLACK_USER_ID || 'U0C542YNA7M').trim();
  if (!ceoSlackUserId) fail('VALIDATION_ERROR', 'EXTRABOT_CEO_SLACK_USER_ID is required');
  return { ceoSlackUserId, workingWeekdays, holidays };
}

export function loadSlackConfig(env = process.env) {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const appToken = env.SLACK_APP_TOKEN?.trim();
  if (!botToken || !appToken) fail('VALIDATION_ERROR', 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN are both required');
  if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-')) {
    fail('VALIDATION_ERROR', 'Slack tokens must have xoxb- and xapp- prefixes');
  }
  return { botToken, appToken };
}
