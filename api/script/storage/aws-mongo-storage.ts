// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as q from "q";
import * as shortid from "shortid";
import * as stream from "stream";
import { MongoDBClient } from "./mongodb-client";
import { CustomS3Client } from "./s3-client";
import * as storage from "./storage";

export class AwsMongoStorage implements storage.Storage {
  private _mongoClient: MongoDBClient;
  private _s3Client: CustomS3Client;
  private _setupPromise: q.Promise<void>;

  constructor(
    mongoUrl?: string,
    awsRegion?: string,
    awsAccessKeyId?: string,
    awsSecretAccessKey?: string,
    cloudFrontDistributionId?: string
  ) {
    shortid.characters("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-");

    this._mongoClient = new MongoDBClient(mongoUrl);
    this._s3Client = new CustomS3Client(awsRegion, awsAccessKeyId, awsSecretAccessKey, cloudFrontDistributionId);

    // 두 클라이언트의 설정이 모두 완료되면 준비 완료
    this._setupPromise = q.all([this._mongoClient.getSetupPromise(), this._s3Client.getSetupPromise()]).then(() => null);
  }

  /**
   * AwsMongoStorage를 다시 초기화합니다.
   * @param mongoUrl MongoDB 연결 문자열
   * @param awsRegion AWS 리전
   * @param awsAccessKeyId AWS 액세스 키 ID
   * @param awsSecretAccessKey AWS 비밀 액세스 키
   * @returns 초기화 재설정 완료 Promise
   */
  public reinitialize(mongoUrl?: string, awsRegion?: string, awsAccessKeyId?: string, awsSecretAccessKey?: string): q.Promise<void> {
    console.log("Re-initializing AWS/MongoDB storage");

    // 기존 연결 종료
    return this._mongoClient.close().then(() => {
      // 새 클라이언트 생성
      this._mongoClient = new MongoDBClient(mongoUrl);
      this._s3Client = new CustomS3Client(awsRegion, awsAccessKeyId, awsSecretAccessKey);

      // 새 설정 프로미스 설정
      this._setupPromise = q.all([this._mongoClient.getSetupPromise(), this._s3Client.getSetupPromise()]).then(() => null);

      return this._setupPromise;
    });
  }

  public checkHealth(): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return q.all([this._mongoClient.checkHealth(), this._s3Client.checkHealth()]);
      })
      .then(() => null);
  }

  /**
   * 계정을 MongoDB에 추가합니다.
   * @param account 계정 객체
   * @returns 계정 ID
   */
  public addAccount(account: storage.Account): q.Promise<string> {
    account = storage.clone(account); // 값 복사
    account.id = shortid.generate();
    account.createdTime = new Date().getTime();

    return this._mongoClient.addAccount(account);
  }

  /**
   * 계정을 MongoDB에서 가져옵니다.
   * @param accountId 계정 ID
   * @returns 계정 객체
   */
  public getAccount(accountId: string): q.Promise<storage.Account> {
    return this._mongoClient.getAccount(accountId);
  }

  /**
   * MongoDB에서 이메일로 계정을 조회하여 가져옵니다.
   * @param email 이메일
   * @returns 계정 객체
   */
  public getAccountByEmail(email: string): q.Promise<storage.Account> {
    return this._mongoClient.getAccountByEmail(email);
  }

  /**
   * MongoDB에서 액세스 키로 계정 ID를 조회하여 가져옵니다.
   * @param accessKey 액세스 키
   * @returns 계정 ID
   */
  public getAccountIdFromAccessKey(accessKey: string): q.Promise<string> {
    return this._mongoClient.getAccountIdFromAccessKey(accessKey);
  }

  /**
   * MongoDB에서 이메일로 계정을 업데이트합니다.
   * @param email 이메일
   * @param updates 업데이트 객체
   */
  public updateAccount(email: string, updates: storage.Account): q.Promise<void> {
    return this._mongoClient.updateAccount(email, updates);
  }

  /**
   * 앱을 MongoDB에 추가합니다.
   * @param accountId 계정 ID
   * @param app 앱 객체
   * @returns 앱 객체
   */
  public addApp(accountId: string, app: storage.App): q.Promise<storage.App> {
    app = storage.clone(app);
    app.id = shortid.generate();
    app.createdTime = new Date().getTime();

    // 협업자 정보 설정
    if (!app.collaborators) {
      app.collaborators = {};
    }

    // 계정 정보 가져오기
    return this.getAccount(accountId)
      .then((account) => {
        // 소유자로 추가
        app.collaborators[account.email] = {
          permission: storage.Permissions.Owner,
          accountId: accountId,
          isCurrentAccount: true,
        };

        return this._mongoClient.addApp(app);
      })
      .then(() => app);
  }

  /**
   * MongoDB에서 계정의 모든 앱을 가져옵니다.
   * @param accountId 계정 ID
   * @returns 앱 배열
   */
  public getApps(accountId: string): q.Promise<storage.App[]> {
    return this._mongoClient.getApps(accountId);
  }

  /**
   * MongoDB에서 특정 앱을 가져옵니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @returns 앱 객체
   */
  public getApp(accountId: string, appId: string): q.Promise<storage.App> {
    return this._mongoClient.getApp(appId).then((app) => {
      // 현재 사용자 표시
      if (app.collaborators) {
        for (const email in app.collaborators) {
          if (app.collaborators[email].accountId === accountId) {
            app.collaborators[email].isCurrentAccount = true;
          }
        }
      }
      return app;
    });
  }

  /**
   * MongoDB에서 앱을 삭제합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   */
  public removeApp(accountId: string, appId: string): q.Promise<void> {
    return this.getApp(accountId, appId).then((app) => {
      // 소유자 확인
      let isOwner = false;
      for (const email in app.collaborators) {
        if (app.collaborators[email].accountId === accountId && app.collaborators[email].permission === storage.Permissions.Owner) {
          isOwner = true;
          break;
        }
      }

      if (!isOwner) {
        throw storage.storageError(storage.ErrorCode.Invalid, "Only the app owner can delete an app.");
      }

      return this._mongoClient.removeApp(appId);
    });
  }

  /**
   * MongoDB에서 앱을 이전합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param email 이메일
   */
  public transferApp(accountId: string, appId: string, email: string): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      let app: storage.App;
      let newOwnerAccount: storage.Account;

      this.getApp(accountId, appId)
        .then((_app) => {
          app = _app;

          // 소유자 확인
          let isOwner = false;
          for (const _email in app.collaborators) {
            if (
              app.collaborators[_email].accountId === accountId &&
              app.collaborators[_email].permission === storage.Permissions.Owner
            ) {
              isOwner = true;
              break;
            }
          }

          if (!isOwner) {
            throw storage.storageError(storage.ErrorCode.Invalid, "Only the app owner can transfer an app.");
          }

          // 새 소유자 계정 가져오기
          return this._mongoClient.getAccountByEmail(email);
        })
        .then((_account) => {
          newOwnerAccount = _account;

          // 협업자 정보 업데이트
          for (const _email in app.collaborators) {
            if (app.collaborators[_email].permission === storage.Permissions.Owner) {
              app.collaborators[_email].permission = storage.Permissions.Collaborator;
            }
          }

          // 새 소유자가 이미 협업자인 경우
          if (app.collaborators[email]) {
            app.collaborators[email].permission = storage.Permissions.Owner;
          } else {
            app.collaborators[email] = {
              permission: storage.Permissions.Owner,
              accountId: newOwnerAccount.id,
            };
          }

          return this._mongoClient.updateApp(appId, { collaborators: app.collaborators });
        })
        .then(() => resolve())
        .catch(reject);
    });
  }

  /**
   * MongoDB에서 앱을 업데이트합니다.
   * @param accountId 계정 ID
   * @param app 앱 객체
   */
  public updateApp(accountId: string, app: storage.App): q.Promise<void> {
    if (!app.id) {
      return q.reject<void>(new Error("No app id"));
    }

    return this.getApp(accountId, app.id).then((existingApp) => {
      // 권한 확인
      let hasPermission = false;
      for (const email in existingApp.collaborators) {
        if (existingApp.collaborators[email].accountId === accountId) {
          hasPermission = true;
          break;
        }
      }

      if (!hasPermission) {
        throw storage.storageError(storage.ErrorCode.Invalid, "No permission to update app");
      }

      const updates: any = {};
      if (app.name) updates.name = app.name;

      return this._mongoClient.updateApp(app.id, updates);
    });
  }

  /**
   * MongoDB에서 협업자를 추가합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param email 이메일
   */
  public addCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      let app: storage.App;
      let collaboratorAccount: storage.Account;

      this.getApp(accountId, appId)
        .then((_app) => {
          app = _app;

          // 소유자 확인
          let isOwner = false;
          for (const _email in app.collaborators) {
            if (
              app.collaborators[_email].accountId === accountId &&
              app.collaborators[_email].permission === storage.Permissions.Owner
            ) {
              isOwner = true;
              break;
            }
          }

          if (!isOwner) {
            throw storage.storageError(storage.ErrorCode.Invalid, "Only the app owner can add collaborators.");
          }

          // 이미 협업자인지 확인
          if (app.collaborators[email]) {
            throw storage.storageError(storage.ErrorCode.AlreadyExists, `${email} is already a collaborator.`);
          }

          // 협업자 계정 가져오기
          return this._mongoClient.getAccountByEmail(email);
        })
        .then((_account) => {
          collaboratorAccount = _account;

          // 협업자 추가
          app.collaborators[email] = {
            permission: storage.Permissions.Collaborator,
            accountId: collaboratorAccount.id,
          };

          return this._mongoClient.updateApp(appId, { collaborators: app.collaborators });
        })
        .then(() => resolve())
        .catch(reject);
    });
  }

  /**
   * MongoDB에서 협업자를 가져옵니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @returns 협업자 맵
   */
  public getCollaborators(accountId: string, appId: string): q.Promise<storage.CollaboratorMap> {
    return this.getApp(accountId, appId).then((app) => app.collaborators || {});
  }

  /**
   * MongoDB에서 협업자를 제거합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param email 이메일
   */
  public removeCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      this.getApp(accountId, appId)
        .then((app) => {
          // 소유자 확인
          let isOwner = false;
          for (const _email in app.collaborators) {
            if (
              app.collaborators[_email].accountId === accountId &&
              app.collaborators[_email].permission === storage.Permissions.Owner
            ) {
              isOwner = true;
              break;
            }
          }

          if (!isOwner) {
            throw storage.storageError(storage.ErrorCode.Invalid, "Only the app owner can remove collaborators.");
          }

          // 소유자는 제거할 수 없음
          if (app.collaborators[email] && app.collaborators[email].permission === storage.Permissions.Owner) {
            throw storage.storageError(storage.ErrorCode.Invalid, "Cannot remove the owner.");
          }

          // 협업자가 존재하는지 확인
          if (!app.collaborators[email]) {
            throw storage.storageError(storage.ErrorCode.NotFound, `${email} is not a collaborator.`);
          }

          // 협업자 제거
          delete app.collaborators[email];

          return this._mongoClient.updateApp(appId, { collaborators: app.collaborators });
        })
        .then(() => resolve())
        .catch(reject);
    });
  }

  /**
   * 배포를 추가합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deployment 배포 객체
   * @returns 배포 ID
   */
  public addDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<string> {
    deployment = storage.clone(deployment);
    deployment.id = shortid.generate();
    deployment.createdTime = new Date().getTime();

    return this.getApp(accountId, appId)
      .then(() => {
        return this._mongoClient.addDeployment(appId, deployment);
      })
      .then(() => deployment.id);
  }

  /**
   * 배포 데이터를 가져옵니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @returns 배포 정보
   */
  public getDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Deployment> {
    return this.getApp(accountId, appId).then(() => {
      return this._mongoClient.getDeployment(appId, deploymentId);
    });
  }

  /**
   * 배포 정보를 가져옵니다.
   * @where MongoDB
   * @param deploymentKey 배포 키
   * @param accountId 계정 ID
   * @param appName 앱 이름
   * @returns 배포 정보
   */
  public getDeploymentInfo(deploymentKey: string, accountId?: string, appName?: string): q.Promise<storage.DeploymentInfo> {
    return this._mongoClient.getDeploymentInfo(deploymentKey, accountId, appName);
  }

  /**
   * 배포 목록을 가져옵니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @returns 배포 배열
   */
  public getDeployments(accountId: string, appId: string): q.Promise<storage.Deployment[]> {
    return this.getApp(accountId, appId).then(() => {
      return this._mongoClient.getDeployments(appId);
    });
  }

  /**
   * 배포를 제거합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   */
  public removeDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return this.getApp(accountId, appId).then(() => {
      return this._mongoClient.removeDeployment(appId, deploymentId);
    });
  }

  /**
   * 배포 정보를 업데이트합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deployment 배포 객체
   */
  public updateDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<void> {
    if (!deployment.id) {
      return q.reject<void>(new Error("No deployment id"));
    }

    return this.getApp(accountId, appId).then(() => {
      const updates: any = {};
      if (deployment.name) updates.name = deployment.name;
      if (deployment.key) updates.key = deployment.key;

      return this._mongoClient.updateDeployment(appId, deployment.id, updates);
    });
  }

  /**
   * 배포에 새 패키지를 커밋합니다.
   * - S3에 새로운 패키지를 추가하고, 패키지 히스토리를 관리합니다.
   * - MongoDB에 저장된 배포 정보를 업데이트합니다.
   * @where S3, MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @param pkg 패키지 객체
   * @returns 패키지 객체
   */
  public commitPackage(accountId: string, appId: string, deploymentId: string, pkg: storage.Package): q.Promise<storage.Package> {
    pkg = storage.clone(pkg);

    return q.Promise<storage.Package>((resolve, reject) => {
      // 배포 정보 및 패키지 히스토리를 조회합니다.
      this.getDeployment(accountId, appId, deploymentId)
        .then((deployment) => {
          return this._s3Client.loadPackageHistory(deploymentId);
        })
        .then((packageHistory) => {
          // 기존 패키지 히스토리 조회 후 새로운 패키지의 라벨을 생성합니다.
          pkg.label = this.getNextLabel(packageHistory);
          pkg.uploadTime = new Date().getTime();

          // 패키지 히스토리에 새로운 패키지를 추가합니다.
          packageHistory.push(pkg);

          // 히스토리 크기를 제한합니다.
          if (packageHistory.length > 50) {
            packageHistory = packageHistory.slice(packageHistory.length - 50);
          }

          // 패키지 히스토리를 S3에 저장합니다.
          return this._s3Client.savePackageHistory(deploymentId, packageHistory).then(() => {
            // 배포 정보를 MongoDB에 업데이트합니다.
            return this._mongoClient.updateDeployment(appId, deploymentId, {
              package: pkg,
            });
          });
        })
        .then(() => resolve(pkg))
        .catch(reject);
    });
  }

  /**
   * 패키지 히스토리를 가져옵니다.
   * - 배포 ID를 알고 있는 경우 사용합니다.
   * - 배포 ID를 통해 배포 정보를 조회하고, 패키지 히스토리를 가져옵니다.
   * @where S3
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @returns 패키지 히스토리
   */
  public getPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Package[]> {
    return this.getDeployment(accountId, appId, deploymentId).then(() => {
      return this._s3Client.loadPackageHistory(deploymentId);
    });
  }

  /**
   * S3에서 패키지 히스토리를 가져옵니다.
   * - 배포 키만 알고 있는 경우 사용합니다.
   * - 배포 키를 통해 배포 ID를 조회하고, 패키지 히스토리를 가져옵니다.
   * @param deploymentKey 배포 키
   * @returns 패키지 히스토리
   */
  public getPackageHistoryFromDeploymentKey(deploymentKey: string): q.Promise<storage.Package[]> {
    return this.getDeploymentInfo(deploymentKey).then((info) => {
      return this._s3Client.loadPackageHistory(info.deploymentId);
    });
  }

  /**
   * 패키지 히스토리를 삭제합니다.
   * @where S3
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   */
  public clearPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return this.getDeployment(accountId, appId, deploymentId)
      .then(() => {
        // 빈 히스토리 저장
        return this._s3Client.savePackageHistory(deploymentId, []);
      })
      .then(() => {
        // 배포에서 현재 패키지 제거
        return this._mongoClient.updateDeployment(appId, deploymentId, {
          package: null,
        });
      });
  }

  /**
   * 패키지 히스토리를 업데이트합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @param history 패키지 히스토리
   */
  public updatePackageHistory(accountId: string, appId: string, deploymentId: string, history: storage.Package[]): q.Promise<void> {
    return this.getDeployment(accountId, appId, deploymentId)
      .then(() => {
        // 히스토리 저장
        return this._s3Client.savePackageHistory(deploymentId, history);
      })
      .then(() => {
        // 배포 업데이트 (마지막 패키지)
        const lastPackage = history.length > 0 ? history[history.length - 1] : null;
        return this._mongoClient.updateDeployment(appId, deploymentId, {
          package: lastPackage,
        });
      });
  }

  /**
   * Blob 파일을 추가합니다.
   * @where S3
   * @param blobId Blob ID
   * @param addstream 추가할 스트림
   * @param streamLength 스트림 길이
   * @returns Blob ID
   */
  public addBlob(blobId: string, addstream: stream.Readable, streamLength: number): q.Promise<string> {
    return this._s3Client.addBlob(blobId, addstream, streamLength);
  }

  /**
   * Blob 파일의 URL을 가져옵니다.
   * @where S3
   * @param blobId Blob ID
   * @returns Blob URL
   */
  public getBlobUrl(blobId: string): q.Promise<string> {
    return this._s3Client.getBlobUrl(blobId);
  }

  /**
   * Blob 파일을 제거합니다.
   * @where S3
   * @param blobId Blob ID
   */
  public removeBlob(blobId: string): q.Promise<void> {
    return this._s3Client.removeBlob(blobId);
  }

  /**
   * 액세스 키를 추가합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param accessKey 액세스 키 객체
   * @returns 액세스 키 ID
   */
  public addAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<string> {
    accessKey = storage.clone(accessKey);
    accessKey.id = shortid.generate();

    return this._mongoClient.addAccessKey(accessKey, accountId).then(() => accessKey.id);
  }

  /**
   * 특정 액세스 키를 가져옵니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param accessKeyId 액세스 키 ID
   * @returns 액세스 키 객체
   */
  public getAccessKey(accountId: string, accessKeyId: string): q.Promise<storage.AccessKey> {
    return this._mongoClient.getAccessKey(accountId, accessKeyId);
  }

  /**
   * 계정의 모든 액세스 키를 가져옵니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @returns 액세스 키 배열
   */
  public getAccessKeys(accountId: string): q.Promise<storage.AccessKey[]> {
    return this._mongoClient.getAccessKeys(accountId);
  }

  /**
   * 액세스 키를 제거합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param accessKeyId 액세스 키 ID
   */
  public removeAccessKey(accountId: string, accessKeyId: string): q.Promise<void> {
    return this._mongoClient.removeAccessKey(accountId, accessKeyId);
  }

  /**
   * 액세스 키를 업데이트합니다.
   * @where MongoDB
   * @param accountId 계정 ID
   * @param accessKey 액세스 키 객체
   */
  public updateAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<void> {
    if (!accessKey.id) {
      return q.reject<void>(new Error("No access key id"));
    }

    const updates: any = {};
    if (accessKey.friendlyName) updates.friendlyName = accessKey.friendlyName;
    if (accessKey.expires) updates.expires = accessKey.expires;

    return this._mongoClient.updateAccessKey(accountId, accessKey.id, updates);
  }

  /**
   * 새 라벨을 생성합니다.
   * @param packageHistory 패키지 히스토리
   * @returns 새 라벨
   */
  private getNextLabel(packageHistory: storage.Package[]): string {
    if (packageHistory.length === 0) {
      return "v1";
    }

    const lastLabel: string = packageHistory[packageHistory.length - 1].label;
    const lastVersion: number = parseInt(lastLabel.substring(1)); // Trim 'v' from the front
    return "v" + (lastVersion + 1);
  }

  /**
   * 모든 데이터를 삭제합니다.
   * 개발/테스트용으로만 사용해야 합니다.
   * @returns 삭제 완료 Promise
   */
  public dropAll(): q.Promise<void> {
    console.warn("dropAll() is not implemented for production use");
    return q(<void>null);
  }
}
