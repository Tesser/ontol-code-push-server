// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as q from "q";
import * as shortid from "shortid";
import * as stream from "stream";
import * as utils from "../../utils/common";
import * as storage from "../storage";

import {
  AzureNamedKeyCredential,
  CreateDeleteEntityAction,
  GetTableEntityResponse,
  odata,
  TableClient,
  TableEntity,
  TableServiceClient,
  TransactionAction,
} from "@azure/data-tables";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { isPrototypePollutionKey } from "../storage";

/**
 * 애플리케이션, 계정, 배포의 키를 생성합니다.
 * 스토리지 시스템에서 데이터를 계층적으로 관리할 수 있도록 고유한 키를 생성하는 역할을 합니다.
 */
namespace Keys {
  // 키를 구성할 때 값들을 구분하기 위해 사용합니다.
  const DELIMITER = " ";
  // 키의 끝 부분을 특정 값으로 표시하여 마지막 요소(leaf node)임을 나타냅니다.
  const LEAF_MARKER = "*";

  /**
   * 계정의 파티션 키를 생성합니다.
   * @param accountId 계정 ID
   * @returns 계정의 파티션 키
   */
  export function getAccountPartitionKey(accountId: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return "accountId" + DELIMITER + accountId;
  }

  /**
   * 특정 계정의 주소(Pointer) 객체를 반환합니다.
   * @param accountId 계정 ID
   * @returns 계정의 주소
   */
  export function getAccountAddress(accountId: string): Pointer {
    validateParameters(Array.prototype.slice.apply(arguments));
    return <Pointer>{
      partitionKeyPointer: getAccountPartitionKey(accountId),
      rowKeyPointer: getHierarchicalAccountRowKey(accountId),
    };
  }

  /**
   * 앱의 파티션 키를 생성합니다.
   * @param appId 앱 ID
   * @returns 앱의 파티션 키
   */
  export function getAppPartitionKey(appId: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return "appId" + DELIMITER + appId;
  }

  /**
   * 애플리케이션 및 배포 정보를 포함하는 계층적 RowKey를 생성합니다.
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @returns 앱의 RowKey
   */
  export function getHierarchicalAppRowKey(appId?: string, deploymentId?: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return generateHierarchicalAppKey(/*markLeaf=*/ true, appId, deploymentId);
  }

  /**
   * 계정에 대한 계층적 RowKey를 생성합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @returns 계정의 RowKey
   */
  export function getHierarchicalAccountRowKey(accountId: string, appId?: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return generateHierarchicalAccountKey(/*markLeaf=*/ true, accountId, appId);
  }

  /**
   * 앱에 대한 계층적 키를 생성하고, 필요하면 리프(마지막 요소) 키를 표시합니다.
   * @param markLeaf 마지막 요소인지 여부
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @returns 앱의 RowKey
   *
   * @example
   * `markLeaf = true`이면 키의 마지막 요소 앞에 * 표시를 붙여서 최종 노드임을 명확히 표시합니다.
   * 예를 들어, 'appId 123 deploymentId 456' -> 'appId 123 deploymentId* 456'
   */
  export function generateHierarchicalAppKey(markLeaf: boolean, appId: string, deploymentId?: string): string {
    validateParameters(Array.prototype.slice.apply(arguments).slice(1));
    let key = delimit("appId", appId, /*prependDelimiter=*/ false);

    if (typeof deploymentId !== "undefined") {
      key += delimit("deploymentId", deploymentId);
    }

    if (markLeaf) {
      const lastIdDelimiter: number = key.lastIndexOf(DELIMITER);
      key = key.substring(0, lastIdDelimiter) + LEAF_MARKER + key.substring(lastIdDelimiter);
    }

    return key;
  }

  /**
   * 계정에 대한 계층적 키를 생성하고, 필요하면 리프(마지막 요소) 키를 표시합니다.
   * @param markLeaf 마지막 요소인지 여부
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @returns 계정의 RowKey
   */
  export function generateHierarchicalAccountKey(markLeaf: boolean, accountId: string, appId?: string): string {
    validateParameters(Array.prototype.slice.apply(arguments).slice(1));
    let key = delimit("accountId", accountId, /*prependDelimiter=*/ false);

    if (typeof appId !== "undefined") {
      key += delimit("appId", appId);
    }

    if (markLeaf) {
      const lastIdDelimiter: number = key.lastIndexOf(DELIMITER);
      key = key.substring(0, lastIdDelimiter) + LEAF_MARKER + key.substring(lastIdDelimiter);
    }

    return key;
  }

  /**
   * 계정에 대한 액세스 키의 RowKey를 생성합니다.
   * @param accountId 계정 ID
   * @param accessKeyId 액세스 키 ID
   * @returns 계정의 액세스 키의 RowKey
   */
  export function getAccessKeyRowKey(accountId: string, accessKeyId?: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    let key: string = "accountId_" + accountId + "_accessKeyId*_";

    if (accessKeyId !== undefined) {
      key += accessKeyId;
    }

    return key;
  }

  /**
   * 배포 데이터 여부를 확인합니다.
   * @param rowKey 행 키
   * @returns 배포 데이터 여부
   */
  export function isDeployment(rowKey: string): boolean {
    return rowKey.indexOf("deploymentId*") !== -1;
  }

  /**
   * 이메일을 이용해 빠르게 검색할 수 있도록 단축 주소(Shortcut Address)를 생성합니다.
   * - 이메일의 대소문자를 구분하지 않기 위해 소문자로 변환하여 키를 생성합니다.
   * - 하지만 원래 이메일은 그대로 유지합니다.
   * @param email 이메일 주소
   * @returns 이메일 주소 파티션 키
   */
  export function getEmailShortcutAddress(email: string): Pointer {
    validateParameters(Array.prototype.slice.apply(arguments));
    return <Pointer>{
      partitionKeyPointer: "email" + DELIMITER + email.toLowerCase(),
      rowKeyPointer: "",
    };
  }

  /**
   * 배포 키를 이용해 빠르게 검색할 수 있도록 단축 주소(Shortcut Address)를 생성합니다.
   * @param deploymentKey 배포 키
   * @returns 배포 키 파티션 키
   */
  export function getShortcutDeploymentKeyPartitionKey(deploymentKey: string): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return delimit("deploymentKey", deploymentKey, /*prependDelimiter=*/ false);
  }

  /**
   * 배포 키 단축 RowKey를 생성합니다.
   * RowKey가 필요 없는 경우 사용됩니다.
   * @returns 빈 문자열
   */
  export function getShortcutDeploymentKeyRowKey(): string {
    return "";
  }

  /**
   * 액세스 키(Access Key)를 기반으로 단축 파티션 키를 생성합니다.
   * @param accessKeyName 액세스 키 이름
   * @param hash 해시 여부 (보안 강화를 위해 SHA-256 해시 함수를 적용할 수도 있습니다.)
   * @returns 액세스 키 파티션 키
   */
  export function getShortcutAccessKeyPartitionKey(accessKeyName: string, hash: boolean = true): string {
    validateParameters(Array.prototype.slice.apply(arguments));
    return delimit("accessKey", hash ? utils.hashWithSHA256(accessKeyName) : accessKeyName, /*prependDelimiter=*/ false);
  }

  /**
   * - Azure Table Storage에서 사용되는 파라미터들의 유효성을 검사합니다.
   * - 파라미터에 DELIMITER나 LEAF_MARKER와 같은 특수 문자가 포함되어 있는 경우 예외를 발생시킵니다.
   * @param parameters 파라미터들
   */
  function validateParameters(parameters: string[]): void {
    parameters.forEach((parameter: string): void => {
      if (parameter && (parameter.indexOf(DELIMITER) >= 0 || parameter.indexOf(LEAF_MARKER) >= 0)) {
        throw storage.storageError(storage.ErrorCode.Invalid, `The parameter '${parameter}' contained invalid characters.`);
      }
    });
  }

  /**
   * - 필드 이름과 값을 구분자(delimiter)를 사용하여 하나의 문자열로 결합합니다.
   * - 계층적 키를 생성할 때 필드 이름과 값을 일관된 형식으로 결합하기 위해 사용됩니다.
   * @param fieldName 필드 이름
   * @param value 필드 값
   * @param prependDelimiter 구분자 접두사 여부
   * @returns 파티션 키 또는 RowKey
   */
  function delimit(fieldName: string, value: string, prependDelimiter = true): string {
    const prefix = prependDelimiter ? DELIMITER : "";
    return prefix + fieldName + DELIMITER + value;
  }
}

/**
 * Azure Table Storage에서 데이터 항목(엔티티)의 위치를 가리키는 참조 객체
 */
interface Pointer {
  partitionKeyPointer: string;
  rowKeyPointer: string;
}

interface DeploymentKeyPointer {
  appId: string;
  deploymentId: string;
}

interface AccessKeyPointer {
  accountId: string;
  expires: number;
}

/**
 * Azure Storage 서비스와 상호작용하기 위한 구체적인 구현을 제공합니다.
 */
export class AzureStorage implements storage.Storage {
  public static NO_ID_ERROR = "No id set";

  private static HISTORY_BLOB_CONTAINER_NAME = "packagehistoryv1";
  private static MAX_PACKAGE_HISTORY_LENGTH = 50;
  private static TABLE_NAME = "storagev2";

  private _tableClient: TableClient;
  private _blobService: BlobServiceClient;
  private _setupPromise: q.Promise<void>;

  public constructor(accountName?: string, accountKey?: string) {
    shortid.characters("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-");

    this._setupPromise = this.setup(accountName, accountKey);
  }

  public initialize(accountName?: string, accountKey?: string): q.Promise<void> {
    console.log("Re-initializing Azure storage");
    return this.setup(accountName, accountKey);
  }

  public checkHealth(): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      this._setupPromise
        .then(() => {
          const tableCheck: q.Promise<void> = q.Promise<void>((tableResolve, tableReject) => {
            this._tableClient
              .getEntity(/*partitionKey=*/ "health", /*rowKey=*/ "health")
              .then((entity: any) => {
                if ((<any>entity).health !== "health") {
                  tableReject(
                    storage.storageError(storage.ErrorCode.ConnectionFailed, "The Azure Tables service failed the health check")
                  );
                } else {
                  tableResolve();
                }
              })
              .catch(tableReject);
          });

          const acquisitionBlobCheck: q.Promise<void> = this.blobHealthCheck(AzureStorage.TABLE_NAME);
          const historyBlobCheck: q.Promise<void> = this.blobHealthCheck(AzureStorage.HISTORY_BLOB_CONTAINER_NAME);

          return q.all([tableCheck, acquisitionBlobCheck, historyBlobCheck]);
        })
        .then(() => {
          resolve();
        })
        .catch(reject);
    });
  }

  public addAccount(account: storage.Account): q.Promise<string> {
    account = storage.clone(account); // pass by value
    account.id = shortid.generate();

    const hierarchicalAddress: Pointer = Keys.getAccountAddress(account.id);
    const emailShortcutAddress: Pointer = Keys.getEmailShortcutAddress(account.email);

    // Store the actual Account in the email partition, and a Pointer in the other partitions
    const accountPointer: Pointer = Keys.getEmailShortcutAddress(account.email);

    return this._setupPromise
      .then(() => {
        const entity: any = this.wrap(account, emailShortcutAddress.partitionKeyPointer, emailShortcutAddress.rowKeyPointer);
        return this._tableClient.createEntity(entity); // Successfully fails if duplicate email
      })
      .then(() => {
        const entity: any = this.wrap(accountPointer, hierarchicalAddress.partitionKeyPointer, hierarchicalAddress.rowKeyPointer);
        return this._tableClient.createEntity(entity);
      })
      .then(() => {
        return account.id;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getAccount(accountId: string): q.Promise<storage.Account> {
    const address: Pointer = Keys.getAccountAddress(accountId);

    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(address.partitionKeyPointer, address.rowKeyPointer);
      })
      .then((pointer: Pointer) => {
        return this.retrieveByKey(pointer.partitionKeyPointer, pointer.rowKeyPointer);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getAccountByEmail(email: string): q.Promise<storage.Account> {
    const address: Pointer = Keys.getEmailShortcutAddress(email);
    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(address.partitionKeyPointer, address.rowKeyPointer);
      })
      .catch((azureError: any): any => {
        AzureStorage.azureErrorHandler(
          azureError,
          true,
          "ResourceNotFound",
          "The specified e-mail address doesn't represent a registered user"
        );
      });
  }

  public updateAccount(email: string, updateProperties: storage.Account): q.Promise<void> {
    if (!email) throw new Error("No account email");
    const address: Pointer = Keys.getEmailShortcutAddress(email);
    const updates: any = {
      azureAdId: updateProperties.azureAdId,
      gitHubId: updateProperties.gitHubId,
      microsoftId: updateProperties.microsoftId,
    };

    return this._setupPromise
      .then(() => {
        const entity: any = this.wrap(updates, address.partitionKeyPointer, address.rowKeyPointer);
        return this._tableClient.updateEntity(entity);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getAccountIdFromAccessKey(accessKey: string): q.Promise<string> {
    const partitionKey: string = Keys.getShortcutAccessKeyPartitionKey(accessKey);
    const rowKey: string = "";

    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(partitionKey, rowKey);
      })
      .then((accountIdObject: AccessKeyPointer) => {
        if (new Date().getTime() >= accountIdObject.expires) {
          throw storage.storageError(storage.ErrorCode.Expired, "The access key has expired.");
        }

        return accountIdObject.accountId;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public addApp(accountId: string, app: storage.App): q.Promise<storage.App> {
    app = storage.clone(app); // pass by value
    app.id = shortid.generate();

    return this._setupPromise
      .then(() => {
        return this.getAccount(accountId);
      })
      .then((account: storage.Account) => {
        const collabMap: storage.CollaboratorMap = {};
        collabMap[account.email] = { accountId: accountId, permission: storage.Permissions.Owner };

        app.collaborators = collabMap;

        const flatApp: any = AzureStorage.flattenApp(app, /*updateCollaborator*/ true);
        return this.insertByAppHierarchy(flatApp, app.id);
      })
      .then(() => {
        return this.addAppPointer(accountId, app.id);
      })
      .then(() => {
        return app;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getApps(accountId: string): q.Promise<storage.App[]> {
    return this._setupPromise
      .then(() => {
        return this.getCollectionByHierarchy(accountId);
      })
      .then((flatApps: any[]) => {
        const apps: storage.App[] = flatApps.map((flatApp: any) => {
          return AzureStorage.unflattenApp(flatApp, accountId);
        });

        return apps;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  // eslint-disable-next-line no-unused-vars
  public getApp(accountId: string, appId: string, keepCollaboratorIds: boolean = false): q.Promise<storage.App> {
    return this._setupPromise
      .then(() => {
        return this.retrieveByAppHierarchy(appId);
      })
      .then((flatApp: any) => {
        return AzureStorage.unflattenApp(flatApp, accountId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public removeApp(accountId: string, appId: string): q.Promise<void> {
    // remove entries for all collaborators account before removing the app
    return this._setupPromise
      .then(() => {
        return this.removeAllCollaboratorsAppPointers(accountId, appId);
      })
      .then(() => {
        return this.cleanUpByAppHierarchy(appId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public updateApp(accountId: string, app: storage.App): q.Promise<void> {
    const appId: string = app.id;
    if (!appId) throw new Error("No app id");

    return this._setupPromise
      .then(() => {
        return this.updateAppWithPermission(accountId, app, /*updateCollaborator*/ false);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public transferApp(accountId: string, appId: string, email: string): q.Promise<void> {
    let app: storage.App;
    let targetCollaboratorAccountId: string;
    let requestingCollaboratorEmail: string;
    let isTargetAlreadyCollaborator: boolean;

    return this._setupPromise
      .then(() => {
        const getAppPromise: q.Promise<storage.App> = this.getApp(accountId, appId, /*keepCollaboratorIds*/ true);
        const accountPromise: q.Promise<storage.Account> = this.getAccountByEmail(email);
        return q.all<any>([getAppPromise, accountPromise]);
      })
      .spread((appPromiseResult: storage.App, accountPromiseResult: storage.Account) => {
        targetCollaboratorAccountId = accountPromiseResult.id;
        email = accountPromiseResult.email; // Use the original email stored on the account to ensure casing is consistent
        app = appPromiseResult;
        requestingCollaboratorEmail = AzureStorage.getEmailForAccountId(app.collaborators, accountId);

        if (requestingCollaboratorEmail === email) {
          throw storage.storageError(storage.ErrorCode.AlreadyExists, "The given account already owns the app.");
        }

        return this.getApps(targetCollaboratorAccountId);
      })
      .then((appsForCollaborator: storage.App[]) => {
        if (storage.NameResolver.isDuplicate(appsForCollaborator, app.name)) {
          throw storage.storageError(
            storage.ErrorCode.AlreadyExists,
            'Cannot transfer ownership. An app with name "' + app.name + '" already exists for the given collaborator.'
          );
        }

        isTargetAlreadyCollaborator = AzureStorage.isCollaborator(app.collaborators, email);

        // Update the current owner to be a collaborator
        AzureStorage.setCollaboratorPermission(app.collaborators, requestingCollaboratorEmail, storage.Permissions.Collaborator);

        // set target collaborator as an owner.
        if (isTargetAlreadyCollaborator) {
          AzureStorage.setCollaboratorPermission(app.collaborators, email, storage.Permissions.Owner);
        } else {
          const targetOwnerProperties: storage.CollaboratorProperties = {
            accountId: targetCollaboratorAccountId,
            permission: storage.Permissions.Owner,
          };
          AzureStorage.addToCollaborators(app.collaborators, email, targetOwnerProperties);
        }

        return this.updateAppWithPermission(accountId, app, /*updateCollaborator*/ true);
      })
      .then(() => {
        if (!isTargetAlreadyCollaborator) {
          // Added a new collaborator as owner to the app, create a corresponding entry for app in target collaborator's account.
          return this.addAppPointer(targetCollaboratorAccountId, app.id);
        }
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public addCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        const getAppPromise: q.Promise<storage.App> = this.getApp(accountId, appId, /*keepCollaboratorIds*/ true);
        const accountPromise: q.Promise<storage.Account> = this.getAccountByEmail(email);
        return q.all<any>([getAppPromise, accountPromise]);
      })
      .spread((app: storage.App, account: storage.Account) => {
        // Use the original email stored on the account to ensure casing is consistent
        email = account.email;
        return this.addCollaboratorWithPermissions(accountId, app, email, {
          accountId: account.id,
          permission: storage.Permissions.Collaborator,
        });
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getCollaborators(accountId: string, appId: string): q.Promise<storage.CollaboratorMap> {
    return this._setupPromise
      .then(() => {
        return this.getApp(accountId, appId, /*keepCollaboratorIds*/ false);
      })
      .then((app: storage.App) => {
        return q<storage.CollaboratorMap>(app.collaborators);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public removeCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return this.getApp(accountId, appId, /*keepCollaboratorIds*/ true);
      })
      .then((app: storage.App) => {
        const removedCollabProperties: storage.CollaboratorProperties = app.collaborators[email];

        if (!removedCollabProperties) {
          throw storage.storageError(storage.ErrorCode.NotFound, "The given email is not a collaborator for this app.");
        }

        if (!AzureStorage.isOwner(app.collaborators, email)) {
          delete app.collaborators[email];
        } else {
          throw storage.storageError(storage.ErrorCode.AlreadyExists, "Cannot remove the owner of the app from collaborator list.");
        }

        return this.updateAppWithPermission(accountId, app, /*updateCollaborator*/ true).then(() => {
          return this.removeAppPointer(removedCollabProperties.accountId, app.id);
        });
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public addDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<string> {
    let deploymentId: string;
    return this._setupPromise
      .then(() => {
        const flatDeployment: any = AzureStorage.flattenDeployment(deployment);
        flatDeployment.id = shortid.generate();

        return this.insertByAppHierarchy(flatDeployment, appId, flatDeployment.id);
      })
      .then((returnedId: string) => {
        deploymentId = returnedId;
        return this.uploadToHistoryBlob(deploymentId, JSON.stringify([]));
      })
      .then(() => {
        const shortcutPartitionKey: string = Keys.getShortcutDeploymentKeyPartitionKey(deployment.key);
        const shortcutRowKey: string = Keys.getShortcutDeploymentKeyRowKey();
        const pointer: DeploymentKeyPointer = {
          appId: appId,
          deploymentId: deploymentId,
        };

        const entity: any = this.wrap(pointer, shortcutPartitionKey, shortcutRowKey);
        return this._tableClient.createEntity(entity);
      })
      .then(() => {
        return deploymentId;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getDeploymentInfo(deploymentKey: string): q.Promise<storage.DeploymentInfo> {
    const partitionKey: string = Keys.getShortcutDeploymentKeyPartitionKey(deploymentKey);
    const rowKey: string = Keys.getShortcutDeploymentKeyRowKey();

    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(partitionKey, rowKey);
      })
      .then((pointer: DeploymentKeyPointer): storage.DeploymentInfo => {
        if (!pointer) {
          return null;
        }

        return { appId: pointer.appId, deploymentId: pointer.deploymentId };
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getPackageHistoryFromDeploymentKey(deploymentKey: string): q.Promise<storage.Package[]> {
    const pointerPartitionKey: string = Keys.getShortcutDeploymentKeyPartitionKey(deploymentKey);
    const pointerRowKey: string = Keys.getShortcutDeploymentKeyRowKey();

    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(pointerPartitionKey, pointerRowKey);
      })
      .then((pointer: DeploymentKeyPointer) => {
        if (!pointer) return null;

        return this.getPackageHistoryFromBlob(pointer.deploymentId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Deployment> {
    return this._setupPromise
      .then(() => {
        return this.retrieveByAppHierarchy(appId, deploymentId);
      })
      .then((flatDeployment: any) => {
        return AzureStorage.unflattenDeployment(flatDeployment);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getDeployments(accountId: string, appId: string): q.Promise<storage.Deployment[]> {
    return this._setupPromise
      .then(() => {
        return this.getCollectionByHierarchy(accountId, appId);
      })
      .then((flatDeployments: any[]) => {
        const deployments: storage.Deployment[] = [];
        flatDeployments.forEach((flatDeployment: any) => {
          deployments.push(AzureStorage.unflattenDeployment(flatDeployment));
        });

        return deployments;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public removeDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return this.cleanUpByAppHierarchy(appId, deploymentId);
      })
      .then(() => {
        return this.deleteHistoryBlob(deploymentId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public updateDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<void> {
    const deploymentId: string = deployment.id;
    if (!deploymentId) throw new Error("No deployment id");

    return this._setupPromise
      .then(() => {
        const flatDeployment: any = AzureStorage.flattenDeployment(deployment);
        return this.mergeByAppHierarchy(flatDeployment, appId, deploymentId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public commitPackage(
    accountId: string,
    appId: string,
    deploymentId: string,
    appPackage: storage.Package
  ): q.Promise<storage.Package> {
    if (!deploymentId) throw new Error("No deployment id");
    if (!appPackage) throw new Error("No package specified");

    appPackage = storage.clone(appPackage); // pass by value

    let packageHistory: storage.Package[];
    return this._setupPromise
      .then(() => {
        return this.getPackageHistoryFromBlob(deploymentId);
      })
      .then((history: storage.Package[]) => {
        packageHistory = history;
        appPackage.label = this.getNextLabel(packageHistory);
        return this.getAccount(accountId);
      })
      .then((account: storage.Account) => {
        appPackage.releasedBy = account.email;

        // Remove the rollout value for the last package.
        const lastPackage: storage.Package =
          packageHistory && packageHistory.length ? packageHistory[packageHistory.length - 1] : null;
        if (lastPackage) {
          lastPackage.rollout = null;
        }

        packageHistory.push(appPackage);

        if (packageHistory.length > AzureStorage.MAX_PACKAGE_HISTORY_LENGTH) {
          packageHistory.splice(0, packageHistory.length - AzureStorage.MAX_PACKAGE_HISTORY_LENGTH);
        }

        const flatPackage: any = { id: deploymentId, package: JSON.stringify(appPackage) };
        return this.mergeByAppHierarchy(flatPackage, appId, deploymentId);
      })
      .then(() => {
        return this.uploadToHistoryBlob(deploymentId, JSON.stringify(packageHistory));
      })
      .then((): storage.Package => {
        return appPackage;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public clearPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return this.retrieveByAppHierarchy(appId, deploymentId);
      })
      .then((flatDeployment: any) => {
        delete flatDeployment.package;
        return this.updateByAppHierarchy(flatDeployment, appId, deploymentId);
      })
      .then(() => {
        return this.uploadToHistoryBlob(deploymentId, JSON.stringify([]));
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Package[]> {
    return this._setupPromise
      .then(() => {
        return this.getPackageHistoryFromBlob(deploymentId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public updatePackageHistory(accountId: string, appId: string, deploymentId: string, history: storage.Package[]): q.Promise<void> {
    // If history is null or empty array we do not update the package history, use clearPackageHistory for that.
    if (!history || !history.length) {
      throw storage.storageError(storage.ErrorCode.Invalid, "Cannot clear package history from an update operation");
    }

    return this._setupPromise
      .then(() => {
        const flatDeployment: any = { id: deploymentId, package: JSON.stringify(history[history.length - 1]) };
        return this.mergeByAppHierarchy(flatDeployment, appId, deploymentId);
      })
      .then(() => {
        return this.uploadToHistoryBlob(deploymentId, JSON.stringify(history));
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  // eslint-disable-next-line no-unused-vars
  public addBlob(blobId: string, stream: stream.Readable, streamLength: number): q.Promise<string> {
    return this._setupPromise
      .then(() => {
        return utils.streamToBuffer(stream);
      })
      .then((buffer) => {
        return this._blobService.getContainerClient(AzureStorage.TABLE_NAME).uploadBlockBlob(blobId, buffer, buffer.byteLength);
      })
      .then(() => {
        return blobId;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getBlobUrl(blobId: string): q.Promise<string> {
    return this._setupPromise
      .then(() => {
        return this._blobService.getContainerClient(AzureStorage.TABLE_NAME).getBlobClient(blobId).url;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public removeBlob(blobId: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return this._blobService.getContainerClient(AzureStorage.TABLE_NAME).deleteBlob(blobId);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public addAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<string> {
    accessKey = storage.clone(accessKey); // pass by value
    accessKey.id = shortid.generate();

    return this._setupPromise
      .then(() => {
        const partitionKey: string = Keys.getShortcutAccessKeyPartitionKey(accessKey.name);
        const rowKey: string = "";
        const accessKeyPointer: AccessKeyPointer = { accountId, expires: accessKey.expires };
        const accessKeyPointerEntity: any = this.wrap(accessKeyPointer, partitionKey, rowKey);
        return this._tableClient.createEntity(accessKeyPointerEntity);
      })
      .then(() => {
        return this.insertAccessKey(accessKey, accountId);
      })
      .then((): string => {
        return accessKey.id;
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getAccessKey(accountId: string, accessKeyId: string): q.Promise<storage.AccessKey> {
    const partitionKey: string = Keys.getAccountPartitionKey(accountId);
    const rowKey: string = Keys.getAccessKeyRowKey(accountId, accessKeyId);
    return this._setupPromise
      .then(() => {
        return this.retrieveByKey(partitionKey, rowKey);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public getAccessKeys(accountId: string): q.Promise<storage.AccessKey[]> {
    const deferred = q.defer<storage.AccessKey[]>();

    const partitionKey: string = Keys.getAccountPartitionKey(accountId);
    const rowKey: string = Keys.getHierarchicalAccountRowKey(accountId);
    const searchKey: string = Keys.getAccessKeyRowKey(accountId);

    // Fetch both the parent account (for error-checking purposes) and the access tokens
    const query = `PartitionKey eq '${partitionKey}' and (RowKey eq '${rowKey}' or (RowKey gt '${searchKey}' and RowKey lt '${searchKey}~'))`;
    const options = { queryOptions: { filter: query } };

    this._setupPromise.then(() => {
      this._tableClient
        .listEntities(options)
        .byPage()
        .next()
        .then((response) => {
          const entities: TableEntity[] = response.value;
          if (entities.length === 0) {
            // Reject as 'not found' if we can't even find the parent entity
            throw storage.storageError(storage.ErrorCode.NotFound);
          }

          const objects: storage.AccessKey[] = [];

          entities.forEach((entity: any) => {
            // Don't include the account
            if (entity.rowKey !== rowKey) {
              objects.push(this.unwrap(entity));
            }
          });

          deferred.resolve(objects);
        })
        .catch((error: any) => {
          deferred.reject(error);
        });
    });

    return deferred.promise;
  }

  public removeAccessKey(accountId: string, accessKeyId: string): q.Promise<void> {
    return this._setupPromise
      .then(() => {
        return this.getAccessKey(accountId, accessKeyId);
      })
      .then((accessKey) => {
        const partitionKey: string = Keys.getAccountPartitionKey(accountId);
        const rowKey: string = Keys.getAccessKeyRowKey(accountId, accessKeyId);
        const shortcutAccessKeyPartitionKey: string = Keys.getShortcutAccessKeyPartitionKey(accessKey.name, false);

        return q.all<any>([
          this._tableClient.deleteEntity(partitionKey, rowKey),
          this._tableClient.deleteEntity(shortcutAccessKeyPartitionKey, ""),
        ]);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  public updateAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<void> {
    if (!accessKey) {
      throw new Error("No access key");
    }

    if (!accessKey.id) {
      throw new Error("No access key id");
    }

    const partitionKey: string = Keys.getAccountPartitionKey(accountId);
    const rowKey: string = Keys.getAccessKeyRowKey(accountId, accessKey.id);

    return this._setupPromise
      .then(() => {
        const entity: any = this.wrap(accessKey, partitionKey, rowKey);
        return this._tableClient.updateEntity(entity);
      })
      .then(() => {
        const newAccessKeyPointer: AccessKeyPointer = {
          accountId,
          expires: accessKey.expires,
        };

        const accessKeyPointerEntity: any = this.wrap(
          newAccessKeyPointer,
          Keys.getShortcutAccessKeyPartitionKey(accessKey.name, false),
          ""
        );
        return this._tableClient.updateEntity(accessKeyPointerEntity);
      })
      .catch(AzureStorage.azureErrorHandler);
  }

  // No-op for safety, so that we don't drop the wrong db, pending a cleaner solution for removing test data.
  public dropAll(): q.Promise<void> {
    return q(<void>null);
  }

  /**
   * Azure Storage 서비스(테이블 및 Blob 스토리지)를 초기화합니다.
   * @param accountName 계정 이름
   * @param accountKey 계정 키
   * @returns 설정 완료 프로미스
   */
  private setup(accountName?: string, accountKey?: string): q.Promise<void> {
    let tableServiceClient: TableServiceClient;
    let tableClient: TableClient;
    let blobServiceClient: BlobServiceClient;

    // 로컬 개발 환경에서는 로컬 에뮬레이터(azurite)를 사용합니다.
    if (process.env.EMULATED) {
      const devConnectionString = "UseDevelopmentStorage=true";

      tableServiceClient = TableServiceClient.fromConnectionString(devConnectionString);
      tableClient = TableClient.fromConnectionString(devConnectionString, AzureStorage.TABLE_NAME);
      blobServiceClient = BlobServiceClient.fromConnectionString(devConnectionString);
    } else {
      if ((!accountName && !process.env.AZURE_STORAGE_ACCOUNT) || (!accountKey && !process.env.AZURE_STORAGE_ACCESS_KEY)) {
        throw new Error("Azure credentials not set");
      }

      const _accountName = accountName ?? process.env.AZURE_STORAGE_ACCOUNT;
      const _accountKey = accountKey ?? process.env.AZURE_STORAGE_ACCESS_KEY;

      const tableStorageCredential = new AzureNamedKeyCredential(_accountName, _accountKey);
      const blobStorageCredential = new StorageSharedKeyCredential(_accountName, _accountKey);

      const tableServiceUrl = `https://${_accountName}.table.core.windows.net`;
      const blobServiceUrl = `https://${_accountName}.blob.core.windows.net`;

      tableServiceClient = new TableServiceClient(tableServiceUrl, tableStorageCredential, {
        retryOptions: {
          maxRetries: 3,
          maxRetryDelayInMs: 2000,
          retryDelayInMs: 500,
        },
      });
      tableClient = new TableClient(tableServiceUrl, AzureStorage.TABLE_NAME, tableStorageCredential);
      blobServiceClient = new BlobServiceClient(blobServiceUrl, blobStorageCredential, {
        retryOptions: {
          maxTries: 4,
          maxRetryDelayInMs: 2000,
          retryDelayInMs: 500,
        },
      });
    }

    const tableHealthEntity: any = this.wrap({ health: "health" }, /*partitionKey=*/ "health", /*rowKey=*/ "health");

    // 테이블 및 Blob 스토리지(일반 데이터용, 히스토리 데이터용)를 생성합니다.
    return q
      .all([
        tableServiceClient.createTable(AzureStorage.TABLE_NAME),
        blobServiceClient.createContainer(AzureStorage.TABLE_NAME, { access: "blob" }),
        blobServiceClient.createContainer(AzureStorage.HISTORY_BLOB_CONTAINER_NAME),
      ])
      .then(() => {
        return q.all<any>([
          tableClient.createEntity(tableHealthEntity),
          blobServiceClient.getContainerClient(AzureStorage.TABLE_NAME).uploadBlockBlob("health", "health", "health".length),
          blobServiceClient
            .getContainerClient(AzureStorage.HISTORY_BLOB_CONTAINER_NAME)
            .uploadBlockBlob("health", "health", "health".length),
        ]);
      })
      .then(() => {
        // 모든 작업이 성공적으로 완료된 후에만 값을 할당해야 합니다. 그렇지 않으면 진행 중인 Promise 체인이 초기화된 서비스를 사용하게 될 수 있습니다.
        this._tableClient = tableClient;
        this._blobService = blobServiceClient;
      })
      .catch((error) => {
        if (error.code === "ContainerAlreadyExists") {
          this._tableClient = tableClient;
          this._blobService = blobServiceClient;
        } else {
          throw error;
        }
      });
  }

  private blobHealthCheck(container: string): q.Promise<void> {
    const deferred = q.defer<void>();

    this._blobService
      .getContainerClient(container)
      .getBlobClient("health")
      .downloadToBuffer()
      .then((blobContents: Buffer) => {
        if (blobContents.toString() !== "health") {
          deferred.reject(
            storage.storageError(
              storage.ErrorCode.ConnectionFailed,
              "The Azure Blobs service failed the health check for " + container
            )
          );
        } else {
          deferred.resolve();
        }
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private getPackageHistoryFromBlob(blobId: string): q.Promise<storage.Package[]> {
    const deferred = q.defer<storage.Package[]>();

    this._blobService
      .getContainerClient(AzureStorage.HISTORY_BLOB_CONTAINER_NAME)
      .getBlobClient(blobId)
      .downloadToBuffer()
      .then((blobContents: Buffer) => {
        const parsedContents = JSON.parse(blobContents.toString());
        deferred.resolve(parsedContents);
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private uploadToHistoryBlob(blobId: string, content: string): q.Promise<void> {
    const deferred = q.defer<void>();

    this._blobService
      .getContainerClient(AzureStorage.HISTORY_BLOB_CONTAINER_NAME)
      .uploadBlockBlob(blobId, content, content.length)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private deleteHistoryBlob(blobId: string): q.Promise<void> {
    const deferred = q.defer<void>();

    this._blobService
      .getContainerClient(AzureStorage.HISTORY_BLOB_CONTAINER_NAME)
      .deleteBlob(blobId)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private wrap(jsObject: any, partitionKey: string, rowKey: string): any {
    return {
      partitionKey,
      rowKey,
      ...jsObject,
    };
  }

  private unwrap(entity: any, includeKey?: boolean): any {
    const { partitionKey, rowKey, createdTime, ...rest } = entity;

    let unwrapped = includeKey ? { partitionKey, rowKey, ...rest } : rest;

    if (typeof createdTime === "bigint") {
      unwrapped = { ...unwrapped, createdTime: Number(createdTime) };
    }

    return unwrapped;
  }

  private addCollaboratorWithPermissions(
    accountId: string,
    app: storage.App,
    email: string,
    collabProperties: storage.CollaboratorProperties
  ): q.Promise<void> {
    if (app && app.collaborators && !app.collaborators[email]) {
      app.collaborators[email] = collabProperties;
      return this.updateAppWithPermission(accountId, app, /*updateCollaborator*/ true).then(() => {
        return this.addAppPointer(collabProperties.accountId, app.id);
      });
    } else {
      throw storage.storageError(storage.ErrorCode.AlreadyExists, "The given account is already a collaborator for this app.");
    }
  }

  private addAppPointer(accountId: string, appId: string): q.Promise<void> {
    const deferred = q.defer<void>();

    const appPartitionKey: string = Keys.getAppPartitionKey(appId);
    const appRowKey: string = Keys.getHierarchicalAppRowKey(appId);
    const pointer: Pointer = { partitionKeyPointer: appPartitionKey, rowKeyPointer: appRowKey };

    const accountPartitionKey: string = Keys.getAccountPartitionKey(accountId);
    const accountRowKey: string = Keys.getHierarchicalAccountRowKey(accountId, appId);

    const entity: any = this.wrap(pointer, accountPartitionKey, accountRowKey);
    this._tableClient
      .createEntity(entity)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private removeAppPointer(accountId: string, appId: string): q.Promise<void> {
    const deferred = q.defer<void>();

    const accountPartitionKey: string = Keys.getAccountPartitionKey(accountId);
    const accountRowKey: string = Keys.getHierarchicalAccountRowKey(accountId, appId);

    this._tableClient
      .deleteEntity(accountPartitionKey, accountRowKey)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private removeAllCollaboratorsAppPointers(accountId: string, appId: string): q.Promise<void> {
    return this.getApp(accountId, appId, /*keepCollaboratorIds*/ true)
      .then((app: storage.App) => {
        const collaboratorMap: storage.CollaboratorMap = app.collaborators;
        // const requesterEmail: string = AzureStorage.getEmailForAccountId(collaboratorMap, accountId);

        const removalPromises: q.Promise<void>[] = [];

        Object.keys(collaboratorMap).forEach((key: string) => {
          const collabProperties: storage.CollaboratorProperties = collaboratorMap[key];
          removalPromises.push(this.removeAppPointer(collabProperties.accountId, app.id));
        });

        return q.allSettled(removalPromises);
      })
      .then(() => {});
  }

  private updateAppWithPermission(accountId: string, app: storage.App, updateCollaborator: boolean = false): q.Promise<void> {
    const appId: string = app.id;
    if (!appId) throw new Error("No app id");

    const flatApp: any = AzureStorage.flattenApp(app, updateCollaborator);
    return this.mergeByAppHierarchy(flatApp, appId);
  }

  private insertByAppHierarchy(jsObject: Object, appId: string, deploymentId?: string): Promise<string> {
    const leafId: string = arguments[arguments.length - 1];
    const appPartitionKey: string = Keys.getAppPartitionKey(appId);

    const args = Array.prototype.slice.call(arguments);
    args.shift(); // Remove 'jsObject' argument
    args.pop(); // Remove the leaf id

    // Check for existence of the parent before inserting
    let fetchParentPromise: Promise<GetTableEntityResponse<any>> = Promise.resolve(null);
    if (args.length > 0) {
      const parentRowKey: string = Keys.getHierarchicalAppRowKey.apply(null, args);
      fetchParentPromise = this._tableClient.getEntity(appPartitionKey, parentRowKey);
    }

    return fetchParentPromise
      .then(() => {
        // We need Pointer object to create partitionKeyPointer and rowKeyPointer fields in our table
        const appRowKey: string = Keys.getHierarchicalAppRowKey(appId, deploymentId);
        const pointer: Pointer = { partitionKeyPointer: appPartitionKey, rowKeyPointer: appRowKey };
        const entity: any = this.wrap(jsObject, pointer.partitionKeyPointer, pointer.rowKeyPointer);
        return this._tableClient.createEntity(entity);
      })
      .then(() => {
        return leafId;
      });
  }

  private insertAccessKey(accessKey: storage.AccessKey, accountId: string): q.Promise<string> {
    accessKey = storage.clone(accessKey);
    accessKey.name = utils.hashWithSHA256(accessKey.name);

    const deferred = q.defer<string>();

    const partitionKey: string = Keys.getAccountPartitionKey(accountId);
    const rowKey: string = Keys.getAccessKeyRowKey(accountId, accessKey.id);

    const entity: any = this.wrap(accessKey, partitionKey, rowKey);

    this._tableClient
      .createEntity(entity)
      .then(() => {
        deferred.resolve(accessKey.id);
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private retrieveByKey(partitionKey: string, rowKey: string): any {
    return this._tableClient.getEntity(partitionKey, rowKey).then((entity: any) => {
      return this.unwrap(entity);
    });
  }

  private retrieveByAppHierarchy(appId: string, deploymentId?: string): q.Promise<any> {
    const partitionKey: string = Keys.getAppPartitionKey(appId);
    const rowKey: string = Keys.getHierarchicalAppRowKey(appId, deploymentId);
    return this.retrieveByKey(partitionKey, rowKey);
  }

  private async getLeafEntities(query: string, childrenSearchKey: string): Promise<any[]> {
    const finalEntries: any[] = [];
    const promises: Promise<any[]>[] = [];

    for await (const entity of this._tableClient.listEntities<TableEntity>({
      queryOptions: { filter: query },
    })) {
      if (entity.partitionKeyPointer && entity.partitionKeyPointer !== "" && entity.rowKeyPointer && entity.rowKeyPointer !== "") {
        const childQuery = odata`PartitionKey eq ${entity.partitionKeyPointer} and (RowKey eq ${
          entity.rowKeyPointer
        } or (RowKey gt ${childrenSearchKey} and RowKey lt ${childrenSearchKey + "~"}))`;

        promises.push(this.getLeafEntities(childQuery, childrenSearchKey));
      } else {
        finalEntries.push(entity);
      }
    }

    if (promises.length > 0) {
      const results = await Promise.all(promises);
      results.forEach((value: TableEntity[]) => {
        if (value.length > 0) {
          finalEntries.push(...value);
        }
      });

      return finalEntries;
    } else {
      return finalEntries;
    }
  }

  private async getCollectionByHierarchy(accountId: string, appId?: string, deploymentId?: string): Promise<any[]> {
    let partitionKey: string;
    let rowKey: string;
    let childrenSearchKey: string;

    // Construct a search key that fetches only the direct children at the given hierarchical location
    const searchKeyArgs: any[] = Array.prototype.slice.call(arguments);
    searchKeyArgs.unshift(/*markLeaf=*/ true);
    searchKeyArgs.push(/*leafId=*/ "");

    if (appId) {
      searchKeyArgs.splice(1, 1); // remove accountId
      partitionKey = Keys.getAppPartitionKey(appId);
      rowKey = Keys.getHierarchicalAppRowKey(appId, deploymentId);
      childrenSearchKey = Keys.generateHierarchicalAppKey.apply(null, searchKeyArgs);
    } else {
      partitionKey = Keys.getAccountPartitionKey(accountId);
      rowKey = Keys.getHierarchicalAccountRowKey(accountId);
      childrenSearchKey = Keys.generateHierarchicalAccountKey.apply(null, searchKeyArgs);
    }

    // Fetch both the parent (for error-checking purposes) and the direct children
    const query = odata`PartitionKey eq ${partitionKey} and (RowKey eq ${rowKey} or (RowKey gt ${childrenSearchKey} and RowKey lt ${
      childrenSearchKey + "~"
    }))`;

    const entities: TableEntity[] = await this.getLeafEntities(query, childrenSearchKey);

    if (entities.length === 0) {
      // Reject as 'not found' if we can't even find the parent entity
      throw new Error("Entity not found");
    }

    const objects: any[] = [];
    entities.forEach((entity: TableEntity) => {
      // Don't include the parent
      if (entity.rowKey !== rowKey) {
        objects.push(this.unwrap(entity));
      }
    });

    return objects;
  }

  private async cleanUpByAppHierarchy(appId: string, deploymentId?: string): Promise<void> {
    const partitionKey: string = Keys.getAppPartitionKey(appId);
    const rowKey: string = Keys.getHierarchicalAppRowKey(appId, deploymentId);
    const descendantsSearchKey: string = Keys.generateHierarchicalAppKey(/*markLeaf=*/ false, appId, deploymentId);

    const tableBatch: TransactionAction[] = [];

    const query = odata`PartitionKey eq '${partitionKey}' and (RowKey eq '${rowKey}' or (RowKey ge '${descendantsSearchKey}' and RowKey lt '${descendantsSearchKey}~'))`;
    for await (const entity of this._tableClient.listEntities<TableEntity>({
      queryOptions: { filter: query },
    })) {
      tableBatch.push(["delete", entity] as CreateDeleteEntityAction);
    }

    if (tableBatch.length > 0) {
      this._tableClient.submitTransaction(tableBatch);
    }
  }

  private getEntityByAppHierarchy(jsObject: Object, appId: string, deploymentId?: string): any {
    const partitionKey: string = Keys.getAppPartitionKey(appId);
    const rowKey: string = Keys.getHierarchicalAppRowKey(appId, deploymentId);
    return this.wrap(jsObject, partitionKey, rowKey);
  }

  private mergeByAppHierarchy(jsObject: Object, appId: string, deploymentId?: string): q.Promise<void> {
    const deferred = q.defer<void>();

    const entity: any = this.getEntityByAppHierarchy(jsObject, appId, deploymentId);
    this._tableClient
      .updateEntity(entity)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private updateByAppHierarchy(jsObject: Object, appId: string, deploymentId?: string): q.Promise<void> {
    const deferred = q.defer<void>();

    const entity: any = this.getEntityByAppHierarchy(jsObject, appId, deploymentId);
    this._tableClient
      .updateEntity(entity)
      .then(() => {
        deferred.resolve();
      })
      .catch((error: any) => {
        deferred.reject(error);
      });

    return deferred.promise;
  }

  private getNextLabel(packageHistory: storage.Package[]): string {
    if (packageHistory.length === 0) {
      return "v1";
    }

    const lastLabel: string = packageHistory[packageHistory.length - 1].label;
    const lastVersion: number = parseInt(lastLabel.substring(1)); // Trim 'v' from the front
    return "v" + (lastVersion + 1);
  }

  private static azureErrorHandler(
    azureError: any,
    overrideMessage: boolean = false,
    overrideCondition?: string,
    overrideValue?: string
  ): any {
    let errorCodeRaw: number | string;
    let errorMessage: string;

    try {
      const parsedMessage = JSON.parse(azureError.message);
      errorCodeRaw = parsedMessage["odata.error"].code;
      errorMessage = parsedMessage["odata.error"].message.value;
    } catch (error) {
      errorCodeRaw = azureError.code;
      errorMessage = azureError.message;
    }

    if (overrideMessage && overrideCondition == errorCodeRaw) {
      errorMessage = overrideValue;
    }

    if (typeof errorCodeRaw === "number") {
      // This is a storage.Error that we previously threw; just re-throw it
      throw azureError;
    }

    let errorCode: storage.ErrorCode;
    switch (errorCodeRaw) {
      case "BlobNotFound":
      case "ResourceNotFound":
      case "TableNotFound":
        errorCode = storage.ErrorCode.NotFound;
        break;
      case "EntityAlreadyExists":
      case "TableAlreadyExists":
        errorCode = storage.ErrorCode.AlreadyExists;
        break;
      case "EntityTooLarge":
      case "PropertyValueTooLarge":
        errorCode = storage.ErrorCode.TooLarge;
        break;
      case "ETIMEDOUT":
      case "ESOCKETTIMEDOUT":
      case "ECONNRESET":
        // This is an error emitted from the 'request' module, which is a
        // dependency of 'azure-storage', and indicates failure after multiple
        // retries.
        errorCode = storage.ErrorCode.ConnectionFailed;
        break;
      default:
        errorCode = storage.ErrorCode.Other;
        break;
    }

    throw storage.storageError(errorCode, errorMessage);
  }

  private static deleteIsCurrentAccountProperty(map: storage.CollaboratorMap): void {
    if (map) {
      Object.keys(map).forEach((key: string) => {
        delete (<storage.CollaboratorProperties>map[key]).isCurrentAccount;
      });
    }
  }

  private static flattenApp(app: storage.App, updateCollaborator: boolean = false): any {
    if (!app) {
      return app;
    }

    const flatApp: any = {};
    for (const property in app) {
      if (property === "collaborators" && updateCollaborator) {
        AzureStorage.deleteIsCurrentAccountProperty(app.collaborators);
        flatApp[property] = JSON.stringify((<any>app)[property]);
      } else if (property !== "collaborators") {
        // No-op updates on these properties
        flatApp[property] = (<any>app)[property];
      }
    }

    return flatApp;
  }

  // Note: This does not copy the object before unflattening it
  private static unflattenApp(flatApp: any, currentAccountId: string): storage.App {
    flatApp.collaborators = flatApp.collaborators ? JSON.parse(flatApp.collaborators) : {};

    const currentUserEmail: string = AzureStorage.getEmailForAccountId(flatApp.collaborators, currentAccountId);
    if (currentUserEmail && flatApp.collaborators[currentUserEmail]) {
      flatApp.collaborators[currentUserEmail].isCurrentAccount = true;
    }

    return flatApp;
  }

  private static flattenDeployment(deployment: storage.Deployment): any {
    if (!deployment) {
      return deployment;
    }

    const flatDeployment: any = {};
    for (const property in deployment) {
      if (property !== "package") {
        // No-op updates on these properties
        flatDeployment[property] = (<any>deployment)[property];
      }
    }

    return flatDeployment;
  }

  // Note: This does not copy the object before unflattening it
  private static unflattenDeployment(flatDeployment: any): storage.Deployment {
    delete flatDeployment.packageHistory;
    flatDeployment.package = flatDeployment.package ? JSON.parse(flatDeployment.package) : null;

    return flatDeployment;
  }

  private static isOwner(collaboratorsMap: storage.CollaboratorMap, email: string): boolean {
    return (
      collaboratorsMap &&
      email &&
      collaboratorsMap[email] &&
      (<storage.CollaboratorProperties>collaboratorsMap[email]).permission === storage.Permissions.Owner
    );
  }

  private static isCollaborator(collaboratorsMap: storage.CollaboratorMap, email: string): boolean {
    return (
      collaboratorsMap &&
      email &&
      collaboratorsMap[email] &&
      (<storage.CollaboratorProperties>collaboratorsMap[email]).permission === storage.Permissions.Collaborator
    );
  }

  private static setCollaboratorPermission(collaboratorsMap: storage.CollaboratorMap, email: string, permission: string): void {
    if (collaboratorsMap && email && !isPrototypePollutionKey(email) && collaboratorsMap[email]) {
      (<storage.CollaboratorProperties>collaboratorsMap[email]).permission = permission;
    }
  }

  private static addToCollaborators(
    collaboratorsMap: storage.CollaboratorMap,
    email: string,
    collabProps: storage.CollaboratorProperties
  ): void {
    if (collaboratorsMap && email && !isPrototypePollutionKey(email) && !collaboratorsMap[email]) {
      collaboratorsMap[email] = collabProps;
    }
  }

  private static getEmailForAccountId(collaboratorsMap: storage.CollaboratorMap, accountId: string): string {
    if (collaboratorsMap) {
      for (const email of Object.keys(collaboratorsMap)) {
        if ((<storage.CollaboratorProperties>collaboratorsMap[email]).accountId === accountId) {
          return email;
        }
      }
    }

    return null;
  }
}
