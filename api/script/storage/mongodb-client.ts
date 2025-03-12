// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection, Db, MongoClient } from "mongodb";
import * as q from "q";
import * as storage from "./storage";
import { StorageKeys } from "./storage-keys";
import { Account, App, Deployment, AccessKey } from "./storage";

// MongoDB 연결 및 컬렉션 관리
export interface MongoDBConnection {
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
  private _setupPromise: q.Promise<void>;

  constructor(mongoUrl?: string) {
    const _mongoUrl = mongoUrl ?? process.env.MONGODB_URI ?? "mongodb://localhost:27017/codepush";
    this._setupPromise = this.setup(_mongoUrl);
  }

  // MongoDB 연결 설정
  private setup(mongoUrl: string): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      MongoClient.connect(mongoUrl)
        .then((client) => {
          const db = client.db();
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

          // 인덱스 생성
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
          reject(error);
        });
    });
  }

  // 헬스 체크
  public checkHealth(): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.db
          .command({ ping: 1 })
          .then(() => resolve())
          .catch((error) =>
            reject(storage.storageError(storage.ErrorCode.ConnectionFailed, "MongoDB connection failed: " + error.message))
          );
      });
    });
  }

  // 계정 관련 메서드
  public addAccount(account: storage.Account): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        this._connection.collections.accounts
          .insertOne({
            id: StorageKeys.getAccountId(account.id),
            ...account,
            email: account.email.toLowerCase(), // 이메일은 소문자로 저장
          })
          .then(() => resolve(account.id))
          .catch((error) => {
            if (error.code === 11000) {
              // MongoDB 중복 키 에러
              reject(storage.storageError(storage.ErrorCode.AlreadyExists));
            } else {
              reject(error);
            }
          });
      });
    });
  }

  public getAccount(accountId: string): q.Promise<storage.Account> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Account>((resolve, reject) => {
        this._connection.collections.accounts
          .findOne({ id: StorageKeys.getAccountId(accountId) })
          .then((account) => {
            if (!account) {
              reject(storage.storageError(storage.ErrorCode.NotFound));
            } else {
              delete account.id; // MongoDB ID 제거
              resolve(account);
            }
          })
          .catch(reject);
      });
    });
  }

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

  // 앱 관련 메서드
  public addApp(app: storage.App): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.apps
          .insertOne({
            id: StorageKeys.getAppId(app.id),
            ...app,
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

  public getApp(appId: string): q.Promise<storage.App> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.App>((resolve, reject) => {
        this._connection.collections.apps
          .findOne({ id: StorageKeys.getAppId(appId) })
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

  public getApps(accountId: string): q.Promise<storage.App[]> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.App[]>((resolve, reject) => {
        this._connection.collections.apps
          .find({
            [`collaborators.${accountId}`]: { $exists: true },
          })
          .toArray()
          .then((apps) => {
            apps.forEach((app) => delete app.id);
            resolve(apps);
          })
          .catch(reject);
      });
    });
  }

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

  public removeApp(appId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.apps
          .deleteOne({ id: StorageKeys.getAppId(appId) })
          .then(() => {
            // 관련 배포도 삭제
            return this._connection.collections.deployments.deleteMany({ appId });
          })
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  // 배포 관련 메서드
  public addDeployment(addId: string, deployment: storage.Deployment): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._connection.collections.deployments
          .insertOne({
            id: StorageKeys.getDeploymentId(addId, deployment.id),
            ...deployment,
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
          .catch(reject);
      });
    });
  }

  public getDeploymentInfo(deploymentKey: string, accountId?:string, appName?:string): q.Promise<storage.DeploymentInfo> {
    const query: any = {};

    if (appName) {
      query.name = appName;
    }

    if (accountId) {
      query[`collaborators.${accountId}`] = { $exists: true };
    }

    return q.Promise<storage.DeploymentInfo>((resolve, reject) => {
      this._connection.collections.apps.findOne(query)
        .then(findByAccountIdAndName => {
          return this._connection.collections.deployments
            .findOne({ key: deploymentKey })
            .then((deployment) => {
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

  public getDeployments(appId: string): q.Promise<storage.Deployment[]> {
    return this._setupPromise.then(() => {
      return q.Promise<storage.Deployment[]>((resolve, reject) => {
        this._connection.collections.deployments
          .find({ appId })
          .toArray()
          .then((deployments) => {
            deployments.forEach((deployment) => delete deployment.id);
            resolve(deployments);
          })
          .catch(reject);
      });
    });
  }

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

  // 액세스 키 관련 메서드
  public addAccessKey(accessKey: storage.AccessKey, accountId: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        // 액세스 키 저장
        this._connection.collections.accessKeys
          .insertOne({
            id: StorageKeys.getAccessKeyId(accountId, accessKey.id),
            ...accessKey,
            createdBy: accountId,
          })
          .then(() => {
            // 액세스 키 포인터 저장 (이름으로 조회 가능하도록)
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

  // 연결 종료
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

  // MongoDB 연결 객체 반환
  public getConnection(): MongoDBConnection {
    return this._connection;
  }

  // 설정 프로미스 반환
  public getSetupPromise(): q.Promise<void> {
    return this._setupPromise;
  }
}
