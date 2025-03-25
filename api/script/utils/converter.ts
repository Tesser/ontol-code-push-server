// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import nodeDeepCopy = require("node-deepcopy");

import * as redis from "../redis-manager";
import {
  AccessKey,
  AccessKeyRequest,
  Account,
  App,
  AppCreationRequest,
  CollaboratorMap,
  CollaboratorProperties,
  Deployment,
  DeploymentMetrics,
  Package,
} from "../types/rest-definitions";

import Storage = require("../infrastructure/storage");

/**
 * [Converter] 변환 함수 모음
 * MVC(Model-View-Controller) 아키텍처에서 Model 계층과 Controller 계층 사이의 데이터 변환을 담당하는 중요한 역할을 합니다. 
 * - HTTP 요청 본문(body)에서 내부 데이터 모델로 변환
 * - 내부 저장소 모델과 REST API 모델 간의 변환
 *   toRest*: 저장소 모델 → REST API 모델 (응답용)
 *   toStorage*: REST API 모델 → 저장소 모델 (저장용)
 * 
 * 1. REST API에서 사용하는 데이터 모델과 내부 저장소(Storage)에서 사용하는 데이터 모델 간의 변환 기능 제공
 * 2. 클라이언트로부터 받은 데이터를 정리하고 정규화
 * 3. 데이터 가공 및 보안 처리 (민감 정보 제거, 데이터 정렬, 중복 이름 처리 등)
 */

/**
 * 액세스 키 요청 변환
 * @param body 액세스 키 요청 본문
 * @returns 변환된 액세스 키 요청
 */
export function accessKeyRequestFromBody(body: AccessKeyRequest): AccessKeyRequest {
  const accessKeyRequest: AccessKeyRequest = <AccessKeyRequest>{};
  if (body.createdBy !== undefined) {
    accessKeyRequest.createdBy = body.createdBy;
  }

  // 액세스 키 요청 객체에 TTL(Time To Live) 값을 설정합니다.
  if (body.ttl !== undefined) {
    // 값이 문자열인 경우 parseInt를 사용하여 숫자로 변환합니다. parseInt는 이미 숫자인 경우 동일한 숫자를 반환합니다.
    accessKeyRequest.ttl = parseInt(<string>(<any>body.ttl), 10);
  }

  if (body.name !== undefined) {
    accessKeyRequest.name = body.name;
  }

  // 이 코드는 이전 "description"이 "friendlyName"으로 이름이 변경되기 전의 레거시 CLI를 위한 것입니다.
  accessKeyRequest.friendlyName = body.friendlyName === undefined ? body.description : body.friendlyName;
  accessKeyRequest.friendlyName = accessKeyRequest.friendlyName && accessKeyRequest.friendlyName.trim();
  accessKeyRequest.description = accessKeyRequest.friendlyName;

  return accessKeyRequest;
}

/**
 * 계정 변환
 * @param body 계정 본문
 * @returns 변환된 계정
 */
export function accountFromBody(body: Account): Account {
  const account: Account = <Account>{};

  account.name = body.name;
  account.email = body.email;

  return account;
}

/**
 * 애플리케이션 변환
 * @param body 애플리케이션 본문
 * @returns 변환된 애플리케이션
 */
export function appFromBody(body: App): App {
  const app: App = <App>{};

  app.name = body.name;

  return app;
}

/**
 * 애플리케이션 생성 요청 변환
 * @param body 애플리케이션 생성 요청 본문
 * @returns 변환된 애플리케이션 생성 요청
 */
export function appCreationRequestFromBody(body: AppCreationRequest): AppCreationRequest {
  const appCreationRequest: AppCreationRequest = <AppCreationRequest>{};

  appCreationRequest.name = body.name;
  appCreationRequest.manuallyProvisionDeployments = body.manuallyProvisionDeployments;

  return appCreationRequest;
}

/**
 * 배포 변환
 * @param body 배포 본문
 * @returns 변환된 배포
 */
export function deploymentFromBody(body: Deployment): Deployment {
  const deployment: Deployment = <Deployment>{};

  deployment.name = body.name;
  deployment.key = body.key;

  return deployment;
}

/**
 * 계정 변환
 * @param storageAccount 저장소 계정
 * @returns 변환된 계정
 */
export function toRestAccount(storageAccount: Storage.Account): Account {
  const restAccount: Account = {
    name: storageAccount.name,
    email: storageAccount.email,
    linkedProviders: [],
  };

  return restAccount;
}

/**
 * 애플리케이션 목록 정렬 및 표시 이름 업데이트
 * @param apps 애플리케이션 목록
 * @returns 정렬된 애플리케이션 목록
 */
export function sortAndUpdateDisplayNameOfRestAppsList(apps: App[]): App[] {
  const nameToCountMap: { [name: string]: number } = {};
  apps.forEach((app: App) => {
    nameToCountMap[app.name] = nameToCountMap[app.name] || 0;
    nameToCountMap[app.name]++;
  });

  return apps
    .sort((first: App, second: App) => {
      // Sort by raw name instead of display name
      return first.name.localeCompare(second.name);
    })
    .map((app: App) => {
      const storageApp = toStorageApp(app, 0);

      let name: string = app.name;
      if (nameToCountMap[app.name] > 1 && !Storage.isOwnedByCurrentUser(storageApp)) {
        const ownerEmail: string = Storage.getOwnerEmail(storageApp);
        name = `${ownerEmail}:${app.name}`;
      }

      return toRestApp(storageApp, name, app.deployments);
    });
}

/**
 * 애플리케이션 변환
 * @param storageApp 저장소 애플리케이션
 * @param displayName 표시 이름
 * @param deploymentNames 배포 이름 목록
 * @returns 변환된 애플리케이션
 */
export function toRestApp(storageApp: Storage.App, displayName: string, deploymentNames: string[]): App {
  const sortedDeploymentNames: string[] = deploymentNames
    ? deploymentNames.sort((first: string, second: string) => {
        return first.localeCompare(second);
      })
    : null;

  return <App>{
    name: displayName,
    collaborators: toRestCollaboratorMap(storageApp.collaborators),
    deployments: sortedDeploymentNames,
  };
}

/**
 * 팀 멤버 맵 변환
 * @param storageCollaboratorMap 저장소 팀 멤버 맵
 * @returns 변환된 팀 멤버 맵
 */
export function toRestCollaboratorMap(storageCollaboratorMap: Storage.CollaboratorMap): CollaboratorMap {
  const collaboratorMap: CollaboratorMap = {};

  Object.keys(storageCollaboratorMap)
    .sort()
    .forEach(function (key: string) {
      collaboratorMap[key] = <CollaboratorProperties>{
        isCurrentAccount: storageCollaboratorMap[key].isCurrentAccount,
        permission: storageCollaboratorMap[key].permission,
      };
    });

  return collaboratorMap;
}

/**
 * 배포 변환
 * @param storageDeployment 저장소 배포
 * @returns 변환된 배포
 */
  export function toRestDeployment(storageDeployment: Storage.Deployment): Deployment {
    const restDeployment = <Deployment>{
      name: storageDeployment.name,
      key: storageDeployment.key,
      package: storageDeployment.package,
    };

    if (restDeployment.package) {
      delete (<any>restDeployment.package).manifestBlobUrl;
    }

  return restDeployment;
}

/**
 * 배포 메트릭 변환
 * @param metricsFromRedis 저장소 배포 메트릭
 * @returns 변환된 배포 메트릭
 */
export function toRestDeploymentMetrics(metricsFromRedis: any): DeploymentMetrics {
  if (!metricsFromRedis) {
    return {};
  }

  const restDeploymentMetrics: DeploymentMetrics = {};
  const totalActive: number = 0;
  const labelRegex = /^v\d+$/;

  Object.keys(metricsFromRedis).forEach((metricKey: string) => {
    const parsedKey: string[] = metricKey.split(":");
    const label: string = parsedKey[0];
    const metricType: string = parsedKey[1];
    if (!restDeploymentMetrics[label]) {
      restDeploymentMetrics[label] = labelRegex.test(label)
        ? {
            active: 0,
            downloaded: 0,
            failed: 0,
            installed: 0,
          }
        : {
            active: 0,
          };
    }

    switch (metricType) {
      case redis.ACTIVE:
        restDeploymentMetrics[label].active += metricsFromRedis[metricKey];
        break;
      case redis.DOWNLOADED:
        restDeploymentMetrics[label].downloaded += metricsFromRedis[metricKey];
        break;
      case redis.DEPLOYMENT_SUCCEEDED:
        restDeploymentMetrics[label].installed += metricsFromRedis[metricKey];
        break;
      case redis.DEPLOYMENT_FAILED:
        restDeploymentMetrics[label].failed += metricsFromRedis[metricKey];
        break;
    }
  });

  return restDeploymentMetrics;
}

/**
 * 패키지 변환
 * @param storagePackage 저장소 패키지
 * @returns 변환된 패키지
 */
export function toRestPackage(storagePackage: Storage.Package): Package {
  const copy: Package = nodeDeepCopy.deepCopy(storagePackage);

  const cast: Storage.Package = <any>copy;
  delete cast.manifestBlobUrl;

  if (copy.rollout === undefined || copy.rollout === null) copy.rollout = 100;

  return copy;
}

/**
 * 액세스 키 변환
 * @param restAccessKey 액세스 키
 * @returns 변환된 액세스 키
 */
export function toStorageAccessKey(restAccessKey: AccessKey): Storage.AccessKey {
  const storageAccessKey = <Storage.AccessKey>{
    name: restAccessKey.name,
    createdTime: restAccessKey.createdTime,
    createdBy: restAccessKey.createdBy,
    expires: restAccessKey.expires,
    friendlyName: restAccessKey.friendlyName,
    description: restAccessKey.friendlyName,
  };

  return storageAccessKey;
}

/**
 * 애플리케이션 변환
 * @param restApp 애플리케이션
 * @param createdTime 생성 시간
 * @returns 변환된 애플리케이션
 */
export function toStorageApp(restApp: App, createdTime: number): Storage.App {
  const storageApp: Storage.App = {
    createdTime: createdTime,
    name: restApp.name,
    collaborators: toStorageCollaboratorMap(restApp.collaborators),
  };
  return storageApp;
}

/**
 * 팀 멤버 맵 변환
 * @param restCollaboratorMap 애플리케이션 팀 멤버 맵
 * @returns 변환된 팀 멤버 맵
 */
export function toStorageCollaboratorMap(restCollaboratorMap: CollaboratorMap): Storage.CollaboratorMap {
  if (!restCollaboratorMap) return null;

  return <Storage.CollaboratorMap>nodeDeepCopy.deepCopy(restCollaboratorMap);
}

/**
 * 배포 변환
 * @param restDeployment 애플리케이션 배포
 * @param createdTime 생성 시간
 * @returns 변환된 배포
 */
export function toStorageDeployment(restDeployment: Deployment, createdTime: number): Storage.Deployment {
  const storageDeployment = <Storage.Deployment>{
    createdTime: createdTime,
    name: restDeployment.name,
    key: restDeployment.key,
    package: nodeDeepCopy.deepCopy(restDeployment.package),
  };
  return storageDeployment;
}

/**
 * 패키지 변환
 * @param restPackage 애플리케이션 패키지
 * @returns 변환된 패키지
 */
export function toStoragePackage(restPackage: Package): Storage.Package {
  return nodeDeepCopy.deepCopy(restPackage);
}
