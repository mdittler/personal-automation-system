// This file is type-checked by tsconfig.typecheck.json, not by tsconfig.json.
import { type RuntimeOverrides } from '../compose-runtime.js';
import type { SystemConfig } from '../types/config.js';
declare const cfg: SystemConfig;

// @ts-expect-error — config requires configPath
const _bad: RuntimeOverrides = { config: cfg };

// OK — correct pairing
const _good: RuntimeOverrides = { config: cfg, configPath: '/tmp/test/pas.yaml' };
