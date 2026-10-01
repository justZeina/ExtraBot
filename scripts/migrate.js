import { openDatabase } from '../src/db.js';

const db = openDatabase(process.env.EXTRABOT_DB_PATH || './extrabot.sqlite');
db.close();
console.log('Database migrated.');
