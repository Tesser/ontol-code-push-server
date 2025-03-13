// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection, Db, MongoClient } from "mongodb";
import * as q from "q";
import * as storage from "./storage";
import { AccessKey, Account, App, Deployment } from "./storage";
import { StorageKeys } from "./storage-keys";

export interface MongoDBConnection {
  // MongoDB 서버에 대한 연결 클라이언트
  client: MongoClient;
  db: Db;
  collections: {
    accounts: Collection<Account>;
    apps: Collection<App>;
    deployments: Collection<Deployment>;
    accessKeys: Collection<AccessKey>;
    accessKeyPointers: Collection;
  };
}

export class MongoDBClient {
  private _connection: MongoDBConnection;
  // setup 호출 결과
  private _setupPromise: q.Promise<void>;

  constructor(mongoUrl?: string) {
    const _mongoUrl = mongoUrl ?? process.env.MONGODB_URI;
    this._setupPromise = this.setup(_mongoUrl);
  }

  /**
   * MongoDB 데이터베이스 연결을 설정합니다.
   * @param mongoUrl MongoDB 연결 URL
   * @returns 설정 완료 Promise
   */
  private setup(mongoUrl: string): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      // 제공된 MongoDB URL을 사용해 MongoDB 서버에 연결을 시도합니다.
      MongoClient.connect(mongoUrl)
        .then((client) => {
          // 연결된 MongoDB 클라이언트를 사용하여 데이터베이스 인스턴스를 생성합니다.
          const db = client.db();
          // 연결된 데이터베이스에서 필요한 컬렉션을 생성합니다.
          this._connection = {
            client,
            db,
            collections: {
              accounts: db.collection("accounts"),
              apps: db.collection("apps"),
              deployments: db.collection("deployments"),
              accessKeys: db.collection("accessKeys"),
              accessKeyPointers: db.collection("accessKeyPointers"),
            },
          };

          // 필요한 인덱스를 생성합니다.
          return q.all([
            this._connection.collections.accounts.createIndex({ email: 1 }, { unique: true }),
            this._connection.collections.apps.createIndex({ "collaborators.email": 1 }),
            this._connection.collections.deployments.createIndex({ key: 1 }, { unique: true }),
            this._connection.collections.accessKeyPointers.createIndex({ name: 1 }, { unique: true }),
          ]);
        })
        .then(() => {
          resolve();
        })
        .catch((error) => {
          console.error("🔴 MongoDB 연결 오류:", error);
          reject(error);
        });
    });
  }

  /**
   * MongoDB 연결 상태를 확인합니다.
   * - DB 초기 설정 완료 후 ping 명령을 실행해 서버 응답을 확인합니다.
   * @returns 완료 Promise
   */
  public checkHealth(): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.db
          .command({ ping: 1 })
          .then(() => resolve())
          .catch((error) =>
            reject(storage.storageError(storage.ErrorCode.ConnectionFailed, "🔴 MongoDB connection failed: " + error.message))
          );
      });
    });
  }

  /**
   * 계정을 데이터베이스에 추가합니다.
   * @param account 추가할 계정 정보
   * @returns 계정 ID
   */
  public addAccount(account: storage.Account): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        this._connection.collections.accounts
          // 계정 정보를 데이터베이스에 추가합니다.
          .insertOne({
            id: StorageKeys.getAccountId(account.id),
            ...account,
            email: account.email.toLowerCase(),
          })
          // 성공 시 계정 ID 반환
          .then(() => resolve(account.id))
          .catch((error) => {
            if (error.code === 11000) {
              // MongoDB 중복 키 에러
              reject(storage.storageError(storage.ErrorCode.AlreadyExists));
            } else {
              console.error("🔴 MongoDB 계정 추가 오류:", error);
              reject(error);
            }
          });
      });
    });
  }

  /**
   * 계정을 조회합니다.
   * @param accountId 조회할 계정 ID
   * @returns 계정 정보
   */
  public getAccount(accountId: string): q.Promise<storage.Account> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Account>((resolve, reject) => {
        this._connection.collections.accounts
          .findOne({ id: accountId })
          .then((account) => {
            if (!account) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              // 내부 식별자를 제거합니다.
              delete account.id;
              resolve(account);
            }
          })
          .catch((error) => {
            reject(error);
          });
      });
    });
  }

  /**
   * 이메일로 계정을 조회합니다.
   * @param email 조회할 이메일
   * @returns 계정 정보
   */
  public getAccountByEmail(email: string): q.Promise<storage.Account> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Account>((resolve, reject) => {
        this._connection.collections.accounts
          .findOne({ email: email.toLowerCase() })
          .then((account) => {
            if (!account) {
              reject(
                storage.storageError(storage.ErrorCode.NotFound, "The specified e-mail address doesn't represent a registered user")
              );
            } else {
              delete account.id;
              resolve(account);
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 계정 정보를 업데이트합니다.
   * @param email 업데이트할 계정의 이메일
   * @param updates 업데이트할 정보
   * @returns 완료 Promise
   */
  public updateAccount(email: string, updates: storage.Account): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.accounts
          .updateOne({ email: email.toLowerCase() }, { $set: updates })
          .then((result) => {
            if (result.matchedCount === 0) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              resolve();
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 앱을 데이터베이스에 추가합니다.
   * @param app 추가할 앱 정보
   * @returns 완료 Promise
   */
  public addApp(app: storage.App): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.apps
          .insertOne({
            id: StorageKeys.getAppId(app.id),
            ...app,
          })
          .then(() => {
            resolve();
          })
          .catch((error) => {
            if (error.code === 11000) {
              reject(storage.storageError(storage.ErrorCode.AlreadyExists));
            } else {
              reject(error);
            }
          });
      });
    });
  }

  /**
   * 앱을 조회합니다.
   * @param appId 조회할 앱 ID
   * @returns 앱 정보
   */
  public getApp(appId: string): q.Promise<storage.App> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.App>((resolve, reject) => {
        this._connection.collections.apps
          .findOne({ id: appId })
          .then((app) => {
            if (!app) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              delete app.id;
              resolve(app);
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 계정 ID로 앱 목록을 조회합니다.
   * @param accountId 조회할 계정 ID
   * @returns 앱 정보 배열
   */
  public getApps(accountId: string): q.Promise<storage.App[]> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.App[]>((resolve, reject) => {
        this._connection.collections.apps
          .find({})
          .toArray()
          .then((apps) => {
            apps.forEach((app) => delete app._id);
            resolve(apps);
          })
          .catch((error) => {
            reject(error);
          });
      });
    });
  }

  /**
   * 앱 정보를 업데이트합니다.
   * @param appId 업데이트할 앱 ID
   * @param updates 업데이트할 정보
   * @returns 완료 Promise
   */
  public updateApp(appId: string, updates: any): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.apps
          .updateOne({ id: StorageKeys.getAppId(appId) }, { $set: updates })
          .then((result) => {
            if (result.matchedCount === 0) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              resolve();
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 앱 정보를 삭제합니다.
   * @param appId 삭제할 앱 ID
   * @returns 완료 Promise
   */
  public removeApp(appId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.apps
          .deleteOne({ id: StorageKeys.getAppId(appId) })
          .then(() => {
            // 관련된 배포 정보도 삭제
            return this._connection.collections.deployments.deleteMany({ appId });
          })
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  /**
   * 배포 데이터를 추가합니다.
   * @param addId 추가할 배포의 계정 ID
   * @param deployment 추가할 배포 정보
   * @returns 완료 Promise
   */
  public addDeployment(addId: string, deployment: storage.Deployment): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.deployments
          .insertOne({
            id: StorageKeys.getDeploymentId(addId, deployment.id),
            ...deployment,
          })
          .then(() => {
            resolve();
          })
          .catch((error) => {
            if (error.code === 11000) {
              reject(storage.storageError(storage.ErrorCode.AlreadyExists));
            } else {
              reject(error);
            }
          });
      });
    });
  }

  /**
   * 배포 데이터를 조회합니다.
   * @param appId 조회할 앱 ID
   * @param deploymentId 조회할 배포 ID
   * @returns 배포 정보
   */
  public getDeployment(appId: string, deploymentId: string): q.Promise<storage.Deployment> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Deployment>((resolve, reject) => {
        this._connection.collections.deployments
          .findOne({
            id: StorageKeys.getDeploymentId(appId, deploymentId),
          })
          .then((deployment) => {
            if (!deployment) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              delete deployment.id;
              resolve(deployment);
            }
          })
          .catch((error) => {
            reject(error);
          });
      });
    });
  }

  /**
   * 배포 정보를 조회합니다.
   * @param deploymentKey 조회할 배포 키
   * @param accountId 조회할 계정 ID
   * @param appName 조회할 앱 이름
   * @returns 배포 정보
   */
  public getDeploymentInfo(deploymentKey: string, accountId?: string, appName?: string): q.Promise<storage.DeploymentInfo> {
    const query: any = {};

    if (appName) {
      query.name = appName;
    }

    if (accountId) {
      query[`collaborators.${accountId}`] = { $exists: true };
    }

    return q.Promise<storage.DeploymentInfo>((resolve, reject) => {
      this._connection.collections.apps
        .findOne(query)
        .then((findByAccountIdAndName) => {
          return this._connection.collections.deployments.findOne({ key: deploymentKey }).then((deployment) => {
            if (!deployment) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              resolve({
                appId: findByAccountIdAndName.id,
                deploymentId: deployment.id,
              });
            }
          });
        })
        .catch(reject);
    });
  }

  /**
   * 앱 ID로 배포 목록을 조회합니다.
   * @param appId 조회할 앱 ID
   * @returns 배포 정보 배열
   */
  public getDeployments(appId: string): q.Promise<storage.Deployment[]> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Deployment[]>((resolve, reject) => {
        this._connection.collections.deployments
          .find({})
          .toArray()
          .then((deployments) => {
            deployments.forEach((deployment) => delete deployment.id);
            resolve(deployments);
          })
          .catch((error) => {
            reject(error);
          });
      });
    });
  }

  /**
   * 배포 정보를 업데이트합니다.
   * @param appId 업데이트할 앱 ID
   * @param deploymentId 업데이트할 배포 ID
   * @param updates 업데이트할 정보
   * @returns 완료 Promise
   */
  public updateDeployment(appId: string, deploymentId: string, updates: any): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.deployments
          .updateOne({ id: StorageKeys.getDeploymentId(appId, deploymentId) }, { $set: updates })
          .then((result) => {
            if (result.matchedCount === 0) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              resolve();
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 배포 정보를 삭제합니다.
   * @param appId 삭제할 앱 ID
   * @param deploymentId 삭제할 배포 ID
   * @returns 완료 Promise
   */
  public removeDeployment(appId: string, deploymentId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.deployments
          .deleteOne({
            id: StorageKeys.getDeploymentId(appId, deploymentId),
          })
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  /**
   * 액세스 키 정보를 추가합니다.
   * @param accessKey 추가할 액세스 키 정보
   * @param accountId 추가할 액세스 키의 계정 ID
   * @returns 완료 Promise
   */
  public addAccessKey(accessKey: storage.AccessKey, accountId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.accessKeys
          .insertOne({
            id: StorageKeys.getAccessKeyId(accountId, accessKey.id),
            ...accessKey,
            createdBy: accountId,
          })
          .then(() => {
            return this._connection.collections.accessKeyPointers.insertOne({
              id: StorageKeys.getAccessKeyPointerId(accessKey.name),
              accountId,
              expires: accessKey.expires,
            });
          })
          .then(() => resolve())
          .catch((error) => {
            if (error.code === 11000) {
              reject(storage.storageError(storage.ErrorCode.AlreadyExists));
            } else {
              reject(error);
            }
          });
      });
    });
  }

  /**
   * 액세스 키 정보를 조회합니다.
   * @param accountId 조회할 계정 ID
   * @param accessKeyId 조회할 액세스 키 ID
   * @returns 액세스 키 정보
   */
  public getAccessKey(accountId: string, accessKeyId: string): q.Promise<storage.AccessKey> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.AccessKey>((resolve, reject) => {
        this._connection.collections.accessKeys
          .findOne({
            id: StorageKeys.getAccessKeyId(accountId, accessKeyId),
          })
          .then((accessKey) => {
            if (!accessKey) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              delete accessKey.id;
              delete accessKey.createdBy;
              resolve(accessKey);
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 계정 ID로 액세스 키 목록을 조회합니다.
   * @param accountId 조회할 계정 ID
   * @returns 액세스 키 정보 배열
   */
  public getAccessKeys(accountId: string): q.Promise<storage.AccessKey[]> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.AccessKey[]>((resolve, reject) => {
        this._connection.collections.accessKeys
          .find({ accountId })
          .toArray()
          .then((accessKeys) => {
            accessKeys.forEach((key) => {
              delete key.id;
              delete key.createdBy;
            });
            resolve(accessKeys);
          })
          .catch(reject);
      });
    });
  }

  /**
   * 액세스 키 이름으로 계정 ID를 조회합니다.
   * @param accessKeyName 조회할 액세스 키 이름
   * @returns 계정 ID
   */
  public getAccountIdFromAccessKey(accessKeyName: string): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        this._connection.collections.accessKeyPointers
          .findOne({
            id: StorageKeys.getAccessKeyPointerId(accessKeyName),
          })
          .then((pointer) => {
            if (!pointer) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else if (new Date().getTime() >= pointer.expires) {
              reject(storage.storageError(storage.ErrorCode.Expired, "The access key has expired."));
            } else {
              resolve(pointer.accountId);
            }
          })
          .catch(reject);
      });
    });
  }

  /**
   * 액세스 키 정보를 업데이트합니다.
   * @param accountId 업데이트할 액세스 키의 계정 ID
   * @param accessKeyId 업데이트할 액세스 키 ID
   * @param updates 업데이트할 정보
   * @returns 완료 Promise
   */
  public updateAccessKey(accountId: string, accessKeyId: string, updates: any): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.accessKeys
          .updateOne({ id: StorageKeys.getAccessKeyId(accountId, accessKeyId) }, { $set: updates })
          .then((result) => {
            if (result.matchedCount === 0) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else if (updates.expires) {
              // 만료 시간이 업데이트된 경우 포인터도 업데이트
              return this._connection.collections.accessKeys.findOne({
                id: StorageKeys.getAccessKeyId(accountId, accessKeyId),
              });
            } else {
              resolve();
            }
          })
          .then((accessKey) => {
            if (accessKey) {
              return this._connection.collections.accessKeyPointers.updateOne(
                { id: StorageKeys.getAccessKeyPointerId(accessKey.name) },
                { $set: { expires: accessKey.expires } }
              );
            }
          })
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  /**
   * 액세스 키 정보를 삭제합니다.
   * @param accountId 삭제할 액세스 키의 계정 ID
   * @param accessKeyId 삭제할 액세스 키 ID
   * @returns 완료 Promise
   */
  public removeAccessKey(accountId: string, accessKeyId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        // 먼저 액세스 키 정보 가져오기
        this._connection.collections.accessKeys
          .findOne({
            id: StorageKeys.getAccessKeyId(accountId, accessKeyId),
          })
          .then((accessKey) => {
            if (!accessKey) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              // 액세스 키 삭제
              return this._connection.collections.accessKeys
                .deleteOne({
                  id: StorageKeys.getAccessKeyId(accountId, accessKeyId),
                })
                .then(() => {
                  // 액세스 키 포인터 삭제
                  return this._connection.collections.accessKeyPointers.deleteOne({
                    id: StorageKeys.getAccessKeyPointerId(accessKey.name),
                  });
                });
            }
          })
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  /**
   * MongoDB 연결을 종료합니다.
   * @returns 완료 Promise
   */
  public close(): q.Promise<void> {
    if (this._connection && this._connection.client) {
      return q.Promise<void>((resolve) => {
        this._connection.client
          .close()
          .then(() => resolve())
          .catch(() => resolve()); // 에러가 발생해도 무시
      });
    }
    return q(<void>null);
  }

  /**
   * MongoDB 연결 객체를 반환합니다.
   * @returns MongoDB 연결 객체
   */
  public getConnection(): MongoDBConnection {
    return this._connection;
  }

  /**
   * 설정 프로미스를 반환합니다.
   * @returns 설정 프로미스
   */
  public getSetupPromise(): q.Promise<void> {
    return this._setupPromise;
  }
}
