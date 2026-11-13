'use strict';
// Where things live on a Mac when the Linux default path is wrong.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Docker Desktop's socket is ~/.docker/run/docker.sock; /var/run/docker.sock exists only with "Allow the default Docker
// socket" on. Checked on every call: Docker may start after the dashboard.
function dockerSock() {
  const host = process.env.DOCKER_HOST || '';
  const list = [host.startsWith('unix://') ? host.slice(7) : null, '/var/run/docker.sock', path.join(HOME, '.docker', 'run', 'docker.sock'),
    path.join(HOME, '.orbstack', 'run', 'docker.sock'), path.join(HOME, '.colima', 'default', 'docker.sock')];
  return list.find(p => p && fs.existsSync(p)) || null;
}

const androidSdk = () => path.join(HOME, 'Library', 'Android', 'sdk');

module.exports = { dockerSock, androidSdk };
