// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RequestHandler, Router } from "express";

import { AcquisitionConfig, getAcquisitionRouter, getHealthRouter } from "./controller/acquisitionController";
import { getManagementRouter, ManagementConfig } from "./controller/managementController";
import { getHeadersMiddleware, HeadersConfig } from "./middleware/headers";
import { InputSanitizer } from "./middleware/input-sanitizer";
import { RequestTimeoutHandler } from "./middleware/request-timeout";
import { AppInsights } from "./services/app-insights";
import { AuthenticationConfig, PassportAuthentication } from "./services/passport-authentication";

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

export function auth(config: AuthenticationConfig): any {
  const passportAuthentication = new PassportAuthentication(config);
  return {
    router: passportAuthentication.getRouter.bind(passportAuthentication),
    legacyRouter: passportAuthentication.getLegacyRouter.bind(passportAuthentication),
    authenticate: passportAuthentication.authenticate,
  };
}

export function appInsights(): any {
  const appInsights = new AppInsights();

  return {
    router: appInsights.getRouter.bind(appInsights),
    errorHandler: appInsights.errorHandler.bind(appInsights),
  };
}

export function inputSanitizer(): any {
  return InputSanitizer;
}

export function requestTimeoutHandler(): RequestHandler {
  return RequestTimeoutHandler;
}
