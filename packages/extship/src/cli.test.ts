import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, layer } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Console from 'effect/Console';
import * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as TestClock from 'effect/testing/TestClock';
import { strToU8, zipSync } from 'fflate';
import { cli, withJsonErrors } from './cli.ts';

const TOKEN = 'ya29.test-token-never-printed';
const PUBLISHER = 'pub-1';
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const ITEM_URL = `https://chromewebstore.googleapis.com/v2/publishers/${PUBLISHER}/items/${ITEM}`;
const UPLOAD_URL = `https://chromewebstore.googleapis.com/upload/v2/publishers/${PUBLISHER}/items/${ITEM}:upload`;

type Call = { url: string; method: string; headers: Headers; body: string };
type Reply = { status?: number; json?: unknown };

/** The store's status for a published and an optionally submitted revision. */
const itemStatus = ({
  published,
  submitted,
  upload,
}: {
  published?: string;
  submitted?: { state: string; version: string };
  upload?: string;
}) => ({
  itemId: ITEM,
  ...(published === undefined
    ? {}
    : {
        publishedItemRevisionStatus: {
          state: 'PUBLISHED',
          distributionChannels: [{ deployPercentage: 100, crxVersion: published }],
        },
      }),
  ...(submitted === undefined
    ? {}
    : {
        submittedItemRevisionStatus: {
          state: submitted.state,
          distributionChannels: [{ deployPercentage: 100, crxVersion: submitted.version }],
        },
      }),
  ...(upload === undefined ? {} : { lastAsyncUploadState: upload }),
});

/**
 * The CLI against a store that answers each call with `respond`, the clock stepped 5 seconds at a
 * time until it ends; output is captured.
 */
const runCli = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  respond: (call: Call) => Reply,
) {
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = {
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body instanceof Uint8Array ? `${init.body.byteLength} bytes` : '',
    };
    calls.push(call);
    const { status = 200, json } = respond(call);
    return new Response(json === undefined ? null : JSON.stringify(json), { status });
  };
  const fiber = yield* Effect.exit(Command.runWith(cli, { version: 'test' })(args)).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        CliOutput.layer(withJsonErrors(CliOutput.defaultFormatter({ colors: false }))),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ CHROME_WEB_STORE_ACCESS_TOKEN: TOKEN })),
      ),
    ),
    Effect.provideService(Console.Console, {
      ...console,
      log: (...parts: unknown[]) => stdout.push(parts.join(' ')),
      error: (...parts: unknown[]) => stderr.push(parts.join(' ')),
    }),
    Effect.forkChild,
  );
  // The fake store answers on the event loop, so each step lets it answer before moving the clock.
  yield* Effect.promise(() => new Promise(resolve => setImmediate(resolve))).pipe(
    Effect.andThen(TestClock.adjust('5 seconds')),
    Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined }),
  );
  const exit = yield* Fiber.join(fiber);
  const output = { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  expect(`${output.stdout}\n${output.stderr}`).not.toContain(TOKEN);
  for (const call of calls) expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  return { exit, calls, ...output };
});

/** A zip with a manifest of `version`, written to a temp file. */
const zipOf = Effect.fnUntraced(function* (version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* fs.makeTempDirectoryScoped(), 'extension.zip');
  yield* fs.writeFile(
    file,
    zipSync({
      'manifest.json': strToU8(JSON.stringify({ manifest_version: 3, version })),
      'background.js': strToU8('// background'),
    }),
  );
  return file;
});

const publishArgs = (zip: string, ...more: string[]) => [
  'chrome',
  'publish',
  '--publisher-id',
  PUBLISHER,
  '--item-id',
  ITEM,
  '--zip',
  zip,
  ...more,
];

const route = ({ method, url }: Call) =>
  `${method} ${url.replace(ITEM_URL, '').replace(UPLOAD_URL, 'upload')}`;

/** The JSON failure line in the captured stderr. */
const failure = (stderr: string) => {
  const line = stderr.split('\n').find(text => text.startsWith('{"error"'));
  if (line === undefined) throw new Error(`no failure line in: ${stderr}`);
  return JSON.parse(line).error;
};

layer(NodeServices.layer)(it => {
  describe('chrome publish', () => {
    it.effect('skips a version already published, sending nothing else', () =>
      Effect.gen(function* () {
        const { exit, calls, stdout } = yield* runCli(publishArgs(yield* zipOf('1.2.0')), () => ({
          json: itemStatus({ published: '1.2.0' }),
        }));
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(JSON.parse(stdout)).toEqual({
          outcome: 'already-on-store',
          version: '1.2.0',
          revision: 'published',
          state: 'PUBLISHED',
        });
      }),
    );

    it.effect('skips a version already submitted and staged, leaving the submission alone', () =>
      Effect.gen(function* () {
        const { calls, stdout } = yield* runCli(publishArgs(yield* zipOf('1.3.0')), () => ({
          json: itemStatus({
            published: '1.2.0',
            submitted: { state: 'STAGED', version: '1.3.0' },
          }),
        }));
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'already-on-store', state: 'STAGED' });
      }),
    );

    it.effect('counts 1.3 and 1.3.0 as the same version', () =>
      Effect.gen(function* () {
        const { calls, stdout } = yield* runCli(publishArgs(yield* zipOf('1.3')), () => ({
          json: itemStatus({
            published: '1.2.0',
            submitted: { state: 'PENDING_REVIEW', version: '1.3.0' },
          }),
        }));
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'already-on-store', version: '1.3' });
      }),
    );

    it.effect('refuses a version older than the staged one, leaving the submission alone', () =>
      Effect.gen(function* () {
        const { exit, calls, stderr } = yield* runCli(publishArgs(yield* zipOf('1.10.0')), () => ({
          json: itemStatus({
            published: '1.9.0',
            submitted: { state: 'STAGED', version: '1.11.0' },
          }),
        }));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(failure(stderr)).toEqual({
          code: 'StaleVersionError',
          message: '1.10.0 is older than 1.11.0, already submitted (STAGED)',
        });
      }),
    );

    it.effect('stops after the status under --dry-run', () =>
      Effect.gen(function* () {
        const { calls, stdout } = yield* runCli(
          publishArgs(yield* zipOf('1.3.0'), '--dry-run'),
          () => ({ json: itemStatus({ published: '1.2.0' }) }),
        );
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'dry-run', version: '1.3.0' });
      }),
    );

    it.effect.each(['STAGED', 'PENDING_REVIEW'])(
      'cancels an open %s submission of an older version, then uploads and submits',
      state =>
        Effect.gen(function* () {
          const { exit, calls, stdout } = yield* runCli(
            publishArgs(yield* zipOf('1.4.0'), '--publish-type', 'staged'),
            call => {
              if (route(call) === 'GET :fetchStatus') {
                return {
                  json: itemStatus({ published: '1.2.0', submitted: { state, version: '1.3.0' } }),
                };
              }
              if (route(call) === 'POST upload') {
                return { json: { crxVersion: '1.4.0', uploadState: 'SUCCEEDED' } };
              }
              if (route(call) === 'POST :publish') return { json: { state: 'PENDING_REVIEW' } };
              return { json: {} };
            },
          );
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(calls.map(route)).toEqual([
            'GET :fetchStatus',
            'POST :cancelSubmission',
            'POST upload',
            'POST :publish',
          ]);
          expect(calls[2]?.headers.get('content-type')).toBe('application/zip');
          expect(JSON.parse(stdout)).toEqual({
            outcome: 'submitted',
            version: '1.4.0',
            publishType: 'STAGED_PUBLISH',
            state: 'PENDING_REVIEW',
            warnings: [],
          });
        }),
    );

    it.effect('polls an upload still processing until it succeeds, and prints warnings', () =>
      Effect.gen(function* () {
        // The first read is the check before uploading; the rest are polls.
        const uploadStates = [undefined, 'IN_PROGRESS', 'IN_PROGRESS', 'SUCCEEDED'];
        const { exit, calls, stdout, stderr } = yield* runCli(
          publishArgs(yield* zipOf('1.4.0')),
          call => {
            if (route(call) === 'GET :fetchStatus') {
              return { json: itemStatus({ published: '1.2.0', upload: uploadStates.shift() }) };
            }
            if (route(call) === 'POST upload') return { json: { uploadState: 'IN_PROGRESS' } };
            return {
              json: {
                state: 'PENDING_REVIEW',
                warningInfo: { warnings: [{ reason: 'BROAD_HOST', description: 'Broad hosts' }] },
              },
            };
          },
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(calls.map(route)).toEqual([
          'GET :fetchStatus',
          'POST upload',
          'GET :fetchStatus',
          'GET :fetchStatus',
          'GET :fetchStatus',
          'POST :publish',
        ]);
        expect(stderr).toContain('Warning: BROAD_HOST: Broad hosts');
        expect(JSON.parse(stdout)).toMatchObject({
          outcome: 'submitted',
          publishType: 'DEFAULT_PUBLISH',
        });
      }),
    );

    it.effect('fails, submitting nothing, when the store rejects the upload', () =>
      Effect.gen(function* () {
        const { exit, calls, stdout, stderr } = yield* runCli(
          publishArgs(yield* zipOf('1.4.0')),
          call => {
            if (route(call) === 'GET :fetchStatus') {
              return { json: itemStatus({ published: '1.2.0', upload: 'FAILED' }) };
            }
            return { json: { uploadState: 'IN_PROGRESS' } };
          },
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(calls.map(route)).not.toContain('POST :publish');
        expect(stdout).toBe('');
        expect(failure(stderr)).toEqual({
          code: 'UploadFailedError',
          message: 'The store did not accept the package: FAILED',
        });
      }),
    );

    it.effect('fails when the store is still processing after 10 minutes', () =>
      Effect.gen(function* () {
        const { exit, calls, stderr } = yield* runCli(publishArgs(yield* zipOf('1.4.0')), call =>
          route(call) === 'POST upload'
            ? { json: { uploadState: 'IN_PROGRESS' } }
            : { json: itemStatus({ published: '1.2.0', upload: 'IN_PROGRESS' }) },
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(calls.map(route)).not.toContain('POST :publish');
        expect(failure(stderr)).toEqual({
          code: 'UploadFailedError',
          message: 'The store was still processing the package after 10m',
        });
      }),
    );

    it.effect('fails with the store’s response body when publishing is refused', () =>
      Effect.gen(function* () {
        const refusal = {
          error: { code: 400, message: 'Item is not publishable', status: 'FAILED_PRECONDITION' },
        };
        const { exit, stderr } = yield* runCli(publishArgs(yield* zipOf('1.4.0')), call => {
          if (route(call) === 'GET :fetchStatus') {
            return { json: itemStatus({ published: '1.2.0' }) };
          }
          if (route(call) === 'POST upload') return { json: { uploadState: 'SUCCEEDED' } };
          return { status: 400, json: refusal };
        });
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failure(stderr)).toEqual({
          code: 'StoreResponseError',
          message: `POST /v2/publishers/${PUBLISHER}/items/${ITEM}:publish answered 400`,
          status: 400,
          body: refusal,
        });
      }),
    );

    it.effect('fails on a zip without a manifest, before calling the store', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(yield* fs.makeTempDirectoryScoped(), 'empty.zip');
        yield* fs.writeFile(file, zipSync({ 'readme.txt': strToU8('hi') }));
        const { calls, stderr } = yield* runCli(publishArgs(file), () => ({ json: {} }));
        expect(calls).toEqual([]);
        expect(failure(stderr).code).toBe('InvalidPackageError');
      }),
    );

    it.effect('fails on a version Chrome would reject, before calling the store', () =>
      Effect.gen(function* () {
        const { calls, stderr } = yield* runCli(publishArgs(yield* zipOf('1.4.0-beta')), () => ({
          json: {},
        }));
        expect(calls).toEqual([]);
        expect(failure(stderr).code).toBe('InvalidPackageError');
      }),
    );
  });

  describe('chrome status', () => {
    it.effect('prints the status as JSON', () =>
      Effect.gen(function* () {
        const status = itemStatus({
          published: '1.2.0',
          submitted: { state: 'PENDING_REVIEW', version: '1.3.0' },
        });
        const { calls, stdout } = yield* runCli(
          ['chrome', 'status', '--publisher-id', PUBLISHER, '--item-id', ITEM],
          () => ({ json: status }),
        );
        expect(calls.map(route)).toEqual(['GET :fetchStatus']);
        expect(JSON.parse(stdout)).toEqual(status);
      }),
    );

    it.effect('prints a 401 as the failure line, without the token', () =>
      Effect.gen(function* () {
        const { exit, stderr } = yield* runCli(
          ['chrome', 'status', '--publisher-id', PUBLISHER, '--item-id', ITEM],
          () => ({ status: 401, json: { error: { code: 401, status: 'UNAUTHENTICATED' } } }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failure(stderr)).toMatchObject({ code: 'StoreResponseError', status: 401 });
      }),
    );
  });
});
