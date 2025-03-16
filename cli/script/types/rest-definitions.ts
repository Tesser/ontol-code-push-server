// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

interface AccessKeyBase {
  createdBy?: string;
  /*legacy*/ description?: string;
  /*key*/ friendlyName?: string;
  /*generated key*/ name?: string;
}

/*out*/
export interface AccessKey extends AccessKeyBase {
  /*generated*/ createdTime?: number;
  expires: number;
  /*generated*/ isSession?: boolean;
}

/*in*/
export interface AccessKeyRequest extends AccessKeyBase {
  ttl?: number;
}

/*out*/
export interface DeploymentMetrics {
  [packageLabelOrAppVersion: string]: UpdateMetrics;
}

/**
 * 배포 상태 보고 객체 (Req)
 * - 앱 버전, 클라이언트 고유 ID, 배포 키, 이전 배포 키, 이전 라벨 또는 앱 버전, 라벨, 상태 등의 정보를 포함합니다.
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

/*in*/
export interface DownloadReport {
  clientUniqueId: string;
  deploymentKey: string;
  label: string;
}

/*inout*/
export interface PackageInfo {
  appVersion?: string;
  description?: string;
  isDisabled?: boolean;
  isMandatory?: boolean;
  /*generated*/ label?: string;
  /*generated*/ packageHash?: string;
  rollout?: number;
}

/*out*/
export interface UpdateCheckResponse extends PackageInfo {
  target_binary_range?: string;
  downloadURL?: string;
  isAvailable: boolean;
  packageSize?: number;
  shouldRunBinaryVersion?: boolean;
  updateAppVersion?: boolean;
}

/*out*/
export interface UpdateCheckCacheResponse {
  originalPackage: UpdateCheckResponse;
  rollout?: number;
  rolloutPackage?: UpdateCheckResponse;
}

/**
 * 업데이트 체크 요청 객체 (Req)
 * - 앱 버전, 클라이언트 고유 ID, 배포 키, 패키지 해시, 설명 등의 정보를 포함합니다.
 */
export interface UpdateCheckRequest {
  appVersion: string;
  clientUniqueId?: string;
  deploymentKey: string;
  isCompanion?: boolean;
  label?: string;
  packageHash?: string;
}

/*out*/
export interface UpdateMetrics {
  active: number;
  downloaded?: number;
  failed?: number;
  installed?: number;
}

/*out*/
export interface Account {
  /*key*/ email: string;
  name: string;
  linkedProviders: string[];
}

/*out*/
export interface CollaboratorProperties {
  isCurrentAccount?: boolean;
  permission: string;
}

/*out*/
export interface CollaboratorMap {
  [email: string]: CollaboratorProperties;
}

/*inout*/
export interface App {
  /*generated*/ collaborators?: CollaboratorMap;
  /*key*/ name: string;
  /*generated*/ deployments?: string[];
}

/*in*/
export interface AppCreationRequest extends App {
  manuallyProvisionDeployments?: boolean;
}

/*inout*/
export interface Deployment {
  /*generated key*/ key?: string;
  /*key*/ name: string;
  /*generated*/ package?: Package;
}

/*out*/
export interface BlobInfo {
  size: number;
  url: string;
}

/*out*/
export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

/*inout*/
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
