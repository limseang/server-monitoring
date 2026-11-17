// Small admin CLI for when you are locked out.
//   node src/cli.js reset-password <username> <new-password>
//   node src/cli.js disable-2fa <username>
//   node src/cli.js create-user <username> <password>
//   node src/cli.js list-users
// In Docker: docker exec -it switchboard node src/cli.js list-users
import { get, all, run, now } from './db.js';
import { hashPassword } from './crypto.js';
import { createUser } from './auth.js';

const [cmd, user, pass] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'list-users':
      for (const u of all('SELECT id, username, totp_secret IS NOT NULL AS totp, last_login_at FROM users')) {
        console.log(`${u.id}\t${u.username}\t2FA=${u.totp ? 'on' : 'off'}\tlast login: ${u.last_login_at || '-'}`);
      }
      break;
    case 'reset-password': {
      if (!user || !pass) throw new Error('Usage: reset-password <username> <new-password>');
      if (pass.length < 10) throw new Error('Password must be at least 10 characters');
      const u = get('SELECT id FROM users WHERE username = ?', user);
      if (!u) throw new Error(`No user "${user}"`);
      run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pass), u.id);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
      console.log(`Password for ${user} was reset. All sessions logged out.`);
      break;
    }
    case 'disable-2fa': {
      const r = run('UPDATE users SET totp_secret = NULL WHERE username = ?', user || '');
      console.log(r.changes ? `2FA disabled for ${user}` : `No user "${user}"`);
      break;
    }
    case 'create-user':
      await createUser(user, pass);
      console.log(`User ${user} created at ${now()}`);
      break;
    default:
      console.log('Commands: list-users | reset-password <user> <pass> | disable-2fa <user> | create-user <user> <pass>');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
