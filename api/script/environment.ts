// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import * as dotenv from 'dotenv';
dotenv.config();

export function getTempDirectory(): string {
  return process.env.TEMP || process.env.TMPDIR;
}
