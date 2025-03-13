// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * 액세스 키 기본 인터페이스
 */
interface AccessKeyBase {
  createdBy?: string;
  /*legacy*/ description?: string;
  /*key*/ friendlyName?: string;
  /*generated key*/ name?: string;
}

/**
 * 액세스 키 인터페이스 (res)
 */
export interface AccessKey extends AccessKeyBase {
  /*generated*/ createdTime?: number;
  expires: number;
  /*generated*/ isSession?: boolean;
}

/**
 * 액세스 키 요청 인터페이스 (req)
 */
export interface AccessKeyRequest extends AccessKeyBase {
  ttl?: number;
}

/**
 * 배포 메트릭 인터페이스 (res)
 */
export interface DeploymentMetrics {
  [packageLabelOrAppVersion: string]: UpdateMetrics;
}

/**
 * 배포 상태 보고서 인터페이스 (req)
 */
export interface DeploymentStatusReport {
  appVersion: string;
  clientUniqueId?: string;
  deploymentKey: string;
  previousDeploymentKey?: string;
  previousLabelOrAppVersion?: string;
  label?: string;
  status?: string;
}

/**
 * 다운로드 보고서 인터페이스 (req)
 */
export interface DownloadReport {
  clientUniqueId: string;
  deploymentKey: string;
  label: string;
}

/**
 * 패키지 정보 인터페이스 (res, req)
 */
export interface PackageInfo {
  appVersion?: string;
  description?: string;
  isDisabled?: boolean;
  isMandatory?: boolean;
  /*generated*/ label?: string;
  /*generated*/ packageHash?: string;
  rollout?: number;
}

/**
 * 업데이트 체크 응답 인터페이스 (res)
 */
export interface UpdateCheckResponse extends PackageInfo {
  target_binary_range?: string;
  downloadURL?: string;
  isAvailable: boolean;
  packageSize?: number;
  shouldRunBinaryVersion?: boolean;
  updateAppVersion?: boolean;
}

/**
 * 업데이트 체크 캐시 응답 인터페이스 (res)
 */
export interface UpdateCheckCacheResponse {
  originalPackage: UpdateCheckResponse;
  rollout?: number;
  rolloutPackage?: UpdateCheckResponse;
}

/**
 * 업데이트 체크 요청 인터페이스 (req)
 */
export interface UpdateCheckRequest {
  appVersion: string;
  clientUniqueId?: string;
  deploymentKey: string;
  isCompanion?: boolean;
  label?: string;
  packageHash?: string;
}

/**
 * 업데이트 메트릭 인터페이스 (res)
 */
export interface UpdateMetrics {
  active: number;
  downloaded?: number;
  failed?: number;
  installed?: number;
}

/**
 * 계정 인터페이스 (res)
 */
export interface Account {
  /*key*/ email: string;
  name: string;
  linkedProviders: string[];
}

/**
 * 협업자 속성 인터페이스 (res)
 */
export interface CollaboratorProperties {
  isCurrentAccount?: boolean;
  permission: string;
}

/**
 * 협업자 맵 인터페이스 (res)
 */
export interface CollaboratorMap {
  [email: string]: CollaboratorProperties;
}

/**
 * 앱 인터페이스 (res, req)
 */
export interface App {
  /*generated*/ collaborators?: CollaboratorMap;
  /*key*/ name: string;
  /*generated*/ deployments?: string[];
}

/**
 * 앱 생성 요청 인터페이스 (req)
 */
export interface AppCreationRequest extends App {
  manuallyProvisionDeployments?: boolean;
}

/**
 * 배포 인터페이스 (res, req)
 */
export interface Deployment {
  /*generated key*/ key?: string;
  /*key*/ name: string;
  /*generated*/ package?: Package;
}

/**
 * 블롭 정보 인터페이스 (res)
 */
export interface BlobInfo {
  size: number;
  url: string;
}

/**
 * 패키지 해시 패키지 정보 맵 인터페이스 (res)
 */
export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

/**
 * 패키지 인터페이스 (res, req)
 */
export interface Package extends PackageInfo {
  /*generated*/ blobUrl: string;
  /*generated*/ diffPackageMap?: PackageHashToBlobInfoMap;
  /*generated*/ originalLabel?: string; // Set on "Promote" and "Rollback"
  /*generated*/ originalDeployment?: string; // Set on "Promote"
  /*generated*/ releasedBy?: string; // Set by commitPackage
  /*generated*/ releaseMethod?: string; // "Upload", "Promote" or "Rollback". Unknown if unspecified
  /*generated*/ size: number;
  /*generated*/ uploadTime: number;
}

export * from "./rest-definitions";
