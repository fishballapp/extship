import * as Console from 'effect/Console';
import * as CliError from 'effect/cli/CliError';
import type * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { publish } from './publish.ts';
import { ChromeWebStore, type PublishType, StoreResponseError, TOKEN_VARIABLE } from './store.ts';

/** What a failed command prints on stderr, as one JSON line `{"error": …}`. */
export type Failure = {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly body?: unknown;
};

const fail = (failure: Failure) =>
  Effect.fail(
    new CliError.UserError({ cause: failure, userMessage: JSON.stringify({ error: failure }) }),
  );

/** The zip could not be read. */
class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
}) {}

const parseBody = (text: string): unknown =>
  Option.getOrElse(Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text), () => text);

// The store's response body is all a failure carries from a request: never its headers, which hold
// the token.
const failureOf = (error: { readonly _tag: string; readonly message: string }): Failure =>
  error instanceof StoreResponseError
    ? {
        code: error._tag,
        message: error.message,
        status: error.status,
        body: parseBody(error.body),
      }
    : { code: error._tag, message: error.message };

/** Runs a command's work: its result as JSON on stdout, or its failure as the JSON line. */
const report = <A, E extends { readonly _tag: string; readonly message: string }>(
  effect: Effect.Effect<A, E, ChromeWebStore | HttpClient.HttpClient | FileSystem.FileSystem>,
) =>
  effect.pipe(
    Effect.provide(ChromeWebStore.layer),
    Effect.flatMap(result => Console.log(JSON.stringify(result, null, 2))),
    Effect.catch(error => fail(failureOf(error))),
  );

const itemFlags = {
  publisherId: Flag.String('publisher-id').pipe(
    Flag.withDescription('The publisher ID, from the developer dashboard (Publisher › Settings)'),
  ),
  itemId: Flag.String('item-id').pipe(Flag.withDescription('The item’s 32-letter ID')),
};

const PUBLISH_TYPES: Record<'default' | 'staged', PublishType> = {
  default: 'DEFAULT_PUBLISH',
  staged: 'STAGED_PUBLISH',
};

const publishCommand = Command.make(
  'publish',
  {
    ...itemFlags,
    zip: Flag.String('zip').pipe(
      Flag.withDescription('The extension’s zip, manifest.json at its root'),
    ),
    publishType: Flag.Literals('publish-type', ['default', 'staged']).pipe(
      Flag.withDescription(
        'default: live once approved. staged: approved, then published by hand from the dashboard',
      ),
      Flag.withDefault('default'),
    ),
    isDryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('Read the item’s status and stop: proves the token and the IDs'),
      Flag.withDefault(false),
    ),
  },
  ({ publisherId, itemId, zip, publishType, isDryRun }) =>
    report(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs
          .readFile(zip)
          .pipe(Effect.mapError(error => new UsageError({ message: error.message })));
        return yield* publish({
          item: { publisherId, itemId },
          zip: bytes,
          publishType: PUBLISH_TYPES[publishType],
          isDryRun,
        });
      }),
    ),
).pipe(
  Command.withDescription(
    'Upload the zip and submit it for review, unless its version is already on the store; an open submission is cancelled first. Progress on stderr, the outcome as JSON on stdout',
  ),
);

const statusCommand = Command.make('status', itemFlags, item =>
  report(
    Effect.gen(function* () {
      const store = yield* ChromeWebStore;
      return yield* store.fetchStatus(item);
    }),
  ),
).pipe(Command.withDescription('Print the item’s status from the store (`:fetchStatus`) as JSON'));

export const cli = Command.make('extship').pipe(
  Command.withDescription(
    `Publish a browser extension from CI. The access token is read from ${TOKEN_VARIABLE} only`,
  ),
  Command.withSubcommands([
    Command.make('chrome').pipe(
      Command.withDescription('The Chrome Web Store (API v2)'),
      Command.withSubcommands([publishCommand, statusCommand]),
    ),
  ]),
);

/** `formatter` with every error as one JSON line; effect/cli's own parse errors are `UsageError`s. */
export const withJsonErrors = (formatter: CliOutput.Formatter): CliOutput.Formatter => ({
  ...formatter,
  formatError: error =>
    error._tag === 'UserError'
      ? error.message
      : JSON.stringify({ error: { code: 'UsageError', message: error.message } }),
  formatErrors: errors =>
    errors
      .map(error => JSON.stringify({ error: { code: 'UsageError', message: error.message } }))
      .join('\n'),
});
