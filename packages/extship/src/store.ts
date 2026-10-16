import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

/** The one place the access token is read from; never a flag, since argv is visible to other processes. */
export const TOKEN_VARIABLE = 'CHROME_WEB_STORE_ACCESS_TOKEN';

const ORIGIN = 'https://chromewebstore.googleapis.com';
const REQUEST_TIMEOUT = Duration.seconds(30);
const UPLOAD_TIMEOUT = Duration.minutes(3);

/** An item on the store, as its publisher and its 32-letter ID. */
export type Item = { readonly publisherId: string; readonly itemId: string };

const ItemStateSchema = Schema.Literals([
  'ITEM_STATE_UNSPECIFIED',
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED',
]);
export type ItemState = typeof ItemStateSchema.Type;

const UploadStateSchema = Schema.Literals([
  'UPLOAD_STATE_UNSPECIFIED',
  'SUCCEEDED',
  'IN_PROGRESS',
  'FAILED',
  'NOT_FOUND',
]);
export type UploadState = typeof UploadStateSchema.Type;

const ItemRevisionStatusSchema = Schema.Struct({
  state: Schema.optionalKey(ItemStateSchema),
  distributionChannels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        deployPercentage: Schema.optionalKey(Schema.Finite),
        crxVersion: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type ItemRevisionStatus = typeof ItemRevisionStatusSchema.Type;

/** `:fetchStatus`, every field the v2 API documents. */
export const ItemStatusSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  itemId: Schema.optionalKey(Schema.String),
  publicKey: Schema.optionalKey(Schema.String),
  publishedItemRevisionStatus: Schema.optionalKey(ItemRevisionStatusSchema),
  submittedItemRevisionStatus: Schema.optionalKey(ItemRevisionStatusSchema),
  lastAsyncUploadState: Schema.optionalKey(UploadStateSchema),
  takenDown: Schema.optionalKey(Schema.Boolean),
  warned: Schema.optionalKey(Schema.Boolean),
});
export type ItemStatus = typeof ItemStatusSchema.Type;

const UploadResultSchema = Schema.Struct({
  crxVersion: Schema.optionalKey(Schema.String),
  uploadState: Schema.optionalKey(UploadStateSchema),
});
export type UploadResult = typeof UploadResultSchema.Type;

const PublishResultSchema = Schema.Struct({
  state: Schema.optionalKey(ItemStateSchema),
  warningInfo: Schema.optionalKey(
    Schema.Struct({
      warnings: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            reason: Schema.optionalKey(Schema.String),
            description: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
export type PublishResult = typeof PublishResultSchema.Type;

export const PublishTypeSchema = Schema.Literals(['DEFAULT_PUBLISH', 'STAGED_PUBLISH']);
export type PublishType = typeof PublishTypeSchema.Type;

/** `CHROME_WEB_STORE_ACCESS_TOKEN` is unset or empty. */
export class MissingTokenError extends Schema.TaggedError<MissingTokenError>()(
  'MissingTokenError',
  { message: Schema.String },
) {}

/** The store answered outside 2xx; `body` is its response, as text. */
export class StoreResponseError extends Schema.TaggedError<StoreResponseError>()(
  'StoreResponseError',
  { message: Schema.String, status: Schema.Finite, body: Schema.String },
) {}

/** No answer: the network failed or the request timed out, so a write may have landed. */
export class StoreUnreachableError extends Schema.TaggedError<StoreUnreachableError>()(
  'StoreUnreachableError',
  { message: Schema.String },
) {}

/** A 2xx whose body is not what the API documents. */
export class UnexpectedResponseError extends Schema.TaggedError<UnexpectedResponseError>()(
  'UnexpectedResponseError',
  { message: Schema.String, body: Schema.String },
) {}

export type StoreError = StoreResponseError | StoreUnreachableError | UnexpectedResponseError;

/** A Google API error body, as far as its `ErrorInfo` reasons. */
const RefusalSchema = Schema.Struct({
  error: Schema.Struct({
    details: Schema.optionalKey(
      Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })),
    ),
  }),
});

/** The `ErrorInfo` reasons in the store's refusal (`NOT_UPDATEABLE`, …); none when the body has none. */
export const refusalReasons = ({ body }: StoreResponseError): ReadonlyArray<string> =>
  Schema.decodeOption(Schema.fromJsonString(RefusalSchema))(body).pipe(
    Option.match({
      onNone: () => [],
      onSome: ({ error }) =>
        (error.details ?? []).flatMap(({ reason }) => (reason === undefined ? [] : [reason])),
    }),
  );

/** The Chrome Web Store API v2, for one access token. */
export class ChromeWebStore extends Context.Service<
  ChromeWebStore,
  {
    readonly fetchStatus: (item: Item) => Effect.Effect<ItemStatus, StoreError>;
    readonly cancelSubmission: (item: Item) => Effect.Effect<void, StoreError>;
    /** Uploads the zip as the item's next package; `IN_PROGRESS` means poll `fetchStatus`. */
    readonly upload: (item: Item, zip: Uint8Array) => Effect.Effect<UploadResult, StoreError>;
    /** Submits the uploaded package for review. */
    readonly publish: (
      item: Item,
      publishType: PublishType,
    ) => Effect.Effect<PublishResult, StoreError>;
  }
>()('extship/ChromeWebStore') {
  /** Reads the token from `CHROME_WEB_STORE_ACCESS_TOKEN`; sends through the `HttpClient` provided. */
  static readonly layer = Layer.effect(
    ChromeWebStore,
    Effect.gen(function* () {
      const token = yield* Config.schema(
        Schema.Redacted(Schema.NonEmptyString),
        TOKEN_VARIABLE,
      ).pipe(
        Effect.mapError(
          () =>
            new MissingTokenError({
              message: `Set ${TOKEN_VARIABLE} to an OAuth access token with the chromewebstore scope`,
            }),
        ),
      );
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(request =>
          request.pipe(
            HttpClientRequest.prependUrl(ORIGIN),
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.acceptJson,
          ),
        ),
      );

      const send = <S extends Schema.Top & { readonly DecodingServices: never }>(
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
        timeout: Duration.Duration = REQUEST_TIMEOUT,
      ) =>
        Effect.gen(function* () {
          const what = `${request.method} ${request.url}`;
          const { status, text } = yield* client.execute(request).pipe(
            Effect.flatMap(response =>
              Effect.map(response.text, text => ({ status: response.status, text })),
            ),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new StoreUnreachableError({
                    message: `${what} timed out after ${Duration.format(timeout)}`,
                  }),
                ),
            }),
            Effect.catchTag('HttpClientError', error =>
              Effect.fail(new StoreUnreachableError({ message: error.message })),
            ),
          );
          if (status < 200 || status >= 300) {
            return yield* new StoreResponseError({
              message: `${what} answered ${status}`,
              status,
              body: text,
            });
          }
          return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
            text === '' ? '{}' : text,
          ).pipe(
            Effect.mapError(
              error =>
                new UnexpectedResponseError({
                  message: `${what} answered with an unexpected body: ${error.message}`,
                  body: text,
                }),
            ),
          );
        });

      const itemPath = ({ publisherId, itemId }: Item) =>
        `/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;

      return ChromeWebStore.of({
        fetchStatus: Effect.fn('ChromeWebStore.fetchStatus')(function* (item) {
          return yield* send(
            HttpClientRequest.get(`${itemPath(item)}:fetchStatus`),
            ItemStatusSchema,
          );
        }),
        cancelSubmission: Effect.fn('ChromeWebStore.cancelSubmission')(function* (item) {
          yield* send(
            HttpClientRequest.post(`${itemPath(item)}:cancelSubmission`),
            Schema.Struct({}),
          );
        }),
        upload: Effect.fn('ChromeWebStore.upload')(function* (item, zip) {
          return yield* send(
            HttpClientRequest.post(`/upload${itemPath(item)}:upload`).pipe(
              HttpClientRequest.bodyUint8Array(zip, 'application/zip'),
            ),
            UploadResultSchema,
            UPLOAD_TIMEOUT,
          );
        }),
        publish: Effect.fn('ChromeWebStore.publish')(function* (item, publishType) {
          return yield* send(
            HttpClientRequest.post(`${itemPath(item)}:publish`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ publishType }),
            ),
            PublishResultSchema,
          );
        }),
      });
    }),
  );
}
