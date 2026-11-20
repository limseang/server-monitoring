import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAppContainer, findContainerScript } from '../src/ops/appcontainer.js';

const row = (n, w, s, h) => [n, w, s, h].join('\t');

test('pickAppContainer: the web app of this folder, not its helpers or other apps', () => {
  const out = [
    row('laravel-api-queue-1', '/var/www/api_v2/docker', 'queue', '1'),
    row('laravel-api-app', '/var/www/api_v2/docker', 'app', '1'),
    row('laravel-api-scheduler-1', '/var/www/api_v2/docker', 'scheduler', '1'),
    row('laravel-api-db', '/var/www/api_v2/docker', 'db', '0'),
    row('other-app-1', '/srv/other', 'app', '1'),
  ].join('\n');
  // the deployment folder is the repo; the compose file lives in its docker/ folder
  assert.deepEqual(pickAppContainer(out, '/var/www/api_v2'), { name: 'laravel-api-app', all: ['laravel-api-app', 'laravel-api-queue-1', 'laravel-api-scheduler-1'] });
  assert.equal(pickAppContainer(out, '/var/www/api_v2/docker/').name, 'laravel-api-app');
  assert.equal(pickAppContainer(out, '/srv/other').name, 'other-app-1');
  // nothing with php in that folder, or another folder whose name only starts the same
  assert.equal(pickAppContainer(row('x-db', '/srv/shop', 'db', '0'), '/srv/shop').name, null);
  assert.equal(pickAppContainer(row('shop2-app', '/srv/shop2', 'app', '1'), '/srv/shop').name, null);
  assert.equal(pickAppContainer('', '/srv/shop').name, null);
  // a lone container with an unusual name still wins
  assert.equal(pickAppContainer(row('backend', '/srv/shop', 'backend', '1'), '/srv/shop').name, 'backend');
});

test('findContainerScript quotes the program and uses the server docker command', () => {
  const s = findContainerScript({ docker_cmd: 'sudo docker' }, 'php');
  assert.match(s, /^sudo docker ps --format/);
  assert.match(s, /sudo docker exec "\$n" sh -c 'command -v php >\/dev\/null 2>&1'/);
});
