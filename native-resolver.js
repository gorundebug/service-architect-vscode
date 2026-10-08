'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createResolver() {
  const directory = path.join(__dirname, 'native');
  if (!fs.existsSync(directory)) return new (require('@vscode/os-proxy-resolver').ProxyResolver)();
  const { getPlatformPackage } = require(path.join(directory, 'platform.js'));
  const { ProxyResolver } = require(path.join(directory, getPlatformPackage()));
  return new ProxyResolver();
}
module.exports = { createResolver };
