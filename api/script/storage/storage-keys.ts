// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * 스토리지 키 생성 로직을 중앙화하여 관리합니다.
 */
export class StorageKeys {
  // MongoDB 문서 ID 생성
  public static getAccountId(accountId: string): string {
    return `account:${accountId}`;
  }

  public static getAppId(appId: string): string {
    return `app:${appId}`;
  }

  public static getDeploymentId(appId: string, deploymentId: string): string {
    return `deployment:${appId}:${deploymentId}`;
  }

  public static getAccessKeyId(accountId: string, accessKeyId: string): string {
    return `accessKey:${accountId}:${accessKeyId}`;
  }

  public static getAccessKeyPointerId(accessKeyName: string): string {
    return `accessKeyPointer:${accessKeyName}`;
  }

  // S3 객체 키 생성
  public static getPackageBlobId(packageHash: string): string {
    return `package/${packageHash}`;
  }

  public static getPackageHistoryBlobId(deploymentId: string): string {
    return `packageHistory/${deploymentId}`;
  }

  public static getManifestBlobId(packageHash: string): string {
    return `manifest/${packageHash}`;
  }

  public static getDiffPackageBlobId(packageHash: string, targetHash: string): string {
    return `diff/${packageHash}/${targetHash}`;
  }

  public static getHealthCheckKey(): string {
    return "health";
  }
}
