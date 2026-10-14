import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { unzipSync } from 'fflate';

/**
 * The zip is not an extension package: unreadable, or without a `manifest.json` whose `version` is
 * one Chrome accepts.
 */
export class InvalidPackageError extends Schema.TaggedError<InvalidPackageError>()(
  'InvalidPackageError',
  { message: Schema.String },
) {}

/** Chrome's version format: one to four dot-separated integers. */
const ManifestSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^\d+(\.\d+){0,3}$/u)) }),
);

/** The `version` in the `manifest.json` at the root of an extension's zip. */
export const manifestVersion = (zip: Uint8Array): Result.Result<string, InvalidPackageError> => {
  const entries = (() => {
    try {
      return unzipSync(zip, { filter: ({ name }) => name === 'manifest.json' });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  if (entries instanceof Error) {
    return Result.fail(new InvalidPackageError({ message: `Not a zip: ${entries.message}` }));
  }
  const manifest = entries['manifest.json'];
  if (manifest === undefined) {
    return Result.fail(
      new InvalidPackageError({ message: 'The zip has no manifest.json at its root' }),
    );
  }
  return Schema.decodeResult(ManifestSchema)(new TextDecoder().decode(manifest)).pipe(
    Result.map(({ version }) => version),
    Result.mapError(
      error =>
        new InvalidPackageError({
          message: `manifest.json has no valid version: ${error.message}`,
        }),
    ),
  );
};
