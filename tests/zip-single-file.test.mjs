import test from 'node:test';
import assert from 'node:assert/strict';
import { zipExecutable } from '../src/zip-single-file.js';

test('单文件 ZIP 保留 UTF-8 文件名、脚本内容和 Unix 可执行位', () => {
  const filename = 'BrainX-SuperMai-连接器.command';
  const content = '#!/bin/zsh\necho ready\n';
  const archive = zipExecutable(filename, content);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > 0);
  assert.equal(archive.readUInt16LE(centralOffset + 8), 0x0800);
  assert.equal(archive.readUInt32LE(centralOffset + 38) >>> 16, 0o100755);
  assert.ok(archive.includes(Buffer.from(filename)));
  assert.ok(archive.includes(Buffer.from(content)));
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});
