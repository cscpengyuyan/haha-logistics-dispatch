import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_DATABASE } from './server.mjs';

process.umask(0o077);
let db;
try {
  const source = resolve(process.env.HAHA_DATABASE_PATH || DEFAULT_DATABASE);
  const destination = process.argv[2] && resolve(process.argv[2]);
  if (!destination || process.argv.length !== 3 || destination === source) throw new Error('用法：node server/backup.mjs <新的备份文件路径>');
  if (!existsSync(source)) throw new Error('源数据库不存在。');
  if (existsSync(destination)) throw new Error('目标文件已存在，请使用新的备份文件名。');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  await backup(db, destination);
  chmodSync(destination, 0o600);
  console.log('数据库备份完成。请妥善保存，并定期验证恢复。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
