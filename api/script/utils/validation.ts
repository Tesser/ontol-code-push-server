// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as semver from "semver";
import * as storageTypes from "../infrastructure/storage";
import * as restTypes from "../types/rest-definitions";
import { ALLOWED_KEY_CHARACTERS_TEST } from "./security";

import emailValidator = require("email-validator");

module Validation {
  /**
   * 문자열 유효성 검사 함수를 반환합니다.
   * @param maxLength 최대 길이
   * @param minLength 최소 길이
   * @returns 유효성 검사 결과
   */
  function getStringValidator(maxLength: number = 1000, minLength: number = 0): (value: any) => boolean {
    return function isValidString(value: string): boolean {
      if (typeof value !== "string") {
        return false;
      }

      if (maxLength > 0 && value.length > maxLength) {
        return false;
      }

      return value.length >= minLength;
    };
  }

  export function isValidAppVersionField(appVersion: any): boolean {
    return appVersion && semver.valid(appVersion) !== null;
  }

  /**
   * 앱 버전 범위의 유효성을 검사합니다.
   * @param appVersion 앱 버전
   * @returns 유효성 검사 결과
   */
  function isValidAppVersionRangeField(appVersion: any): boolean {
    return !!semver.validRange(appVersion);
  }

  /**
   * 불리언 필드의 유효성을 검사합니다.
   * @param val 불리언 값
   * @returns 유효성 검사 결과
   */
  function isValidBooleanField(val: any): boolean {
    return typeof val === "boolean";
  }

  /**
   * 레이블 필드의 유효성을 검사합니다.
   * @param val 레이블
   * @returns 유효성 검사 결과
   */
  function isValidLabelField(val: any): boolean {
    return val && val.match(/^v[1-9][0-9]*$/) !== null; //레이블 필드가 'v1-v9999...' 표준을 따르는지 검사합니다.
  }

  function isValidEmailField(email: any): boolean {
    return (
      getStringValidator(/*maxLength=*/ 255, /*minLength=*/ 1)(email) &&
      emailValidator.validate(email) &&
      !/[\\\/\?]/.test(email) && // URL 특수 문자(\\, /, ?)를 금지합니다.
      !/[\x00-\x1F]/.test(email) && // ASCII 제어 문자(0x00-0x1F 범위)를 금지합니다.
      !/[\x7F-\x9F]/.test(email) &&
      !/[ \*]/.test(email) && // 현재 스토리지 레이어에서 PartitionKey에 공백(' ')과 별표('') 문자를 금지하고 있기 때문에 이 문자들을 허용하지 않습니다.
      !/:/.test(email)
    ); // 콜론(:) 문자를 금지합니다. 이는 한정된 앱 이름에 대한 구분자로 사용되기 때문입니다.
  }

  function isValidTtlField(allowZero: boolean, val: number): boolean {
    return !isNaN(val) && val >= 0 && (val != 0 || allowZero);
  }

  export function isValidKeyField(val: any): boolean {
    return getStringValidator(/*maxLength=*/ 100, /*minLength=*/ 10)(val) && ALLOWED_KEY_CHARACTERS_TEST.test(val);
  }

  function isValidNameField(name: any): boolean {
    return (
      getStringValidator(/*maxLength=*/ 1000, /*minLength=*/ 1)(name) &&
      !/[\\\/\?]/.test(name) && // Forbid URL special characters until #374 is resolved
      !/[\x00-\x1F]/.test(name) && // Control characters
      !/[\x7F-\x9F]/.test(name) &&
      !/:/.test(name)
    ); // Forbid colon because we use it as a delimiter for qualified app names
  }

  /**
   * 롤아웃 필드의 유효성을 검사합니다.
   * @param rollout 롤아웃
   * @returns 유효성 검사 결과
   */
  export function isValidRolloutField(rollout: any): boolean {
    // rollout은 선택적 필드이며, 정의된 경우 1-100 사이의 숫자여야 합니다.
    return /^(100|[1-9][0-9]|[1-9])$/.test(rollout);
  }

  /**
   * 설명 필드의 유효성을 검사합니다.
   * @param description 설명
   * @returns 유효성 검사 결과
   */
  const isValidDescriptionField = getStringValidator(/*maxLength=*/ 10000);
  const isValidFriendlyNameField = getStringValidator(/*maxLength=*/ 10000, /*minLength*/ 1);

  export interface ValidationError {
    field: string;
    message: string;
  }

  export interface FieldDefinition {
    [key: string]: (val: any) => boolean;
  }

  export function isValidUpdateCheckRequest(updateCheckRequest: restTypes.UpdateCheckRequest): boolean {
    const fields: FieldDefinition = {
      appVersion: isValidAppVersionField,
      deploymentKey: isValidKeyField,
    };

    const requiredFields = ["appVersion", "deploymentKey"];

    return validate(updateCheckRequest, fields, requiredFields).length === 0;
  }

  export function validateAccessKeyRequest(accessKey: restTypes.AccessKeyRequest, isUpdate: boolean): ValidationError[] {
    const fields: FieldDefinition = {
      friendlyName: isValidFriendlyNameField,
      ttl: isValidTtlField.bind(/*thisArg*/ null, /*allowZero*/ isUpdate),
    };

    let requiredFields: string[] = [];
    if (!isUpdate) {
      fields["name"] = isValidKeyField;
      requiredFields = ["name", "friendlyName"];
    }

    return validate(accessKey, fields, requiredFields);
  }

  export function validateAccount(account: restTypes.Account, isUpdate: boolean): ValidationError[] {
    const fields: FieldDefinition = {
      email: isValidEmailField,
      name: getStringValidator(/*maxLength=*/ 1000, /*minLength=*/ 1),
    };

    let requiredFields: string[] = [];

    if (!isUpdate) {
      requiredFields = ["name"];
    }

    return validate(account, fields, requiredFields);
  }

  export function validateApp(app: restTypes.App | storageTypes.App, isUpdate: boolean): ValidationError[] {
    const fields: FieldDefinition = {
      name: isValidNameField, // During creation/modification, the app's 'name' field will never be qualified with an email
    };

    let requiredFields: string[] = [];

    if (!isUpdate) {
      requiredFields = ["name"];
    }

    return validate(app, fields, requiredFields);
  }

  export function validateDeployment(deployment: restTypes.Deployment, isUpdate: boolean): ValidationError[] {
    const fields: FieldDefinition = {
      name: isValidNameField,
      key: isValidKeyField,
    };

    let requiredFields: string[] = [];

    if (!isUpdate) {
      requiredFields = ["name"];
    }

    return validate(deployment, fields, requiredFields);
  }

  /**
   * 패키지 정보의 유효성을 검사합니다.
   * @param packageInfo 패키지 정보
   * @param allOptional 모든 필드가 선택적인지 여부
   * @returns 유효성 검사 결과
   */
  export function validatePackageInfo(packageInfo: restTypes.PackageInfo, allOptional: boolean): ValidationError[] {
    const fields: FieldDefinition = {
      appVersion: isValidAppVersionRangeField,
      description: isValidDescriptionField,
      label: isValidLabelField,
      isDisabled: isValidBooleanField,
      isMandatory: isValidBooleanField,
      rollout: isValidRolloutField,
    };

    let requiredFields: string[] = [];

    if (!allOptional) {
      requiredFields = ["appVersion"];
    }

    return validate(packageInfo, fields, requiredFields);
  }

  function validate(
    obj: any,
    fieldValidators: { [key: string]: (val: any) => boolean },
    requiredFields: string[] = []
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    Object.keys(fieldValidators).forEach((fieldName: string) => {
      const validator: (val: any) => boolean = fieldValidators[fieldName];
      const fieldValue: any = obj[fieldName];
      if (isDefined(fieldValue)) {
        if (!validator(fieldValue)) {
          errors.push({ field: fieldName, message: "Field is invalid" });
        }
      } else {
        const requiredIndex = requiredFields.indexOf(fieldName);
        if (requiredIndex >= 0) {
          errors.push({ field: fieldName, message: "Field is required" });
        }
      }
    });

    return errors;
  }

  export function isDefined(val: any): boolean {
    return val !== null && val !== undefined;
  }
}

export = Validation;
