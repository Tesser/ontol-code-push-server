// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RequestHandler, Router } from "express";

import { AcquisitionConfig, getAcquisitionRouter, getHealthRouter } from "./routes/acquisition";
import { AppInsights } from "./routes/app-insights";
import { getHeadersMiddleware, HeadersConfig } from "./routes/headers";
import { InputSanitizer } from "./routes/input-sanitizer";
import { getManagementRouter, ManagementConfig } from "./routes/management";
import { AuthenticationConfig, PassportAuthentication } from "./routes/passport-authentication";
import { RequestTimeoutHandler } from "./routes/request-timeout";

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
