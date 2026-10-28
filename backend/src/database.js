import 'dotenv/config';
import mysql from 'mysql2/promise';

const databaseKeys = [
  'MYSQL_HOST',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
];

export async function createDatabase() {
  const configured = databaseKeys.some((key) => process.env[key]);
  
  if (!configured) {
    console.info('MySQL is not configured; generation history is disabled.');
    return null;
  }

  const missing = databaseKeys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Incomplete MySQL configuration. Missing: ${missing.join(', ')}`);
  }

  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS generations (
      id CHAR(36) PRIMARY KEY,
      prompt TEXT NOT NULL,
      language VARCHAR(40) NOT NULL,
      code LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_generations_created_at (created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  console.info('MySQL generation history is ready.');
  return pool;
}

export async function saveGeneration(database, generation) {
  if (!database) return;
  await database.execute(
    'INSERT INTO generations (id, prompt, language, code) VALUES (?, ?, ?, ?)',
    [generation.id, generation.prompt, generation.language, generation.code],
  );
}

export async function getRecentGenerations(database) {
  if (!database) {
    const error = new Error('Generation history is unavailable because MySQL is not configured.');
    error.status = 503;
    throw error;
  }

  const [rows] = await database.execute(
    'SELECT id, prompt, language, code, created_at FROM generations ORDER BY created_at DESC LIMIT 30',
  );
  return rows;
}
