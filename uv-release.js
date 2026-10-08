'use strict';
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const yauzl = require('yauzl');

function release(platform, architecture) {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[architecture];
  const target = { darwin: 'apple-darwin', linux: 'unknown-linux-musl', win32: 'pc-windows-msvc' }[platform];
  if (!arch || !target) throw new Error(`Automatic CLI installation is not available for ${platform}/${architecture}`);
  return { name: `uv-${arch}-${target}`, extension: platform === 'win32' ? '.zip' : '.tar.gz' };
}

async function extractZip(archive, output, name, token) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const controller = new AbortController();
  let cancelled;
  try {
    await new Promise((resolve, reject) => {
      cancelled = token.onCancellationRequested(() => { controller.abort(); zip.close(); reject(new Error('CLI setup cancelled')); });
      zip.on('error', reject);
      zip.on('end', () => reject(new Error('uv.exe is missing from the release archive')));
      zip.on('entry', entry => {
        if (entry.fileName !== 'uv.exe' && entry.fileName !== name + '/uv.exe') { zip.readEntry(); return; }
        if (entry.uncompressedSize > 128 * 1024 * 1024) { reject(new Error('Unexpected uv executable size')); return; }
        zip.openReadStream(entry, (error, input) => {
          if (error) { reject(error); return; }
          let size = 0;
          const bounded = new Transform({ transform(chunk, _, callback) {
            size += chunk.length;
            callback(size > 128 * 1024 * 1024 ? new Error('Unexpected uv executable size') : null, chunk);
          } });
          pipeline(input, bounded, fs.createWriteStream(output, { flags: 'wx', mode: 0o700 }), { signal: controller.signal }).then(resolve, reject);
        });
      });
      if (token.isCancellationRequested) { reject(new Error('CLI setup cancelled')); return; }
      zip.readEntry();
    });
  } finally { cancelled?.dispose(); zip.close(); }
}
module.exports = { release, extractZip };
