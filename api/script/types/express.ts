// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

declare global {
  namespace Express {
    export interface Session {
      [key: string]: any;
    }

    export interface Request {
      user: any;
      session?: Session;
    }
  }
}

export {};
