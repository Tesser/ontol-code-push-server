// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as semver from "semver";
import { Package } from "../infrastructure/storage";
import { UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import { isUnfinishedRollout } from "./rollout-selector";

interface UpdatePackage {
  response: UpdateCheckResponse;
  rollout?: number;
}

/**
 * 업데이트 패키지 정보를 가져옵니다.
 * - 클라이언트의 업데이트 요청을 처리합니다.
 * - 롤아웃 중인 업데이트가 있는 경우 이를 적절히 처리해 응답을 구성합니다.
 * @param packageHistory 패키지 이력
 * @param request 업데이트 체크 요청
 * @returns 업데이트 패키지 정보
 */
export function getUpdatePackageInfo(packageHistory: Package[], request: UpdateCheckRequest): UpdateCheckCacheResponse {
  // 적합한 업데이트 패키지를 찾습니다.
  const updatePackage: UpdatePackage = getUpdatePackage(packageHistory, request, /*ignoreRolloutPackages*/ false);
  let cacheResponse: UpdateCheckCacheResponse;

  // 찾은 패키지가 롤아웃 중인지(100% 미만으로 배포 중인지) 여부를 확인합니다.
  if (isUnfinishedRollout(updatePackage.rollout)) {
    // 롤아웃 중인 패키지를 무시하고 다시 패키지를 조회합니다.
    const origUpdatePackage: UpdatePackage = getUpdatePackage(packageHistory, request, /*ignoreRolloutPackages*/ true);
    // 원본 패키지(롤아웃 이전 패키지)와 롤아웃 중인 패키지 모두를 응답에 포함합니다.
    // 롤라웃 비율도 함께 응답에 포함합니다.
    cacheResponse = <UpdateCheckCacheResponse>{
      originalPackage: origUpdatePackage.response,
      rolloutPackage: updatePackage.response,
      rollout: updatePackage.rollout,
    };
  } else {
    // 롤아웃 중이 아닌 경우 단순히 찾은 패키지를 응답에 포함합니다.
    cacheResponse = { originalPackage: updatePackage.response };
  }

  return cacheResponse;
}

/**
 * 업데이트 패키지를 가져옵니다.
 * 1. 패키지 히스토리를 검사합니다.
 * 2. 현재 실행 중인 버전과 비교합니다.
 * 3. 앱 버전의 호환성을 확인합니다.
 * 4. 필수 업데이트 여부를 확인합니다.
 * @param packageHistory 패키지 이력
 * @param request 업데이트 체크 요청
 * @param ignoreRolloutPackages 롤아웃 패키지 무시 여부
 * @returns 업데이트 패키지 정보
 */
function getUpdatePackage(packageHistory: Package[], request: UpdateCheckRequest, ignoreRolloutPackages?: boolean): UpdatePackage {
  const updateDetails: UpdateCheckResponse = {
    downloadURL: "",
    description: "",
    isAvailable: false,
    isMandatory: false,
    appVersion: "",
    packageHash: "",
    label: "",
    packageSize: 0,
    updateAppVersion: false,
  };

  // 패키지 히스토리가 없으면 바이너리 버전을 실행하도록 지시하고 종료합니다.
  if (!packageHistory || packageHistory.length === 0) {
    updateDetails.shouldRunBinaryVersion = true;
    return { response: updateDetails };
  }

  let foundRequestPackageInHistory: boolean = false;
  let latestSatisfyingEnabledPackage: Package;
  let latestEnabledPackage: Package;
  let rollout: number = null;
  let shouldMakeUpdateMandatory: boolean = false;

  // 패키지 히스토리를 역순으로 검사합니다.
  for (let i = packageHistory.length - 1; i >= 0; i--) {
    const packageEntry: Package = packageHistory[i];
    // 클라이언트가 현재 실행 중인 패키지를 히스토리에서 찾습니다.
    // 레이블이 있으면 레이블로 비교하고, 없으면 해시로 비교합니다.
    foundRequestPackageInHistory =
      foundRequestPackageInHistory ||
      (!request.label && !request.packageHash) ||
      (request.label && packageEntry.label === request.label) ||
      (!request.label && packageEntry.packageHash === request.packageHash);

    // 비활성화된 패키지나 롤아웃 중인 패키지인 경우는 건너뜁니다.
    if (packageEntry.isDisabled || (ignoreRolloutPackages && isUnfinishedRollout(packageEntry.rollout))) {
      continue;
    }

    // 첫번째로 발견된 활성화된 패키지를 최신 패키지로 기록합니다.
    latestEnabledPackage = latestEnabledPackage || packageEntry;
    
    // 개발용 앱이 아니고 클라이언트의 앱 버전이 패키지의 대상 버전 범위를 만족하지 않으면 건너뜁니다.
    if (!request.isCompanion && !semver.satisfies(request.appVersion, packageEntry.appVersion)) {
      continue;
    }

    // 첫번째로 발견된 호환되는 활성화된 패키지를 기록합니다.
    latestSatisfyingEnabledPackage = latestSatisfyingEnabledPackage || packageEntry;

    // 클라이언트가 현재 실행 중인 패키지를 히스토리에서 찾았으면 종료합니다.
    if (foundRequestPackageInHistory) {
      // 현재 실행 중인 패키지를 찾았다면, 그보다 오래된 패키지는 검사할 필요가 없으므로 루프를 종료합니다.
      break;
    } else if (packageEntry.isMandatory) {
      // 현재 실행 중인 패키지보다 새로운 필수 업데이트가 있으면, 최종 업데이트도 필수로 표시하고 루프를 종료합니다.
      shouldMakeUpdateMandatory = true;
      break;
    }
  }

  // 활성화된 패키지 중 클라이언트의 앱 버전을 만족하는 패키지가 없으면 바이너리 버전을 실행하도록 지시합니다.
  updateDetails.shouldRunBinaryVersion = !latestSatisfyingEnabledPackage;
  if (!latestEnabledPackage) {
    // 활성화된 패키지가 없으면 업데이트 없음으로 응답합니다.
    return { response: updateDetails };
  } else if (updateDetails.shouldRunBinaryVersion || latestSatisfyingEnabledPackage.packageHash === request.packageHash) {
    // 바이너리 버전을 실행해야 하거나, 클라이언트가 이미 최신 패키지를 실행 중이면 업데이트가 필요 없습니다.
    // 클라이언트의 앱 버전이 최신 패키지의 대상 버전보다 높으면, 최신 패키지의 앱 버전을 알려줍니다.
    // 클라이언트의 앱 버전이 최신 패키지의 대상 버전 범위를 만족하지 않으면, 앱 스토어 업데이트가 필요함을 알려줍니다.
    if (semver.gtr(request.appVersion, latestEnabledPackage.appVersion)) {
      updateDetails.appVersion = latestEnabledPackage.appVersion;
    } else if (!semver.satisfies(request.appVersion, latestEnabledPackage.appVersion)) {
      updateDetails.updateAppVersion = true;
      updateDetails.appVersion = latestEnabledPackage.appVersion;
    }

    return { response: updateDetails };
  } else if (
    request.packageHash &&
    latestSatisfyingEnabledPackage.diffPackageMap &&
    latestSatisfyingEnabledPackage.diffPackageMap[request.packageHash]
  ) {
    updateDetails.downloadURL = latestSatisfyingEnabledPackage.diffPackageMap[request.packageHash].url;
    updateDetails.packageSize = latestSatisfyingEnabledPackage.diffPackageMap[request.packageHash].size;
  } else {
    updateDetails.downloadURL = latestSatisfyingEnabledPackage.blobUrl;
    updateDetails.packageSize = latestSatisfyingEnabledPackage.size;
  }

  // 업데이트 패키지의 설명과 필수 업데이트 여부, 사용 가능 여부, 레이블과 패키지 해시를 설정합니다.
  updateDetails.description = latestSatisfyingEnabledPackage.description;
  updateDetails.isMandatory = shouldMakeUpdateMandatory || latestSatisfyingEnabledPackage.isMandatory;
  updateDetails.isAvailable = true;
  updateDetails.label = latestSatisfyingEnabledPackage.label;
  updateDetails.packageHash = latestSatisfyingEnabledPackage.packageHash;
  rollout = latestSatisfyingEnabledPackage.rollout;

  // 플러그인 패키지는 유효한 semver 버전(즉, 범위가 아닌 정확한 버전)만 작동하므로, 요청한 버전을 그대로 반환합니다.
  // 클라이언트의 앱 버전을 그대로 반환하고, 업데이트 정보와 롤아웃 비율을 함께 반환합니다.
  updateDetails.appVersion = request.appVersion;
  return { response: updateDetails, rollout: rollout };
}
