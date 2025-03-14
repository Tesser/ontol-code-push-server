// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as q from "q";
import * as stream from "stream";
import * as error from "../error";

import Promise = q.Promise;

/**
 * 스토리지 관련 에러 코드
 */
export enum ErrorCode {
  ConnectionFailed = 0,
  NotFound = 1,
  AlreadyExists = 2,
  TooLarge = 3,
  Expired = 4,
  Invalid = 5,
  Other = 99,
}

/**
 * 릴리스 방법 정의
 */
export const ReleaseMethod = {
  Upload: "Upload",
  Promote: "Promote",
  Rollback: "Rollback",
} as const;

/**
 * 권한 정의
 */
export const Permissions = {
  Owner: "Owner",
  Collaborator: "Collaborator",
} as const;

/**
 * 스토리지 에러 정의
 */
export interface StorageError extends error.CodePushError {
  code: ErrorCode;
}

/**
 * 앱을 관리하고 배포하고 패키지를 관리하는 계정을 지정합니다.
 */
export interface Account {
  azureAdId?: string;
  /*generated*/ createdTime: number;
  /*const*/ email: string;
  gitHubId?: string;
  /*generated*/ id?: string;
  microsoftId?: string;
  /*const*/ name: string;
}

/**
 * 공동 작업자 속성을 지정합니다.
 */
export interface CollaboratorProperties {
  /*generated*/ accountId?: string;
  /*generated*/ isCurrentAccount?: boolean;
  permission: string;
}

/**
 * 공동 작업자 맵 정의
 */
export interface CollaboratorMap {
  [email: string]: CollaboratorProperties;
}

/**
 * 애플리케이션의 정보를 저장합니다.
 */
export interface App {
  /*generated*/ collaborators?: CollaboratorMap;
  /*generated*/ createdTime: number;
  /*generated*/ id?: string;
  name: string;
}

/**
 * 애플리케이션 배포 정보를 저장합니다.
 * - 배포 자체의 상세 정보
 * - 배포의 이름, 키, 패키지 정보
 * - 패키지 관리 관련 메서드에서 직접 사용됩니다.
 */
export interface Deployment {
  /*generated*/ createdTime: number;
  /*generated*/ id?: string;
  name: string;
  key: string;
  package?: Package;
}

/**
 * 배포 정보 정의
 * - 배포 식별 정보(배포가 속한 앱의 ID와 배포의 고유 ID)만 포함됩니다.
 * - 배포에 대한 간략한 정보만 필요할 때 사용합니다.
 * - 다른 API에서 `deploymentKey`만 가지고 있을 때 실제 `deploymentId`를 찾는 용도로 사용합니다.
 */
export interface DeploymentInfo {
  appId: string;
  deploymentId: string;
}

/**
 * Blob 정보 정의
 */
export interface BlobInfo {
  size: number;
  url: string;
}

/**
 * 패키지 해시와 Blob 정보 맵 정의
 */
export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

/**
 * 배포된 애플리케이션 패키지 정보를 저장합니다.
 */
export interface Package {
  appVersion: string;
  blobUrl: string;
  description: string;
  diffPackageMap?: PackageHashToBlobInfoMap;
  isDisabled: boolean;
  isMandatory: boolean;
  /*generated*/ label?: string;
  manifestBlobUrl: string;
  originalDeployment?: string; // Set on "Promote"
  originalLabel?: string; // Set on "Promote" and "Rollback"
  packageHash: string;
  releasedBy?: string;
  releaseMethod?: string; // "Upload", "Promote" or "Rollback". Unknown if unspecified
  rollout?: number;
  size: number;
  uploadTime: number;
}

/**
 * 액세스 키 정의
 */
export interface AccessKey {
  createdBy: string;
  createdTime: number;
  expires: number;
  /*legacy*/ description?: string;
  friendlyName: string;
  /*generated*/ id?: string;
  /*generated*/ isSession?: boolean;
  name: string;
}

/**
 * Storage API 참고 사항:
 * - 모든 ID는 스토리지 API에서 생성되며, 객체를 생성할 때 해당 필드를 지정하지 않아야 합니다.
 * - 업데이트 메서드는 지정된 속성을 병합하며, 'null' 값은 속성을 제거하고, 'undefined'는 무시됩니다. 따라서 업데이트할 객체의 ID를 반드시 설정해야 합니다.
 * - 스토리지 구현은 최종 ID(leaf ID)뿐만 아니라 전체 ID 체인이 올바른지 확인해야 합니다.
 * - 스토리지 구현은 어떤 메서드에서도 null, undefined, ""(빈 문자열)과 같은 거짓(falsy) 값을 반환해서는 안 되며, 관련된 경우 Storage.Error 객체를 반환하여 프라미스를 거부해야 합니다.
 * - 요소가 없는 컬렉션을 조회할 때는 빈 배열([])을 반환해야 하며, 지정된 ID 체인이 존재하지 않는 경우에는 일반적인 방식대로 Promise를 거부해야 합니다.
 */
export interface Storage {
  // 상태 확인
  checkHealth(): Promise<void>;

  // 계정 추가, 조회, 업데이트
  addAccount(account: Account): Promise<string>;
  getAccount(accountId: string): Promise<Account>;
  getAccountByEmail(email: string): Promise<Account>;
  getAccountIdFromAccessKey(accessKey: string): Promise<string>;
  updateAccount(email: string, updates: Account): Promise<void>;

  // 앱 생성, 조회, 삭제, 이전
  addApp(accountId: string, app: App): Promise<App>;
  getApps(accountId: string): Promise<App[]>;
  getApp(accountId: string, appId: string): Promise<App>;
  removeApp(accountId: string, appId: string): Promise<void>;
  transferApp(accountId: string, appId: string, email: string): Promise<void>;
  updateApp(accountId: string, app: App): Promise<void>;

  // 공동 작업자 추가, 조회, 삭제
  addCollaborator(accountId: string, appId: string, email: string): Promise<void>;
  getCollaborators(accountId: string, appId: string): Promise<CollaboratorMap>;
  removeCollaborator(accountId: string, appId: string, email: string): Promise<void>;

  // 배포 추가, 조회, 삭제, 업데이트
  addDeployment(accountId: string, appId: string, deployment: Deployment): Promise<string>;
  getDeployment(accountId: string, appId: string, deploymentId: string): Promise<Deployment>;
  getDeploymentInfo(deploymentKey: string): Promise<DeploymentInfo>;
  getDeployments(accountId: string, appId: string): Promise<Deployment[]>;
  removeDeployment(accountId: string, appId: string, deploymentId: string): Promise<void>;
  updateDeployment(accountId: string, appId: string, deployment: Deployment): Promise<void>;

  // 패키지 커밋, 이력 조회 및 삭제
  commitPackage(accountId: string, appId: string, deploymentKey: string, appPackage: Package): Promise<Package>;
  clearPackageHistory(accountId: string, appId: string, deploymentId: string): Promise<void>;
  getPackageHistoryFromDeploymentKey(deploymentKey: string): Promise<Package[]>;
  getPackageHistory(accountId: string, appId: string, deploymentId: string): Promise<Package[]>;
  updatePackageHistory(accountId: string, appId: string, deploymentId: string, history: Package[]): Promise<void>;

  // Blob 데이터 저장, 조회, 삭제
  addBlob(blobId: string, addstream: stream.Readable, streamLength: number): Promise<string>;
  getBlobUrl(blobId: string): Promise<string>;
  removeBlob(blobId: string): Promise<void>;

  // 액세스 키 추가, 조회, 삭제, 업데이트
  addAccessKey(accountId: string, accessKey: AccessKey): Promise<string>;
  getAccessKey(accountId: string, accessKeyId: string): Promise<AccessKey>;
  getAccessKeys(accountId: string): Promise<AccessKey[]>;
  removeAccessKey(accountId: string, accessKeyId: string): Promise<void>;
  updateAccessKey(accountId: string, accessKey: AccessKey): Promise<void>;

  // 모든 데이터 삭제
  dropAll(): Promise<void>;
}

/**
 * 객체를 깊은 복사하여 새로운 인스턴스를 생성합니다.
 * @param source 복제할 객체
 * @returns 복제된 객체
 */
export function clone<T>(source: T): T {
  if (!source) {
    return source;
  }

  return JSON.parse(JSON.stringify(source));
}

/**
 * 현재 사용자가 소유한 앱인지 확인합니다.
 * @param app 앱 정보
 * @returns 현재 사용자가 소유한 앱인지 여부
 */
export function isOwnedByCurrentUser(app: App): boolean {
  for (const email in app.collaborators) {
    const collaborator: CollaboratorProperties = app.collaborators[email];
    if (collaborator.isCurrentAccount && collaborator.permission === Permissions.Owner) {
      return true;
    }
  }

  return false;
}

/**
 * 앱의 소유자 이메일을 조회합니다.
 * @param app 앱 정보
 * @returns 소유자 이메일
 */
export function getOwnerEmail(app: App): string {
  for (const email in app.collaborators) {
    if (app.collaborators[email].permission === Permissions.Owner) {
      return email;
    }
  }

  return null;
}

/**
 * Prototype Pollution 공격을 방지하기 위해 특정 키를 차단합니다.
 * @param key 키
 * @returns Prototype Pollution 키 여부
 */
export function isPrototypePollutionKey(key: string): boolean {
  return ["__proto__", "constructor", "prototype"].includes(key);
}

/**
 * 스토리지 관련 에러 객체를 생성합니다.
 * @param errorCode 에러 코드
 * @param message 에러 메시지
 * @returns 스토리지 관련 에러 객체
 */
export function storageError(errorCode: ErrorCode, message?: string): StorageError {
  const storageError = <StorageError>error.codePushError(error.ErrorSource.Storage, message);
  storageError.code = errorCode;
  return storageError;
}

/**
 * name 기반 리졸버
 * - 특정 이름을 기반으로 애플리케이션, 배포, 액세스 키를 찾아 반환하는 역할을 합니다.
 * - 중복된 이름이 있는지 확인하거나, 특정 계정에서 지정된 앱 또는 배포를 찾을 수 있습니다.
 */
export class NameResolver {
  private _storage: Storage;

  constructor(storage: Storage) {
    this._storage = storage;
  }

  /**
   * 앱, 배포, 액세스 키 등의 목록에서 특정 이름이 중복되었는지 확인합니다.
   * 만약 해당 이름을 현재 사용자가 소유한 경우, 중복으로 간주합니다.
   * @param items 아이템 배열
   * @param name 이름
   * @returns 이름 중복 여부
   */
  public static isDuplicate(items: App[], name: string): boolean;
  public static isDuplicate<T extends { name: string }>(items: T[], name: string): boolean;
  // 이름 중복 확인 정의
  public static isDuplicate<T extends { name: string }>(items: T[], name: string): boolean {
    if (!items.length) return false;

    if ((<App>(<any>items[0])).collaborators) {
      // Use 'app' overload
      for (let i = 0; i < items.length; i++) {
        const app = <App>(<any>items[i]);
        if (app.name === name && isOwnedByCurrentUser(app)) return true;
      }

      return false;
    } else {
      // Use general overload
      return !!NameResolver.findByName(items, name);
    }
  }

  /**
   * 특정 이름을 가진 앱, 배포, 액세스 키를 목록에서 찾아 반환합니다.
   * @param items 아이템 배열
   * @param name 이름
   * @returns 찾은 아이템
   */
  public static findByName(items: App[], displayName: string): App;
  public static findByName<T extends { name: string }>(items: T[], name: string): T;
  // 이름 조회 정의
  public static findByName<T extends { name: string }>(items: T[], name: string): T {
    if (!items.length) return null;

    if ((<App>(<any>items[0])).collaborators) {
      // Use 'app' overload
      return <T>(<any>NameResolver.findAppByName(<App[]>(<any>items), name));
    } else {
      // Use general overload
      for (let i = 0; i < items.length; i++) {
        // For access keys, match both the "name" and "friendlyName" fields.
        if (items[i].name === name || name === (<AccessKey>(<any>items[i])).friendlyName) {
          return items[i];
        }
      }

      return null;
    }
  }

  /**
   * 앱인 경우 해당 함수를 사용해 더 정교하게 앱 이름을 조회합니다.
   * @param apps 앱 배열
   * @param displayName 이름
   * @returns 찾은 앱
   */
  private static findAppByName(apps: App[], displayName: string): App {
    let rawName: string;
    let ownerEmail: string;

    const components: string[] = displayName.split(":");
    if (components.length === 1) {
      rawName = components[0];
    } else if (components.length === 2) {
      ownerEmail = components[0];
      rawName = components[1];
    } else {
      return null;
    }

    const candidates: App[] = apps.filter((app: App) => app.name === rawName);
    if (ownerEmail) {
      for (let i = 0; i < candidates.length; i++) {
        const app: App = candidates[i];
        if (app.collaborators[ownerEmail] && app.collaborators[ownerEmail].permission === Permissions.Owner) {
          return app;
        }
      }
    } else {
      // 소유자 이메일이 지정되지 않은 경우:
      // 1. 가능한 경우 유일한 앱 선택
      // 2. 그렇지 않으면 현재 계정이 소유한 앱 선택
      // 3. 그렇지 않으면 쿼리가 모호하고 앱이 선택되지 않음

      if (candidates.length === 1) {
        return candidates[0];
      }

      for (let i = 0; i < candidates.length; i++) {
        if (isOwnedByCurrentUser(candidates[i])) return candidates[i];
      }
    }

    return null;
  }

  /**
   * 에러 메시지를 오버라이드하여 반환합니다.
   * @param code 에러 코드
   * @param message 에러 메시지
   * @returns 에러 오버라이드 함수
   */
  private static errorMessageOverride(code: ErrorCode, message: string): (error: StorageError) => any {
    return (error: StorageError) => {
      if (error.code === code) {
        error.message = message;
      }

      throw error;
    };
  }

  /**
   * 특정 계정의 액세스 키 목록에서 이름을 기반으로 조회합니다.
   * @param accountId 계정 ID
   * @param name 이름
   * @returns 찾은 액세스 키
   */
  public resolveAccessKey(accountId: string, name: string): Promise<AccessKey> {
    return this._storage
      .getAccessKeys(accountId)
      .then((accessKeys: AccessKey[]): AccessKey => {
        const accessKey: AccessKey = NameResolver.findByName(accessKeys, name);
        if (!accessKey) throw storageError(ErrorCode.NotFound);

        return accessKey;
      })
      .catch(NameResolver.errorMessageOverride(ErrorCode.NotFound, `Access key "${name}" does not exist.`));
  }

  /**
   * 특정 계정에서 지정된 앱을 찾습니다.
   * @param accountId 계정 ID
   * @param name 이름
   * @param permission 권한
   * @returns 찾은 앱
   */
  public resolveApp(accountId: string, name: string, permission?: string): Promise<App> {
    return (
      this._storage
        .getApps(accountId)
        .then((apps: App[]): App => {
          const app: App = NameResolver.findByName(apps, name);
          if (!app) throw storageError(ErrorCode.NotFound);
          return app;
        })
        // 존재하지 않으면 "App XXX does not exist." 에러를 반환합니다.
        .catch(NameResolver.errorMessageOverride(ErrorCode.NotFound, `App "${name}" does not exist.`))
    );
  }

  /**
   * 특정 계정에서 지정된 앱의 배포 목록에서 이름을 기반으로 조회합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param name 이름
   * @returns 찾은 배포
   */
  public resolveDeployment(accountId: string, appId: string, name: string): Promise<Deployment> {
    return (
      this._storage
        .getDeployments(accountId, appId)
        .then((deployments: Deployment[]): Deployment => {
          const deployment: Deployment = NameResolver.findByName(deployments, name);
          if (!deployment) throw storageError(ErrorCode.NotFound);

          return deployment;
        })
        // 존재하지 않으면 "Deployment XXX does not exist." 에러를 반환합니다.
        .catch(NameResolver.errorMessageOverride(ErrorCode.NotFound, `Deployment "${name}" does not exist.`))
    );
  }
}
