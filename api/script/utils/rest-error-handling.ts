// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";

import * as dotenv from 'dotenv';
import * as errorModule from "../error";
import * as storageTypes from "../infrastructure/storage";
import { AppInsights } from "../services/app-insights";
dotenv.config();

const sanitizeHtml = require("sanitize-html");

export enum ErrorCode {
  Conflict = 0,
  MalformedRequest = 1,
  NotFound = 2,
  Unauthorized = 4,
  Other = 99,
}

export interface RestError extends errorModule.CodePushError {
  code: ErrorCode;
}

export function restError(errorCode: ErrorCode, message?: string): RestError {
  const restError = <RestError>errorModule.codePushError(errorModule.ErrorSource.Rest, message);
  restError.code = errorCode;
  return restError;
}

export function restErrorHandler(res: express.Response, error: errorModule.CodePushError, next: Function): void {
  if (!error || (error.source !== errorModule.ErrorSource.Storage && error.source !== errorModule.ErrorSource.Rest)) {
    console.log("Unknown error source");
    sendUnknownError(res, error, next);
  } else if (error.source === errorModule.ErrorSource.Storage) {
    storageErrorHandler(res, <storageTypes.StorageError>error, next);
  } else {
    const restError: RestError = <RestError>error;
    switch (restError.code) {
      case ErrorCode.Conflict:
        sendConflictError(res, error.message);
        break;
      case ErrorCode.MalformedRequest:
        sendMalformedRequestError(res, error.message);
        break;
      case ErrorCode.NotFound:
        sendNotFoundError(res, error.message);
        break;
      case ErrorCode.Unauthorized:
        sendForbiddenError(res, error.message);
        break;
      default:
        console.log("Unknown REST error");
        sendUnknownError(res, error, next);
        break;
    }
  }
}

/**
 * 잘못된 요청 오류를 보내는 함수입니다.
 * @param res 응답 객체
 * @param message 오류 메시지
 */
export function sendMalformedRequestError(res: express.Response, message: string): void {
  if (message) {
    res.status(400).send(sanitizeHtml(message));
  } else {
    res.sendStatus(400);
  }
}

export function sendForbiddenError(res: express.Response, message?: string): void {
  if (message) {
    res.status(403).send(sanitizeHtml(message));
  } else {
    res.sendStatus(403);
  }
}

export function sendForbiddenPage(res: express.Response, message: string): void {
  res.status(403).render("message", { message: message });
}

export function sendNotFoundError(res: express.Response, message?: string): void {
  if (message) {
    res.status(404).send(sanitizeHtml(message));
  } else {
    res.sendStatus(404);
  }
}

export function sendNotRegisteredError(res: express.Response): void {

  const isAccountRegistrationEnabled = process.env["ENABLE_ACCOUNT_REGISTRATION"] !== "false";
  
  if (isAccountRegistrationEnabled) {
    res.status(403).render("message", {
      message:
        "계정을 찾을 수 없습니다.<br/>CLI를 통해 등록하셨나요?<br/>이미 등록했지만 이메일 주소가 변경된 경우 문의해 주세요.",
    });
  } else {
    res.status(403).render("message", {
      message:
        "계정을 찾을 수 없습니다.<br/>베타 서비스에 가입하시면 계정이 생성되었을 때 연락드리겠습니다!",
    });
  }
}


export function sendConflictError(res: express.Response, message?: string): void {
  message = message ? sanitizeHtml(message) : "The provided resource already exists";
  res.status(409).send(message);
}

export function sendAlreadyExistsPage(res: express.Response, message: string): void {
  res.status(409).render("message", { message: message });
}

export function sendResourceGoneError(res: express.Response, message: string): void {
  res.status(410).send(sanitizeHtml(message));
}

export function sendResourceGonePage(res: express.Response, message: string): void {
  res.status(410).render("message", { message: message });
}

export function sendTooLargeError(res: express.Response): void {
  res.status(413).send("The provided resource is too large");
}

export function sendConnectionFailedError(res: express.Response): void {
  res.status(503).send("The CodePush server temporarily timed out. Please try again.");
}

export function sendUnknownError(res: express.Response, error: any, next: Function): void {
  error = error || new Error("Unknown error");

  if (typeof error["stack"] === "string") {
    console.log(error["stack"]);
  } else {
    console.log(error);
  }

  if (AppInsights.isAppInsightsInstrumented()) {
    next(error); // Log error with AppInsights.
  } else {
    res.sendStatus(500);
  }
}

function storageErrorHandler(res: express.Response, error: storageTypes.StorageError, next: Function): void {
  switch (error.code) {
    case storageTypes.ErrorCode.NotFound:
      sendNotFoundError(res, error.message);
      break;
    case storageTypes.ErrorCode.AlreadyExists:
      sendConflictError(res, error.message);
      break;
    case storageTypes.ErrorCode.TooLarge:
      sendTooLargeError(res);
      break;
    case storageTypes.ErrorCode.ConnectionFailed:
      sendConnectionFailedError(res);
      break;
    case storageTypes.ErrorCode.Invalid:
      sendMalformedRequestError(res, error.message);
      break;
    case storageTypes.ErrorCode.Other:
    default:
      console.log("Unknown storage error.");
      sendUnknownError(res, error, next);
      break;
  }
}
