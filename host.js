'use strict';
const path = require('node:path');
const fs = require('node:fs');

function parseCliOutput(stdout, stderr) {
  try { return JSON.parse(stdout); }
  catch { throw new Error((stderr || stdout || 'sa-dsl returned no JSON').trim().slice(0, 2000)); }
}

function resolveProjectFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error('Invalid source path from sa-dsl');
  }
  const base = fs.realpathSync(root);
  const absolute = fs.realpathSync(path.resolve(base, relative));
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw new Error('Source path escapes the Python project');
  }
  if (path.extname(absolute) !== '.py') throw new Error('Navigation target is not a Python file');
  return absolute;
}

function navigationArgs(root, message) {
  if (!message || !['node', 'link'].includes(message.kind) ||
      typeof message.service !== 'string' || typeof message.key !== 'string') {
    throw new Error('Invalid graph selection');
  }
  const args = ['ide-locate', '--project', root, '--kind', message.kind,
    '--service', message.service, '--key', message.key];
  if (message.kind === 'link') {
    if (typeof message.source !== 'string' || typeof message.target !== 'string') {
      throw new Error('Invalid link selection');
    }
    args.push('--source', message.source, '--target', message.target);
  }
  return args;
}

module.exports = { parseCliOutput, resolveProjectFile, navigationArgs };
