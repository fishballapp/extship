import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { manifestVersion } from './package.ts';
import {
  ChromeWebStore,
  type Item,
  type ItemState,
  type ItemStatus,
  type PublishType,
} from './store.ts';

const POLL_INTERVAL = Duration.seconds(5);
const PROCESSING_TIMEOUT = Duration.minutes(10);

/**
 * The zip is older than a version the store holds: a rerun of an old build, which must not withdraw
 * the newer submission.
 */
export class StaleVersionError extends Schema.TaggedError<StaleVersionError>()(
  'StaleVersionError',
  { message: Schema.String },
) {}

/** The store finished processing the upload without accepting it, or never finished. */
export class UploadFailedError extends Schema.TaggedError<UploadFailedError>()(
  'UploadFailedError',
  { message: Schema.String },
) {}

/** A submission in these states still holds its version, so the same version is never sent twice. */
const HOLDING_STATES: ReadonlySet<ItemState> = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
]);

/** Withdrawn before a new upload: the store takes no upload while a submission is open. */
const CANCELLABLE_STATES: ReadonlySet<ItemState> = new Set(['PENDING_REVIEW', 'STAGED']);

export type Revision = 'published' | 'submitted';

/** A version the store holds, and where. */
export type HeldVersion = {
  readonly version: string;
  readonly revision: Revision;
  readonly state: ItemState;
};

/** Every version the store holds: published, or submitted and not withdrawn or rejected. */
export const heldVersions = (status: ItemStatus): ReadonlyArray<HeldVersion> =>
  (
    [
      ['published', status.publishedItemRevisionStatus],
      ['submitted', status.submittedItemRevisionStatus],
    ] as const
  ).flatMap(([revision, revisionStatus]) => {
    const state = revisionStatus?.state;
    if (state === undefined || !HOLDING_STATES.has(state)) return [];
    return (revisionStatus?.distributionChannels ?? []).flatMap(({ crxVersion }) =>
      crxVersion === undefined ? [] : [{ version: crxVersion, revision, state }],
    );
  });

/**
 * Orders two Chrome versions (one to four dot-separated integers) part by part, a missing part
 * counting as 0: negative when `a` is older, 0 when they are the same version.
 */
export const compareVersions = (a: string, b: string): number => {
  const [left, right] = [a, b].map(version => version.split('.').map(Number));
  const length = Math.max(left?.length ?? 0, right?.length ?? 0);
  for (let index = 0; index < length; index++) {
    const difference = (left?.[index] ?? 0) - (right?.[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const isCancellable = (status: ItemStatus): boolean => {
  const state = status.submittedItemRevisionStatus?.state;
  return state !== undefined && CANCELLABLE_STATES.has(state);
};

export type PublishOutcome =
  | {
      readonly outcome: 'already-on-store';
      readonly version: string;
      readonly revision: Revision;
      readonly state: ItemState;
    }
  | { readonly outcome: 'dry-run'; readonly version: string; readonly status: ItemStatus }
  | {
      readonly outcome: 'submitted';
      readonly version: string;
      readonly publishType: PublishType;
      readonly state: ItemState | undefined;
      readonly warnings: ReadonlyArray<{ readonly reason?: string; readonly description?: string }>;
    };

/** Polls the status until the store has processed the upload. */
const awaitProcessing = Effect.fnUntraced(function* (item: Item) {
  const store = yield* ChromeWebStore;
  yield* Console.error('The store is processing the package');
  // Each read waits first, so the first one comes after the store has recorded the new upload.
  return yield* store.fetchStatus(item).pipe(
    Effect.delay(POLL_INTERVAL),
    Effect.repeat({
      until: ({ lastAsyncUploadState }) => lastAsyncUploadState !== 'IN_PROGRESS',
    }),
    Effect.timeoutOrElse({
      duration: PROCESSING_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new UploadFailedError({
            message: `The store was still processing the package after ${Duration.format(PROCESSING_TIMEOUT)}`,
          }),
        ),
    }),
  );
});

/**
 * Publishes the zip's version, progress on stderr: skips a version already on the store, refuses
 * one older than the store holds, withdraws
 * an open submission, uploads (waiting out the store's processing), then submits for review.
 * `isDryRun` stops after reading the status, which proves the token and the IDs.
 */
export const publish = Effect.fn('extship.publish')(function* ({
  item,
  zip,
  publishType,
  isDryRun,
}: {
  readonly item: Item;
  readonly zip: Uint8Array;
  readonly publishType: PublishType;
  readonly isDryRun: boolean;
}) {
  const store = yield* ChromeWebStore;
  const version = manifestVersion(zip);
  if (Result.isFailure(version)) return yield* version.failure;
  const { success: zipVersion } = version;

  const status = yield* store.fetchStatus(item);
  const held = heldVersions(status);
  const existing = held.find(({ version }) => compareVersions(version, zipVersion) === 0);
  if (existing !== undefined) {
    yield* Console.error(`${zipVersion} is already ${existing.revision} (${existing.state})`);
    return {
      outcome: 'already-on-store',
      version: zipVersion,
      revision: existing.revision,
      state: existing.state,
    } satisfies PublishOutcome;
  }
  const newer = held.find(({ version }) => compareVersions(version, zipVersion) > 0);
  if (newer !== undefined) {
    return yield* new StaleVersionError({
      message: `${zipVersion} is older than ${newer.version}, already ${newer.revision} (${newer.state})`,
    });
  }
  if (isDryRun) {
    return { outcome: 'dry-run', version: zipVersion, status } satisfies PublishOutcome;
  }

  if (isCancellable(status)) {
    yield* Console.error(
      `Cancelling the open submission (${status.submittedItemRevisionStatus?.state})`,
    );
    yield* store.cancelSubmission(item);
  }

  yield* Console.error(`Uploading ${zipVersion}`);
  const upload = yield* store.upload(item, zip);
  const uploadState =
    upload.uploadState === 'IN_PROGRESS'
      ? (yield* awaitProcessing(item)).lastAsyncUploadState
      : upload.uploadState;
  if (uploadState !== 'SUCCEEDED') {
    return yield* new UploadFailedError({
      message: `The store did not accept the package: ${uploadState ?? 'no upload state'}`,
    });
  }

  yield* Console.error(`Submitting ${zipVersion} for review (${publishType})`);
  const submitted = yield* store.publish(item, publishType);
  const warnings = submitted.warningInfo?.warnings ?? [];
  for (const { reason, description } of warnings) {
    yield* Console.error(`Warning: ${[reason, description].filter(Boolean).join(': ')}`);
  }
  return {
    outcome: 'submitted',
    version: zipVersion,
    publishType,
    state: submitted.state,
    warnings,
  } satisfies PublishOutcome;
});
