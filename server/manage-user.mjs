import { resolve } from 'node:path';
import { openDatabase, setUser, disableUser } from './database.mjs';
import { DEFAULT_DATABASE } from './server.mjs';

process.umask(0o077);
const [command, username, flag, role] = process.argv.slice(2);
let db;
try {
  db = openDatabase(resolve(process.env.HAHA_DATABASE_PATH || DEFAULT_DATABASE));
  if (command === 'list' && !username) {
    console.table(db.prepare('SELECT username,role,enabled,created_at,updated_at FROM users ORDER BY username').all());
  } else if (command === 'set' && username && flag === '--role' && role && process.argv.length === 6) {
    const password = process.env.HAHA_NEW_USER_PASSWORD;
    if (!password) throw new Error('请通过 HAHA_NEW_USER_PASSWORD 环境变量提供密码，不要放在命令行参数中。');
    const user = await setUser(db, username, password, role);
    console.log(`已保存用户 ${user.username}（${user.role}）；该用户旧会话已撤销。`);
  } else if (command === 'disable' && username && !flag) {
    disableUser(db, username); console.log(`已停用用户 ${username} 并撤销会话。`);
  } else {
    throw new Error('用法：node server/manage-user.mjs list | set <username> --role admin|dispatcher|readonly | disable <username>');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
