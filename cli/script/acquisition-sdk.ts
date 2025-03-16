// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { UpdateCheckResponse, UpdateCheckRequest, DeploymentStatusReport, DownloadReport } from "../script/types/rest-definitions";

export namespace Http {
  export const enum Verb {
    GET,
    HEAD,
    POST,
    PUT,
    DELETE,
    TRACE,
    OPTIONS,
    CONNECT,
    PATCH,
  }

  export interface Response {
    statusCode: number;
    body?: string;
  }

  export interface Requester {
    request(verb: Verb, url: string, callback: Callback<Response>): void;
    request(verb: Verb, url: string, requestBody: string, callback: Callback<Response>): void;
  }
}

// All fields are non-nullable, except when retrieving the currently running package on the first run of the app,
// in which case only the appVersion is compulsory
export interface Package {
  deploymentKey: string;
  description: string;
  label: string;
  appVersion: string;
  isMandatory: boolean;
  packageHash: string;
  packageSize: number;
}

export interface RemotePackage extends Package {
  downloadUrl: string;
}

export interface NativeUpdateNotification {
  updateAppVersion: boolean; // Always true
  appVersion: string;
}

export interface LocalPackage extends Package {
  localPath: string;
}

export interface Callback<T> {
  (error: Error, parameter: T): void;
}

export interface Configuration {
  appVersion: string;
  clientUniqueId: string;
  deploymentKey: string;
  serverUrl: string;
  ignoreAppVersion?: boolean;
}

export class AcquisitionStatus {
  public static DeploymentSucceeded = "DeploymentSucceeded";
  public static DeploymentFailed = "DeploymentFailed";
}

/**
 * 배포 관리 클래스
 * 앱 업데이트 체크, 배포 상태 보고, 다운로드 상태 보고 등의 기능을 제공합니다.
 */
export class AcquisitionManager {
  private _appVersion: string;
  private _clientUniqueId: string;
  private _deploymentKey: string;
  private _httpRequester: Http.Requester;
  private _ignoreAppVersion: boolean;
  private _serverUrl: string;

  constructor(httpRequester: Http.Requester, configuration: Configuration) {
    this._httpRequester = httpRequester;

    this._serverUrl = configuration.serverUrl;
    if (this._serverUrl.slice(-1) !== "/") {
      this._serverUrl += "/";
    }

    this._appVersion = configuration.appVersion;
    this._clientUniqueId = configuration.clientUniqueId;
    this._deploymentKey = configuration.deploymentKey;
    this._ignoreAppVersion = configuration.ignoreAppVersion;
  }

  /**
   * 현재 패키지를 사용하여 업데이트 체크를 수행합니다.
   * - React Native OTA 업데이트 체크 기능을 제공합니다.
   * - 사용자가 앱 스토어를 통하지 않고도 최신 JS 번들을 다운로드 받을 수 있습니다.
   * - 롤아웃 처리, 필수 업데이트 여부, 차등 업데이트 URL 등의 정보가 서버에서 결정되어 반환됩니다.
   * @param currentPackage 현재 패키지
   * @param callback 콜백 함수
   */
  public queryUpdateWithCurrentPackage(currentPackage: Package, callback?: Callback<RemotePackage | NativeUpdateNotification>): void {
    // 현재 패키지와 앱 버전이 제공되었는지 확인합니다.
    if (!currentPackage || !currentPackage.appVersion) {
      throw new Error("Calling common acquisition SDK with incorrect package"); // Unexpected; indicates error in our implementation
    }

    // 업데이트 요청 객체를 생성합니다.
    const updateRequest: UpdateCheckRequest = {
      deploymentKey: this._deploymentKey,
      appVersion: currentPackage.appVersion,
      packageHash: currentPackage.packageHash,
      isCompanion: this._ignoreAppVersion,
      label: currentPackage.label,
      clientUniqueId: this._clientUniqueId,
    };

    // 업데이트 요청 URL을 생성합니다.
    const requestUrl: string = this._serverUrl + "updateCheck?" + queryStringify(updateRequest);

    this._httpRequester.request(Http.Verb.GET, requestUrl, (error: Error, response: Http.Response) => {
      if (error) {    
        callback(error, /*remotePackage=*/ null);
        return;
      }

      if (response.statusCode !== 200) {
        callback(new Error(response.statusCode + ": " + response.body), /*remotePackage=*/ null);
        return;
      }

      let updateInfo: UpdateCheckResponse;
      
      // 서버 응답을 JSON으로 파싱하고 업데이트 정보를 추출합니다.
      try {
        const responseObject = JSON.parse(response.body);
        updateInfo = responseObject.updateInfo;
      } catch (error) {
        callback(error, /*remotePackage=*/ null);
        return;
      }

      // 업데이트 정보가 없으면 오류를 반환합니다.
      // 앱 스토어 업데이트가 필요한 경우 해당 정보를 반환합니다.
      // 업데이트가 없는 경우 'null'을 반환합니다.
      if (!updateInfo) {
        callback(error, /*remotePackage=*/ null);
        return;
      } else if (updateInfo.updateAppVersion) {
        callback(/*error=*/ null, {
          updateAppVersion: true,
          appVersion: updateInfo.appVersion,
        });
        return;
      } else if (!updateInfo.isAvailable) {
        callback(/*error=*/ null, /*remotePackage=*/ null);
        return;
      }

      /**
       * 원격 패키지 객체를 생성합니다.
       * 서버에서 받은 업데이트 정보를 클라이언트에서 사용할 형태로 변환합니다.
       */
      const remotePackage: RemotePackage = {
        deploymentKey: this._deploymentKey,
        description: updateInfo.description,
        label: updateInfo.label,
        appVersion: updateInfo.appVersion,
        isMandatory: updateInfo.isMandatory,
        packageHash: updateInfo.packageHash,
        packageSize: updateInfo.packageSize,
        downloadUrl: updateInfo.downloadURL,
      };

      callback(/*error=*/ null, remotePackage);
    });
  }

  /**
   * 앱 배포 상태를 서버에 보고합니다.
   * - 개발자가 배포 상태를 모니터링하고, 문제가 있는 업데이트를 빠르게 식별할 수 있게 합니다.
   * - 다운로드 된 패키지의 설치 및 적용 결과를 보고합니다.
   * @param deployedPackage 배포된 패키지
   * @param status 배포 상태
   * @param previousLabelOrAppVersion 이전 라벨 또는 앱 버전
   * @param previousDeploymentKey 이전 배포 키
   * @param callback 콜백 함수
   */
  public reportStatusDeploy(
    deployedPackage?: Package,
    status?: string,
    previousLabelOrAppVersion?: string,
    previousDeploymentKey?: string,
    callback?: Callback<void>
  ): void {
    const url: string = this._serverUrl + "reportStatus/deploy";
    const body: DeploymentStatusReport = {
      appVersion: this._appVersion,
      deploymentKey: this._deploymentKey,
    };

    if (this._clientUniqueId) {
      body.clientUniqueId = this._clientUniqueId;
    }

    // 배포 패키지 정보가 제공된 경우 설명과 앱 버전을 요청에 추가합니다.
    // 상태 값이 유효한지(DeploymentSucceeded, DeploymentFailed) 확인하고 유효하지 않으면 오류를 반환합니다.
    if (deployedPackage) {
      body.label = deployedPackage.label;
      body.appVersion = deployedPackage.appVersion;

      switch (status) {
        case AcquisitionStatus.DeploymentSucceeded:
        case AcquisitionStatus.DeploymentFailed:
          body.status = status;
          break;

        default:
          if (callback) {
            if (!status) {
              callback(new Error("Missing status argument."), /*not used*/ null);
            } else {
              callback(new Error('Unrecognized status "' + status + '".'), /*not used*/ null);
            }
          }
          return;
      }
    }

    // 이전 버전 정보가 제공된 경우 요청에 포함합니다.
    if (previousLabelOrAppVersion) {
      body.previousLabelOrAppVersion = previousLabelOrAppVersion;
    }

    if (previousDeploymentKey) {
      body.previousDeploymentKey = previousDeploymentKey;
    }

    callback = typeof arguments[arguments.length - 1] === "function" && arguments[arguments.length - 1];

    this._httpRequester.request(Http.Verb.POST, url, JSON.stringify(body), (error: Error, response: Http.Response): void => {
      if (callback) {
        if (error) {
          callback(error, /*not used*/ null);
          return;
        }

        if (response.statusCode !== 200) {
          callback(new Error(response.statusCode + ": " + response.body), /*not used*/ null);
          return;
        }

        callback(/*error*/ null, /*not used*/ null);
      }
    });
  }

  /**
   * 앱 다운로드 상태를 서버에 보고합니다.
   * - React Native 앱에서 업데이트 패키지의 다운로드 상태를 서버에 보고합니다.
   * - 앱이 새 업데이트 패키지를 성공적으로 다운로드 했음을 서버에 알려 다운로드 통계를 추적할 수 있게 합니다.
   * @param downloadedPackage 다운로드된 패키지
   * @param callback 콜백 함수
   */
  public reportStatusDownload(downloadedPackage: Package, callback?: Callback<void>): void {
    const url: string = this._serverUrl + "reportStatus/download";
    const body: DownloadReport = {
      clientUniqueId: this._clientUniqueId,
      deploymentKey: this._deploymentKey,
      label: downloadedPackage.label,
    };

    this._httpRequester.request(Http.Verb.POST, url, JSON.stringify(body), (error: Error, response: Http.Response): void => {
      if (callback) {
        if (error) {
          callback(error, /*not used*/ null);
          return;
        }

        if (response.statusCode !== 200) {
          callback(new Error(response.statusCode + ": " + response.body), /*not used*/ null);
          return;
        }

        callback(/*error*/ null, /*not used*/ null);
      }
    });
  }
}

/**
 * JavaScript 객체를 URL 쿼리 문자열 형식으로 변환합니다.
 * @param object 변환할 객체
 * @returns 쿼리 문자열
 */
function queryStringify(object: Object): string {
  let queryString = "";
  let isFirst: boolean = true;

  for (const property in object) {
    if (object.hasOwnProperty(property)) {
      const value: string = (<any>object)[property];
      if (!isFirst) {
        queryString += "&";
      }

      queryString += encodeURIComponent(property) + "=";
      if (value !== null && typeof value !== "undefined") {
        queryString += encodeURIComponent(value);
      }

      isFirst = false;
    }
  }

  return queryString;
}
