import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, resolve } from 'node:path';
import { command } from '../apps/api/src/media.js';
import { ROOT } from '../apps/api/src/env.js';
import { AppError } from '../apps/api/src/errors.js';

test('media tool paths work without PATH, from another working directory, and fail without leaking paths', async () => {
  const original = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH, path: process.env.PATH, cwd: process.cwd() };
  try {
    process.env.PATH = '';
    process.env.FFMPEG_PATH = process.execPath;
    process.env.FFPROBE_PATH = relative(ROOT, process.execPath);
    process.chdir(resolve(ROOT, 'apps/api'));
    for (const tool of ['ffmpeg', 'ffprobe']) {
      assert.equal(await command(tool, ['-e', 'process.stdout.write(process.argv[1])', 'argument with spaces']), 'argument with spaces');
    }
    process.env.FFMPEG_PATH = '.tools/missing-private-tool.exe';
    await assert.rejects(command('ffmpeg', ['-version']), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'MEDIA_TOOL_MISSING');
      assert.ok(!error.message.includes('missing-private-tool'));
      assert.ok(!error.message.includes(ROOT));
      return true;
    });
  } finally {
    process.chdir(original.cwd);
    for (const [key, value] of Object.entries({ FFMPEG_PATH: original.ffmpeg, FFPROBE_PATH: original.ffprobe, PATH: original.path })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
