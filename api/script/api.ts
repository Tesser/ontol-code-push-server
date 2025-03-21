// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RequestHandler, Router } from "express";

import { AcquisitionConfig, getAcquisitionRouter, getHealthRouter } from "./controller/acquisitionController";
import { getManagementRouter, ManagementConfig } from "./controller/managementController";
import { getHeadersMiddleware, HeadersConfig } from "./middleware/headers";
import { InputSanitizer } from "./middleware/input-sanitizer";
import { RequestTimeoutHandler } from "./middleware/request-timeout";
import { Authentication } from "./services/authentication";

export function headers(config: HeadersConfig): RequestHandler {
  return getHeadersMiddleware(config);
}

export function acquisition(config: AcquisitionConfig): Router {
  return getAcquisitionRouter(config);
}

export function health(config: AcquisitionConfig): Router {
  return getHealthRouter(config);
}

export function management(config: ManagementConfig): Router {
  return getManagementRouter(config);
}

export function auth(): any {
  const authentication = new Authentication();
  return {
    router: authentication.getRouter.bind(authentication),
    authenticate: authentication.authenticate.bind(authentication),
  };
}

export function inputSanitizer(): any {
  return InputSanitizer;
}

export function requestTimeoutHandler(): RequestHandler {
  return RequestTimeoutHandler;
}
