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
  expires?: number;
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
 * @appVersion 앱 버전
 * @description 패키지 설명 (릴리즈 노트, 변경 사항 설명)
 * @isDisabled 패키지 비활성화 여부
 * @isMandatory 필수 업데이트 여부
 * @label 패키지 라벨 (버전 식별자: v1, v2 등)
 * @packageHash 패키지 내용의 해시 값 (무결성 확인 및 식별에 사용)
 * @rollout 패키지 롤아웃 비율 (전체 사용자 중 이 패키지를 받을 사용자의 비율)
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
 * @manuallyProvisionDeployments 자동 배포 환경 생성 여부
 * 
 * `false` 인 경우 기본 배포 환경인 "Production"과 "Staging"이 자동으로 생성됩니다.
 * 
 * `true` 인 경우 사용자가 직접 배포 환경을 생성해야 합니다.
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
 * 
 * 이전 버전에서 현재 버전으로의 차등 업데이트 정보를 포함합니다.
 */
export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

/**
 * 패키지 인터페이스 (res, req)
 * @blobUrl 패키지 콘텐츠를 다운로드할 수 있는 URL
 * @diffPackageMap 패키지 해시를 차등 업데이트 정보에 매핑하는 객체
 * @originalLabel 프로모션이나 롤백 시 원본 패키지의 라벨 (원본 버전 추적에 사용됩니다.)
 * @originalDeployment 프로모션 시 원본 배포 환경 이름 (한 환경에서 다른 환경으로 승격될 때 출처 정보를 유지합니다.)
 * @releasedBy 배포자
 * @releaseMethod 배포 방법 (Upload, Promote, Rollback, Unknown)
 * @size 패키지 크기
 * @uploadTime 패키지 업로드 시간
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
