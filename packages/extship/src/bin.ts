#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as CliConfig from 'effect/cli/CliConfig';
import * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import packageJson from '../package.json' with { type: 'json' };
import { cli, withJsonErrors } from './cli.ts';

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.provide(
    Layer.mergeAll(
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      CliOutput.layer(withJsonErrors(CliOutput.defaultFormatter())),
      FetchHttpClient.layer,
      // No trace headers on requests to the store: it has no use for them.
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
      NodeServices.layer,
    ),
  ),
  NodeRuntime.runMain,
);
