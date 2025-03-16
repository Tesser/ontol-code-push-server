// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as semver from "semver";

import * as storageTypes from "../infrastructure/storage";
import * as redis from "../redis-manager";
import { UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import * as acquisitionUtils from "../utils/acquisition";
import * as utils from "../utils/common";
import * as errorUtils from "../utils/rest-error-handling";
import * as restHeaders from "../utils/rest-headers";
import * as rolloutSelector from "../utils/rollout-selector";
import * as validationUtils from "../utils/validation";

import * as q from "q";
import * as queryString from "querystring";
import * as URL from "url";
import Promise = q.Promise;

const METRICS_BREAKING_VERSION = "1.5.2-beta";

export interface AcquisitionConfig {
  storage: storageTypes.Storage;
  redisManager: redis.RedisManager;
}

/**
 * 주어진 URL을 키로 변환합니다.
 * @param originalUrl 원본 URL
 * @returns 키
 */
function getUrlKey(originalUrl: string): string {
  const obj: any = URL.parse(originalUrl, /*parseQueryString*/ true);
  delete obj.query.clientUniqueId;
  return obj.pathname + "?" + queryString.stringify(obj.query);
}

/**
 * 주어진 저장소를 사용하여 캐시 가능한 응답을 생성합니다.
 * - 클라이언트(앱)로부터 받은 업데이트 체크 요청을 처리합니다.
 * - 스토리지(DB)에서 패키지 히스토리를 조회하여 업데이트 정보를 포함한 응답을 생성합니다.
 * @param req 요청
 * @param res 응답
 * @param storage 저장소
 */
function createResponseUsingStorage(
  req: express.Request,
  res: express.Response,
  storage: storageTypes.Storage
): Promise<redis.CacheableResponse> {
  // 클라이언트 요청에서 배포 키, 앱 버전, 패키지 해시, 개발용 앱 여부 등의 정보를 추출합니다.
  const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
  const appVersion: string = String(req.query.appVersion || req.query.app_version);
  const packageHash: string = String(req.query.packageHash || req.query.package_hash);
  const isCompanion: string = String(req.query.isCompanion || req.query.is_companion);

  // 추출한 정보로 업데이트 체크 요청 객체를 생성합니다.
  const updateRequest: UpdateCheckRequest = {
    deploymentKey: deploymentKey,
    appVersion: appVersion,
    packageHash: packageHash,
    isCompanion: isCompanion && isCompanion.toLowerCase() === "true",
    label: String(req.query.label),
  };

  let originalAppVersion: string;

  // semver 표준을 따르지 않는 버전 형식을 정규화합니다:
  // 앱 버전이 정수인 경우를 처리합니다.
  const isPlainIntegerNumber: boolean = /^\d+$/.test(updateRequest.appVersion);
  if (isPlainIntegerNumber) {
    originalAppVersion = updateRequest.appVersion;
    updateRequest.appVersion = originalAppVersion + ".0.0"; // 1 -> 1.0.0
  }

  // 패치 버전이 없는 경우(예: "2.0" 또는 "2.0-prerelease")를 처리합니다.
  const isMissingPatchVersion: boolean = /^\d+\.\d+([\+\-].*)?$/.test(updateRequest.appVersion);
  if (isMissingPatchVersion) {
    originalAppVersion = updateRequest.appVersion;
    const semverTagIndex = originalAppVersion.search(/[\+\-]/);
    if (semverTagIndex === -1) {
      updateRequest.appVersion += ".0"; // 2.0 -> 2.0.0
    } else {
      updateRequest.appVersion = originalAppVersion.slice(0, semverTagIndex) + ".0" + originalAppVersion.slice(semverTagIndex); // 2.0-prerelease -> 2.0.0-prerelease
    }
  }

  // 업데이트 체크 요청이 유효한지 검사합니다.
  if (validationUtils.isValidUpdateCheckRequest(updateRequest)) {
    // 배포 키를 사용하여 MongoDB에서 패키지 히스토리를 조회합니다.
    return storage.getPackageHistoryFromDeploymentKey(updateRequest.deploymentKey).then((packageHistory: storageTypes.Package[]) => {
      // 패키지 히스토리를 기반으로 업데이트 정보를 추출합니다.
      const updateObject: UpdateCheckCacheResponse = acquisitionUtils.getUpdatePackageInfo(packageHistory, updateRequest);
      // 클라이언트가 원래 보낸 형식과 일치하도록 정규화된 버전 형식을 원본 형식으로 복원합니다. 예: 1.0.0 -> 1
      if ((isMissingPatchVersion || isPlainIntegerNumber) && updateObject.originalPackage.appVersion === updateRequest.appVersion) {
        // 응답의 appVersion을 원래 버전으로 설정합니다.
        updateObject.originalPackage.appVersion = originalAppVersion;
        if (updateObject.rolloutPackage) {
          updateObject.rolloutPackage.appVersion = originalAppVersion;
        }
      }

      // Redis에 캐시할 수 있는 형태로 응답을 구성하고 반환합니다.
      const cacheableResponse: redis.CacheableResponse = {
        statusCode: 200,
        body: updateObject,
      };

      return q(cacheableResponse);
    });
  } else {
    if (!validationUtils.isValidKeyField(updateRequest.deploymentKey)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key - please check that your app has been " +
          "configured correctly. To view available deployment keys, run 'code-push-standalone deployment ls <appName> -k'."
      );
    } else if (!validationUtils.isValidAppVersionField(updateRequest.appVersion)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a binary version that conforms to the semver standard (e.g. '1.0.0'). " +
          "The binary version is normally inferred from the App Store/Play Store version configured with your app."
      );
    } else {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key and provide a semver-compliant app version."
      );
    }

    return q<redis.CacheableResponse>(null);
  }
}

/**
 * 상태 확인 라우터를 반환합니다.
 * - 서비스의 핵심 구성 요소(스토리지와 Redis)가 정상적으로 작동하는지 확인하고, 상태 점검 엔드포인트를 제공합니다.
 * @param config 설정
 * @returns 상태 확인 라우터
 */
export function getHealthRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  router.get("/health", (req: express.Request, res: express.Response, next: (err?: any) => void): any => {
    // 스토리지 상태를 확인합니다.
    storage
      .checkHealth()
      .then(() => {
        // Redis 상태를 확인합니다.
        return redisManager.checkHealth();
      })
      .then(() => {
        res.status(200).send("Healthy");
      })
      .catch((error: Error) => errorUtils.sendUnknownError(res, error, next))
      .done();
  });

  return router;
}

/**
 * 앱 업데이트 확인, 다운로드 상태 보고, 배포 상태 보고를 처리하는 API 엔드포인트를 설정합니다.
 * @param config 설정
 * @returns 업데이트 체크 라우터
 */
export function getAcquisitionRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  /**
   * 업데이트 체크 라우터를 반환합니다.
   * @param newApi 새로운 API 여부
   * @returns 업데이트 체크 라우터
   */
  const updateCheck = function (newApi: boolean) {
    return function (req: express.Request, res: express.Response, next: (err?: any) => void) {
      // 요청 정보에서 배포 키, 클라이언트 ID, URL 등을 추출합니다.
      const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
      const key: string = redis.Utilities.getDeploymentKeyHash(deploymentKey);
      const clientUniqueId: string = String(req.query.clientUniqueId || req.query.client_unique_id);
      const url: string = getUrlKey(req.originalUrl);
      let fromCache: boolean = true;
      let redisError: Error;

      // Redis에서 캐시된 응답을 가져옵니다.
      // 동일한 요청에 대한 응답이 캐시되어 있는지 확인합니다.
      // 캐시된 응답이 있으면 데이터베이스 조회를 건너뜁니다.
      redisManager
        .getCachedResponse(key, url)
        .catch((error: Error) => {
          // Redis 오류를 저장하여 응답을 보낸 후 오류를 던질 수 있도록 합니다.
          redisError = error;
          return q<redis.CacheableResponse>(null);
        })
        .then((cachedResponse: redis.CacheableResponse) => {
          fromCache = !!cachedResponse;
          // 캐시된 응답이 없으면 스토리지(DB)에서 업데이트 정보를 조회합니다.
          return cachedResponse || createResponseUsingStorage(req, res, storage);
        })
        .then((response: redis.CacheableResponse) => {
          if (!response) {
            return q<void>(null);
          }

          // 점진적 배포(롤아웃) 중인 패키지가 있으면 클라이언트가 롤아웃 대상인지 확인합니다.
          let giveRolloutPackage: boolean = false;
          const cachedResponseObject = <UpdateCheckCacheResponse>response.body;
          if (cachedResponseObject.rolloutPackage && clientUniqueId) {
            const releaseSpecificString: string =
              cachedResponseObject.rolloutPackage.label || cachedResponseObject.rolloutPackage.packageHash;
            giveRolloutPackage = rolloutSelector.isSelectedForRollout(
              clientUniqueId,
              cachedResponseObject.rollout,
              releaseSpecificString
            );
          }

          // 롤아웃 대상이면 새 패키지를, 아니면 원본 패키지를 응답에 포함합니다.
          const updateCheckBody: { updateInfo: UpdateCheckResponse } = {
            updateInfo: giveRolloutPackage ? cachedResponseObject.rolloutPackage : cachedResponseObject.originalPackage,
          };

          // 새 API에서는 타겟 바이너리 범위를 업데이트 정보의 appVersion으로 설정합니다.
          updateCheckBody.updateInfo.target_binary_range = updateCheckBody.updateInfo.appVersion;

          res.locals.fromCache = fromCache;
          // API 버전에 따라 응답 형식을 조정합니다.
          res.status(response.statusCode).send(newApi ? utils.convertObjectToSnakeCase(updateCheckBody) : updateCheckBody);

          // 응답이 캐시에서 오지 않았다면 응답을 Redis에 캐시합니다.
          if (!fromCache) {
            return redisManager.setCachedResponse(key, url, response);
          }
        })
        .then(() => {
          if (redisError) {
            throw redisError;
          }
        })
        .catch((error: storageTypes.StorageError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    };
  };

  /**
   * 앱이 업데이트 적용 결과(성공/실패)를 보고하는 요청을 처리합니다
   * @param req 요청
   * @param res 응답
   * @param next 오류 처리 함수
   * @returns 배포 상태 보고 라우터
   */
  const reportStatusDeploy = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    // 배포 키, 앱 버전, 이전 배포 키 등을 추출하고 필수 정보 누락 여부를 확인합니다.
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    const appVersion = req.body.appVersion || req.body.app_version;
    const previousDeploymentKey = req.body.previousDeploymentKey || req.body.previous_deployment_key || deploymentKey;
    const previousLabelOrAppVersion = req.body.previousLabelOrAppVersion || req.body.previous_label_or_app_version;
    const clientUniqueId = req.body.clientUniqueId || req.body.client_unique_id;

    if (!deploymentKey || !appVersion) {
      return errorUtils.sendMalformedRequestError(res, "A deploy status report must contain a valid appVersion and deploymentKey.");
    } else if (req.body.label) {
      if (!req.body.status) {
        return errorUtils.sendMalformedRequestError(res, "A deploy status report for a labelled package must contain a valid status.");
      } else if (!redis.Utilities.isValidDeploymentStatus(req.body.status)) {
        return errorUtils.sendMalformedRequestError(res, "Invalid status: " + req.body.status);
      }
    }

    // 클라이언트 SDK 버전에 따라 다른 처리 로직을 적용합니다.
    const sdkVersion: string = restHeaders.getSdkVersion(req);
    if (semver.valid(sdkVersion) && semver.gte(sdkVersion, METRICS_BREAKING_VERSION)) {
      // 이전 배포 키가 제공되지 않으면 동일한 배포 키로 가정합니다.
      let redisUpdatePromise: q.Promise<void>;

      if (req.body.label && req.body.status === redis.DEPLOYMENT_FAILED) {
        // 라벨이 제공되고 배포가 실패한 경우, 라벨 상태 카운트를 증가시킵니다.
        redisUpdatePromise = redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status);
      } else {
        // 배포 성공 시 업데이트 기록을 저장합니다.
        const labelOrAppVersion: string = req.body.label || appVersion;
        redisUpdatePromise = redisManager.recordUpdate(
          deploymentKey,
          labelOrAppVersion,
          previousDeploymentKey,
          previousLabelOrAppVersion
        );
      }

      redisUpdatePromise
        .then(() => {
          res.sendStatus(200);
          if (clientUniqueId) {
            redisManager.removeDeploymentKeyClientActiveLabel(previousDeploymentKey, clientUniqueId);
          }
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
        .done();
    } else {
      if (!clientUniqueId) {
        return errorUtils.sendMalformedRequestError(
          res,
          "A deploy status report must contain a valid appVersion, clientUniqueId and deploymentKey."
        );
      }

      // 구버전 SDK인 경우 클라이언트의 현재 활성 레이블을 조회하여 처리합니다.
      // 레이블이 변경된 경우 상태 카운터를 업데이트하고 활성 앱 정보를 갱신합니다.
      return redisManager
        .getCurrentActiveLabel(deploymentKey, clientUniqueId)
        .then((currentVersionLabel: string) => {
          if (req.body.label && req.body.label !== currentVersionLabel) {
            return redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status).then(() => {
              if (req.body.status === redis.DEPLOYMENT_SUCCEEDED) {
                return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, req.body.label, currentVersionLabel);
              }
            });
          } else if (!req.body.label && appVersion !== currentVersionLabel) {
            return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, appVersion, appVersion);
          }
        })
        .then(() => {
          res.sendStatus(200);
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
        .done();
    }
  };

  /**
   * 앱이 업데이트 패키지 다운로드 결과를 보고하는 요청을 처리합니다.
   * @param req 요청
   * @param res 응답
   * @param next 오류 처리 함수
   * @returns 다운로드 상태 보고 라우터
   */
  const reportStatusDownload = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    if (!req.body || !deploymentKey || !req.body.label) {
      return errorUtils.sendMalformedRequestError(
        res,
        "A download status report must contain a valid deploymentKey and package label."
      );
    }
    // 해당 패키지의 다운로드 카운터를 증가시킵니다.
    return redisManager
      .incrementLabelStatusCount(deploymentKey, req.body.label, redis.DOWNLOADED)
      .then(() => {
        res.sendStatus(200);
      })
      .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
      .done();
  };

  // 업데이트 체크 라우터를 설정합니다.
  // API 버전 간 호환성 유지를 위해 각 기능에 대해 두 가지 URL 패턴을 등록합니다.
  router.get("/updateCheck", updateCheck(false));
  router.get("/v0.1/public/codepush/update_check", updateCheck(true));

  router.post("/reportStatus/deploy", reportStatusDeploy);
  router.post("/v0.1/public/codepush/report_status/deploy", reportStatusDeploy);

  router.post("/reportStatus/download", reportStatusDownload);
  router.post("/v0.1/public/codepush/report_status/download", reportStatusDownload);

  return router;
}
