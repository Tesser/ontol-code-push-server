// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as dotenv from 'dotenv';
import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import * as fs from "fs";
import * as q from "q";
import * as semver from "semver";
import * as stream from "stream";
import * as streamifier from "streamifier";
import * as error from "../error";
import { createTempFileFromBuffer, getFileWithField } from "../file-upload-manager";
import * as storageTypes from "../infrastructure/storage";
import { isPrototypePollutionKey } from "../infrastructure/storage";
import * as redis from "../redis-manager";
import * as restTypes from "../types/rest-definitions";
import * as converterUtils from "../utils/converter";
import * as diffErrorUtils from "../utils/diff-error-handling";
import * as hashUtils from "../utils/hash-utils";
import * as packageDiffing from "../utils/package-diffing";
import * as errorUtils from "../utils/rest-error-handling";
import { getIpAddress } from "../utils/rest-headers";
import { isUnfinishedRollout } from "../utils/rollout-selector";
import * as security from "../utils/security";
import * as validationUtils from "../utils/validation";
import PackageDiffer = packageDiffing.PackageDiffer;
import NameResolver = storageTypes.NameResolver;
import PackageManifest = hashUtils.PackageManifest;
import Promise = q.Promise;
import tryJSON = require("try-json");
dotenv.config();

const DEFAULT_ACCESS_KEY_EXPIRY = 1000 * 60 * 60 * 24 * 60; // 60 days
const ACCESS_KEY_MASKING_STRING = "(hidden)";

export interface ManagementConfig {
  storage: storageTypes.Storage;
  redisManager: redis.RedisManager;
}

/**
 * 주어진 문자열과 값을 URL 인코딩하여 반환합니다.
 * 
 * URL에 한글이나 특수문자가 포함된 변수를 안전하게 삽입할 때 유용합니다.
 * @param strings 템플릿 리터럴에서 변수 사이의 문자열 부분 배열
 * @param values 템플릿 리터럴에 삽입된 변수 값 배열
 * @returns URL 인코딩된 문자열
 */
function urlEncode(strings: string[], ...values: string[]): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      // 변수 값들만 URL 인코딩합니다.
      result += encodeURIComponent(values[i]);
    }
  }

  return result;
}

export function getManagementRouter(config: ManagementConfig): Router {
  const redisManager: redis.RedisManager = config.redisManager;
  const storage: storageTypes.Storage = config.storage;
  const packageDiffing = new PackageDiffer(storage, parseInt(process.env.DIFF_PACKAGE_COUNT) || 5);
  const router: Router = Router();
  const nameResolver: NameResolver = new NameResolver(config.storage);

  // 계정 정보를 조회합니다.
  router.get("/account", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    storage
      .getAccount(accountId)
      .then((storageAccount: storageTypes.Account) => {
        const restAccount: restTypes.Account = converterUtils.toRestAccount(storageAccount);
        res.send({ account: restAccount });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 모든 액세스 키 목록을 조회합니다.
  router.get("/accessKeys", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;

    // 계정 ID를 사용해 해당 사용자의 모든 액세스 키를 가져옵니다.
    storage
      .getAccessKeys(accountId)
      .then((accessKeys: storageTypes.AccessKey[]): void => {
        accessKeys.sort((first: storageTypes.AccessKey, second: storageTypes.AccessKey) => {
          const firstTime = first.createdTime || 0;
          const secondTime = second.createdTime || 0;
          return firstTime - secondTime;
        });

        // 보안을 위해 실제 키 문자열을 마스킹 처리합니다.
        // 실제 키 문자열을 숨김 처리하고 이전 버전의 CLI(1.11.0-beta 이전)에서 여전히 표시하려고 시도하는 경우 메시지로 대체합니다.
        accessKeys.forEach((accessKey: restTypes.AccessKey) => {
          accessKey.name = ACCESS_KEY_MASKING_STRING;
        });

        res.send({ accessKeys: accessKeys });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 액세스 키를 생성합니다.
  router.post("/accessKeys", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const accessKeyRequest: restTypes.AccessKeyRequest = converterUtils.accessKeyRequestFromBody(req.body);
    if (!accessKeyRequest.name) {
      accessKeyRequest.name = security.generateSecureKey(accountId);
    }

    if (!accessKeyRequest.createdBy) {
      accessKeyRequest.createdBy = getIpAddress(req);
    }

    const validationErrors: validationUtils.ValidationError[] = validationUtils.validateAccessKeyRequest(
      accessKeyRequest,
      /*isUpdate=*/ false
    );

    if (validationErrors.length) {
      res.status(400).send(validationErrors);
      return;
    }

    const accessKey: restTypes.AccessKey = <restTypes.AccessKey>(<restTypes.AccessKey>accessKeyRequest);

    accessKey.createdTime = new Date().getTime();
    accessKey.expires = accessKey.createdTime + (accessKeyRequest.ttl || DEFAULT_ACCESS_KEY_EXPIRY);
    delete accessKeyRequest.ttl;

    storage
      .getAccessKeys(accountId)
      .then((accessKeys: storageTypes.AccessKey[]): void | Promise<void> => {
        if (NameResolver.isDuplicate(accessKeys, accessKey.name)) {
          errorUtils.sendConflictError(res, `The access key "${accessKey.name}" already exists.`);
          return;
        } else if (NameResolver.isDuplicate(accessKeys, accessKey.friendlyName)) {
          errorUtils.sendConflictError(res, `The access key "${accessKey.friendlyName}" already exists.`);
          return;
        }

        const storageAccessKey: storageTypes.AccessKey = converterUtils.toStorageAccessKey(accessKey);
        return storage.addAccessKey(accountId, storageAccessKey).then((id: string): void => {
          res.setHeader("Location", urlEncode([`/accessKeys/${accessKey.friendlyName}`]));
          res.status(201).send({ accessKey: accessKey });
        });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 액세스 키를 조회합니다.
  router.get("/accessKeys/:accessKeyName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accessKeyName: string = req.params.accessKeyName;
    const accountId: string = req.user.id;

    // 계정 ID와 액세스 키 이름을 사용해 특정 액세스 키를 가져옵니다.
    nameResolver
      .resolveAccessKey(accountId, accessKeyName)
      .then((accessKey: storageTypes.AccessKey): void => {
        delete accessKey.name; // 응답 반환 전 액세스 키에서 name 속성을 삭제합니다.
        res.send({ accessKey: accessKey });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 액세스 키를 업데이트합니다.
  router.patch("/accessKeys/:accessKeyName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const accessKeyName: string = req.params.accessKeyName;
    const accessKeyRequest: restTypes.AccessKeyRequest = converterUtils.accessKeyRequestFromBody(req.body);

    const validationErrors: validationUtils.ValidationError[] = validationUtils.validateAccessKeyRequest(
      accessKeyRequest,
      /*isUpdate=*/ true
    );
    if (validationErrors.length) {
      res.status(400).send(validationErrors);
      return;
    }

    let updatedAccessKey: storageTypes.AccessKey;
    storage
      .getAccessKeys(accountId)
      .then((accessKeys: storageTypes.AccessKey[]): Promise<void> => {
        updatedAccessKey = NameResolver.findByName(accessKeys, accessKeyName);
        if (!updatedAccessKey) {
          throw errorUtils.restError(errorUtils.ErrorCode.NotFound, `The access key "${accessKeyName}" does not exist.`);
        }

        if (accessKeyRequest.friendlyName) {
          if (NameResolver.isDuplicate(accessKeys, accessKeyRequest.friendlyName)) {
            throw errorUtils.restError(
              errorUtils.ErrorCode.Conflict,
              `The access key "${accessKeyRequest.friendlyName}" already exists.`
            );
          }

          updatedAccessKey.friendlyName = accessKeyRequest.friendlyName;
          updatedAccessKey.description = updatedAccessKey.friendlyName;
        }

        if (accessKeyRequest.ttl !== undefined) {
          updatedAccessKey.expires = new Date().getTime() + accessKeyRequest.ttl;
        }

        return storage.updateAccessKey(accountId, updatedAccessKey);
      })
      .then((): void => {
        delete updatedAccessKey.name;
        res.send({ accessKey: updatedAccessKey });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 액세스 키를 삭제합니다.
  router.delete("/accessKeys/:accessKeyName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const accessKeyName: string = req.params.accessKeyName;

    nameResolver
      .resolveAccessKey(accountId, accessKeyName)
      .then((accessKey: storageTypes.AccessKey): Promise<void> => {
        return storage.removeAccessKey(accountId, accessKey.id);
      })
      .then((): void => {
        res.sendStatus(204);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 출처(createdBy)에서 생성된 모든 세션을 삭제합니다.
  // 로그아웃, 
  // 특정 계정 또는 애플리케이션의 접근 권한 원격 취소, 
  // 보안 목적으로 세션 일괄 삭제, 
  // 개발자 도구/CLI에서 생성된 세션 토큰 초기화, 
  // 관리자 대시보드에서 세션 삭제
  router.delete("/sessions/:createdBy", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const createdBy: string = req.params.createdBy;

    // 사용자의 모든 액세스 키를 가져온 후, 세션 타입이면서 특정 출처(createdBy)에서 생성된 액세스 키만 삭제합니다.
    storage
      .getAccessKeys(accountId)
      .then((accessKeys: storageTypes.AccessKey[]) => {
        const accessKeyDeletionPromises: Promise<void>[] = [];
        accessKeys.forEach((accessKey: storageTypes.AccessKey) => {
          if (accessKey.isSession && accessKey.createdBy === createdBy) {
            accessKeyDeletionPromises.push(storage.removeAccessKey(accountId, accessKey.id));
          }
        });

        if (accessKeyDeletionPromises.length) {
          return q.all(accessKeyDeletionPromises);
        } else {
          throw errorUtils.restError(errorUtils.ErrorCode.NotFound, `There are no sessions associated with "${createdBy}."`);
        }
      })
      .then((): void => {
        res.sendStatus(204);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 모든 애플리케이션 목록을 조회합니다.
  router.get("/apps", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    storage
      .getApps(accountId)
      .then((apps: storageTypes.App[]) => {
        const restAppPromises: Promise<restTypes.App>[] = apps.map((app: storageTypes.App) => {
          return storage.getDeployments(accountId, app.id).then((deployments: storageTypes.Deployment[]) => {
            const deploymentNames: string[] = deployments.map((deployment: storageTypes.Deployment) => deployment.name);
            return converterUtils.toRestApp(app, app.name, deploymentNames);
          });
        });

        return q.all(restAppPromises);
      })
      .then((restApps: restTypes.App[]) => {
        res.send({ apps: converterUtils.sortAndUpdateDisplayNameOfRestAppsList(restApps) });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 애플리케이션 관리 시스템에서 새로운 앱을 생성하고 기본 배포 환경을 설정합니다.
  router.post("/apps", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appRequest: restTypes.AppCreationRequest = converterUtils.appCreationRequestFromBody(req.body);
    const validationErrors = validationUtils.validateApp(appRequest, /*isUpdate=*/ false);
    if (validationErrors.length) {
      errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
    } else {
      storage
        // 기존 앱 목록을 조회하여 중복 이름 체크
        .getApps(accountId)
        .then((apps: storageTypes.App[]): void | Promise<void> => {
          if (NameResolver.isDuplicate(apps, appRequest.name)) {
            errorUtils.sendConflictError(res, "An app named '" + appRequest.name + "' already exists.");
            return;
          }

          let storageApp: storageTypes.App = converterUtils.toStorageApp(appRequest, new Date().getTime());

          // 새로운 앱을 저장소에 추가
          return storage
            .addApp(accountId, storageApp)
            .then((app: storageTypes.App): Promise<string[]> => {
              storageApp = app;
              // 자동 배포 환경 생성 여부
              if (!appRequest.manuallyProvisionDeployments) {
                const defaultDeployments: string[] = ["Production", "Staging"];
                const deploymentPromises: Promise<string>[] = defaultDeployments.map((deploymentName: string) => {
                  const deployment: storageTypes.Deployment = {
                    createdTime: new Date().getTime(),
                    name: deploymentName,
                    key: security.generateSecureKey(accountId),
                  };

                  return storage.addDeployment(accountId, storageApp.id, deployment).then(() => {
                    return deployment.name;
                  });
                });

                return q.all(deploymentPromises);
              }
            })
            .then((deploymentNames: string[]): void => {
              res.setHeader("Location", urlEncode([`/apps/${storageApp.name}`]));
              res.status(201).send({ app: converterUtils.toRestApp(storageApp, /*displayName=*/ storageApp.name, deploymentNames) });
            });
        })
        .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    }
  });

  // 특정 애플리케이션을 조회합니다.
  router.get("/apps/:appName", (req: Request, res: Response, next: (err?: any) => void): any => {
    // 사용자의 계정 ID와 앱 이름을 사용하여 애플리케이션을 조회합니다.
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    let storageApp: storageTypes.App;
    nameResolver
      .resolveApp(accountId, appName)
      // 해당 앱의 모든 배포 목록을 조회합니다.
      .then((app: storageTypes.App) => {
        storageApp = app;
        return storage.getDeployments(accountId, app.id);
      })
      .then((deployments: storageTypes.Deployment[]) => {
        // 배포 이름 목록을 추출합니다.
        const deploymentNames: string[] = deployments.map((deployment) => deployment.name);
        // 애플리케이션 정보를 REST API 형식으로 변환하여 응답합니다.
        res.send({ app: converterUtils.toRestApp(storageApp, /*displayName=*/ appName, deploymentNames) });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 애플리케이션을 삭제합니다.
  router.delete("/apps/:appName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    let appId: string;
    let invalidationError: Error;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        return storage.getDeployments(accountId, appId);
      })
      .then((deployments: storageTypes.Deployment[]) => {
        const invalidationPromises: Promise<void>[] = deployments.map((deployment: storageTypes.Deployment) => {
          return invalidateCachedPackage(deployment.key);
        });

        return q.all(invalidationPromises).catch((error: Error) => {
          invalidationError = error; // Do not block app deletion on cache invalidation
        });
      })
      .then(() => {
        return storage.removeApp(accountId, appId);
      })
      .then(() => {
        res.sendStatus(204);
        if (invalidationError) throw invalidationError;
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 애플리케이션을 업데이트합니다.
  router.patch("/apps/:appName", (req: Request, res: Response, next: (err?: any) => void): any => {
    // 사용자의 계정 ID와 업데이트 할 앱 이름을 가져옵니다.
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    // 요청 본문을 앱 객체로 변환합니다.
    const app: restTypes.App = converterUtils.appFromBody(req.body);

    storage
      // 사용자의 모든 앱 목록을 가져옵니다.
      .getApps(accountId)
      .then((apps: storageTypes.App[]): void | Promise<void> => {
        // 업데이트 할 앱을 찾습니다.
        const existingApp: storageTypes.App = NameResolver.findByName(apps, appName);
        if (!existingApp) {
          errorUtils.sendNotFoundError(res, `App "${appName}" does not exist.`);
          return;
        }
        // 앱의 소유자 원한을 가지고 있는지 확인합니다.
        throwIfInvalidPermissions(existingApp, storageTypes.Permissions.Owner);

        // 앱 이름이 변경되었는지 확인합니다.
        if ((app.name || app.name === "") && app.name !== existingApp.name) {
          // 새로운 이름이 중복되는지 확인합니다.
          if (NameResolver.isDuplicate(apps, app.name)) {
            errorUtils.sendConflictError(res, "An app named '" + app.name + "' already exists.");
            return;
          }

          existingApp.name = app.name;
        }

        // 앱 정보가 유효한지 확인합니다.
        const validationErrors = validationUtils.validateApp(existingApp, /*isUpdate=*/ true);
        if (validationErrors.length) {
          errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
        } else {
          return storage
            // 변경된 앱 정보를 저장소에 업데이트합니다.
            .updateApp(accountId, existingApp)
            .then(() => {
              // 앱의 모든 배포 목록을 조회합니다.
              return storage.getDeployments(accountId, existingApp.id).then((deployments: storageTypes.Deployment[]) => {
                // 배포 이름 목록을 추출합니다.
                  const deploymentNames: string[] = deployments.map((deployment: storageTypes.Deployment) => {
                  return deployment.name;
                });
                // 애플리케이션 정보를 REST API 형식으로 변환하여 응답합니다.
                return converterUtils.toRestApp(existingApp, existingApp.name, deploymentNames);
              });
            })
            .then((restApp: restTypes.App) => {
              res.send({ app: restApp });
            });
        }
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱의 소유권을 현재 사용자에서 다른 사용자(이메일로 지정)에게 이전합니다.
  router.post("/apps/:appName/transfer/:email", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const email: string = req.params.email;

    // 이메일 형식이 유효한지 확인합니다.
    if (isPrototypePollutionKey(email)) {
      return res.status(400).send("Invalid email parameter");
    }

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        // 앱의 소유권을 새 이메일 주소로 이전합니다.
        return storage.transferApp(accountId, app.id, email);
      })
      .then(() => {
        res.sendStatus(201);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱에 새로운 팀원(collaborator)을 추가합니다. 앱 소유자만 새 팀원을 추가할 수 있습니다.
  router.post("/apps/:appName/collaborators/:email", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const email: string = req.params.email;

    if (isPrototypePollutionKey(email)) {
      return res.status(400).send("Invalid email parameter");
    }

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        // 지정된 이메일 주소를 앱의 팀원으로 추가합니다.# localeCompare
        return storage.addCollaborator(accountId, app.id, email);
      })
      .then(() => {
        res.sendStatus(201);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱의 모든 팀원(collaborator)을 조회합니다.
  router.get("/apps/:appName/collaborators", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
        return storage.getCollaborators(accountId, app.id);
      })
      .then((retrievedMap: storageTypes.CollaboratorMap) => {
        res.send({ collaborators: converterUtils.toRestCollaboratorMap(retrievedMap) });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱의 팀원(collaborator)을 삭제합니다.
  router.delete("/apps/:appName/collaborators/:email", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const email: string = req.params.email;

    if (isPrototypePollutionKey(email)) {
      return res.status(400).send("Invalid email parameter");
    }

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        const isAttemptingToRemoveSelf: boolean =
          app.collaborators && email && app.collaborators[email] && app.collaborators[email].isCurrentAccount;
        throwIfInvalidPermissions(
          app,
          isAttemptingToRemoveSelf ? storageTypes.Permissions.Collaborator : storageTypes.Permissions.Owner
        );
        return storage.removeCollaborator(accountId, app.id, email);
      })
      .then(() => {
        res.sendStatus(204);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱의 모든 배포(deployment)를 조회합니다.
  router.get("/apps/:appName/deployments", (req: Request, res: Response, next: (err?: any) => void): any => {
    console.log('🟢 배포 목록 조회[user]: ', req.user)
    console.log('🟢 배포 목록 조회[params]: ', req.params)
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    let appId: string;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
        return storage.getDeployments(accountId, appId);
      })
      .then((deployments: storageTypes.Deployment[]) => {
        deployments.sort((first: restTypes.Deployment, second: restTypes.Deployment) => {
          return first.name.localeCompare(second.name);
        });

        res.send({ deployments: deployments });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 앱에 새로운 배포(deployment)를 생성합니다.
  router.post("/apps/:appName/deployments", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    let appId: string;
    let restDeployment: restTypes.Deployment = converterUtils.deploymentFromBody(req.body);

    const validationErrors = validationUtils.validateDeployment(restDeployment, /*isUpdate=*/ false);
    if (validationErrors.length) {
      errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
      return;
    }

    const storageDeployment: storageTypes.Deployment = converterUtils.toStorageDeployment(restDeployment, new Date().getTime());
    nameResolver
      // 앱 이름으로 앱 객체를 찾습니다.
      .resolveApp(accountId, appName)
      // 해당 앱에 대한 기존 배포 목록을 가져옵니다.
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        return storage.getDeployments(accountId, app.id);
      })
      .then((deployments: storageTypes.Deployment[]): void | Promise<void> => {
        if (NameResolver.isDuplicate(deployments, restDeployment.name)) {
          errorUtils.sendConflictError(res, "A deployment named '" + restDeployment.name + "' already exists.");
          return;
        }

        // 요청에 배포 키가 포함되었으면 사용하고, 없으면 새로 생성합니다.
        storageDeployment.key = restDeployment.key || security.generateSecureKey(accountId);

        // 새 배포를 저장소에 추가합니다.
        return storage.addDeployment(accountId, appId, storageDeployment).then((deploymentId: string): void => {
          restDeployment = converterUtils.toRestDeployment(storageDeployment);
          res.setHeader("Location", urlEncode([`/apps/${appName}/deployments/${restDeployment.name}`]));
          res.status(201).send({ deployment: restDeployment });
        });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 배포를 조회합니다.
  router.get("/apps/:appName/deployments/:deploymentName", (req: Request, res: Response, next: (err?: any) => void): any => {
    console.log("✅ getDeployment", req.user.id, req.params.appName, req.params.deploymentName);
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const deploymentName: string = req.params.deploymentName;
    let appId: string;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        console.log("✅ getDeployment [1]", app);
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
        return nameResolver.resolveDeployment(accountId, appId, deploymentName);
      })
      .then((deployment: storageTypes.Deployment) => {
        console.log("✅ getDeployment [2]", deployment);
        const restDeployment: restTypes.Deployment = converterUtils.toRestDeployment(deployment);
        res.send({ deployment: restDeployment });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 특정 배포를 삭제합니다.
  router.delete("/apps/:appName/deployments/:deploymentName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const deploymentName: string = req.params.deploymentName;
    let appId: string;
    let deploymentId: string;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        return nameResolver.resolveDeployment(accountId, appId, deploymentName);
      })
      .then((deployment: storageTypes.Deployment) => {
        deploymentId = deployment.id;
        return invalidateCachedPackage(deployment.key);
      })
      .then(() => {
        return storage.removeDeployment(accountId, appId, deploymentId);
      })
      .then(() => {
        res.sendStatus(204);
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 배포(환경)의 정보(주로 이름)를 업데이트합니다.
  router.patch("/apps/:appName/deployments/:deploymentName", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const deploymentName: string = req.params.deploymentName;
    let appId: string;
    let restDeployment: restTypes.Deployment = converterUtils.deploymentFromBody(req.body);

    const validationErrors = validationUtils.validateDeployment(restDeployment, /*isUpdate=*/ true);
    if (validationErrors.length) {
      errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
      return;
    }

    nameResolver
      .resolveApp(accountId, appName)
      // 앱의 모든 배포 목록을 가져옵니다.
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
        return storage.getDeployments(accountId, app.id);
      })
      // 업데이트할 배포를 찾습니다.
      .then((storageDeployments: storageTypes.Deployment[]): void | Promise<void> => {
        const storageDeployment: storageTypes.Deployment = NameResolver.findByName(storageDeployments, deploymentName);

        if (!storageDeployment) {
          errorUtils.sendNotFoundError(res, `Deployment "${deploymentName}" does not exist.`);
          return;
        }

        // 요청에 배포 이름이 포함되어 있고 기존 이름과 다르면 중복 여부를 체크한 뒤 이름을 변경합니다.
        if ((restDeployment.name || restDeployment.name === "") && restDeployment.name !== storageDeployment.name) {
          if (NameResolver.isDuplicate(storageDeployments, restDeployment.name)) {
            errorUtils.sendConflictError(res, "A deployment named '" + restDeployment.name + "' already exists.");
            return;
          }
          storageDeployment.name = restDeployment.name;
        }

        restDeployment = converterUtils.toRestDeployment(storageDeployment);
        return storage.updateDeployment(accountId, appId, storageDeployment).then(() => {
          res.send({ deployment: restDeployment });
        });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 기존 릴리즈의 메타데이터(설명, 필수 업데이트 여부, 롤아웃 비율 등)를 업데이트합니다.
  router.patch("/apps/:appName/deployments/:deploymentName/release", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const deploymentName: string = req.params.deploymentName;
    const info: restTypes.PackageInfo = req.body.packageInfo || {};
    const validationErrors: validationUtils.ValidationError[] = validationUtils.validatePackageInfo(info, /*allOptional*/ true);
    if (validationErrors.length) {
      errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
      return;
    }

    let updateRelease: boolean = false;
    let storageDeployment: storageTypes.Deployment;
    let appId: string;

    nameResolver
      .resolveApp(accountId, appName)
      // 앱의 모든 배포 목록을 가져옵니다.
      .then((app: storageTypes.App) => {
        appId = app.id;
        throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
        return storage.getDeployments(accountId, app.id);
      })
      // 업데이트할 배포를 찾습니다.
      .then((storageDeployments: storageTypes.Deployment[]) => {
        storageDeployment = NameResolver.findByName(storageDeployments, deploymentName);

        if (!storageDeployment) {
          throw errorUtils.restError(errorUtils.ErrorCode.NotFound, `Deployment "${deploymentName}" does not exist.`);
        }

        // 배포의 모든 릴리즈 이력을 가져옵니다.
        return storage.getPackageHistory(accountId, appId, storageDeployment.id);
      })
      .then((packageHistory: storageTypes.Package[]) => {
        if (!packageHistory.length) {
          throw errorUtils.restError(errorUtils.ErrorCode.NotFound, "Deployment has no releases.");
        }

        // 요청에 라벨이 포함되어 있으면 해당 라벨의 릴리즈를 찾고, 없으면 가장 최근 릴리즈를 사용합니다.
        const packageToUpdate: storageTypes.Package = info.label
          ? getPackageFromLabel(packageHistory, info.label)
          : packageHistory[packageHistory.length - 1];

        if (!packageToUpdate) {
          throw errorUtils.restError(errorUtils.ErrorCode.NotFound, "Release not found for given label.");
        }

        // 패키지 비활성화 여부를 업데이트합니다.
        const newIsDisabled: boolean = info.isDisabled;
        if (validationUtils.isDefined(newIsDisabled) && packageToUpdate.isDisabled !== newIsDisabled) {
          packageToUpdate.isDisabled = newIsDisabled;
          updateRelease = true;
        }

        // 패키지 필수 업데이트 여부를 설정합니다.
        const newIsMandatory: boolean = info.isMandatory;
        if (validationUtils.isDefined(newIsMandatory) && packageToUpdate.isMandatory !== newIsMandatory) {
          packageToUpdate.isMandatory = newIsMandatory;
          updateRelease = true;
        }

        // 패키지 설명을 업데이트합니다.
        if (info.description && packageToUpdate.description !== info.description) {
          packageToUpdate.description = info.description;
          updateRelease = true;
        }

        // 패키지 롤아웃 비율을 업데이트합니다.
        // 진행중인 롤아웃만 업데이트할 수 있습니다.
        const newRolloutValue: number = info.rollout;
        if (validationUtils.isDefined(newRolloutValue)) {
          let errorMessage: string;
          if (!isUnfinishedRollout(packageToUpdate.rollout)) {
            errorMessage = "Cannot update rollout value for a completed rollout release.";
          } else if (packageToUpdate.rollout >= newRolloutValue) {
            errorMessage = `Rollout value must be greater than "${packageToUpdate.rollout}", the existing value.`;
          }

          if (errorMessage) {
            throw errorUtils.restError(errorUtils.ErrorCode.Conflict, errorMessage);
          }

          packageToUpdate.rollout = newRolloutValue === 100 ? null : newRolloutValue;
          updateRelease = true;
        }

        // 대상 앱 버전을 업데이트 합니다.
        const newAppVersion: string = info.appVersion;
        if (newAppVersion && packageToUpdate.appVersion !== newAppVersion) {
          packageToUpdate.appVersion = newAppVersion;
          updateRelease = true;
        }

        // 변경사항이 잇으면 패키지 히스토리를 업데이트합니다.
        // 업데이트된 패키지 정보를 응답으로 보내고 캐시된 패키지를 무효화합니다.
        if (updateRelease) {
          return storage.updatePackageHistory(accountId, appId, storageDeployment.id, packageHistory).then(() => {
            res.send({ package: converterUtils.toRestPackage(packageToUpdate) });
            return invalidateCachedPackage(storageDeployment.key);
          });
        } else {
          res.sendStatus(204);
        }
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  const releaseRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
  });

  /**
   * 번들링된 파일을 CodePush 서버에 배포합니다.
   * @param appName 앱 이름
   * @param deploymentName 배포 이름
   * @param req 요청 객체
   * @param res 응답 객체
   * @param next 오류 처리 함수
   */
  router.post(
    "/apps/:appName/deployments/:deploymentName/release",
    releaseRateLimiter,
    (req: Request, res: Response, next: (err?: any) => void): any => {
      console.log("🔴 요청에서 계정 ID, 앱 이름, 배포 이름을 추출합니다.", req.user.id, req.params.appName, req.params.deploymentName);
      // 요청에서 계정 ID, 앱 이름, 배포 이름을 추출합니다.
      const accountId: string = req.user.id;
      const appName: string = req.params.appName;
      const deploymentName: string = req.params.deploymentName;
      const file: any = getFileWithField(req, "package");

      // 패키지 파일이 없거나 버퍼가 없는 경우, 오류를 발생시킵니다.
      if (!file || !file.buffer) {
        console.log("🔴 패키지 파일이 없거나 버퍼가 없는 경우, 오류를 발생시킵니다.", file, file.buffer);
        errorUtils.sendMalformedRequestError(res, "A deployment package must include a file.");
        return;
      }

      //  
      const filePath: string = createTempFileFromBuffer(file.buffer);
      console.log("🔴 임시 파일 생성", filePath);
      // 패키지 정보의 유효성을 검사하고, 유효하지 않으면 오류를 반환합니다.
      // restPackage: API 요청에서 전달받은 패키지 정보
      const restPackage: restTypes.Package = tryJSON(req.body.packageInfo) || {};
      const validationErrors: validationUtils.ValidationError[] = validationUtils.validatePackageInfo(
        restPackage,
        /*allOptional*/ false
      );
      console.log("🔴 패키지 정보의 유효성 검사", validationErrors);
      if (validationErrors.length) {
        errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
        return;
      }

      // 패키지 파일의 크기를 확인하고, 파일이 존재하지 않거나 디렉토리인 경우 오류를 반환합니다.
      fs.stat(filePath, (err: NodeJS.ErrnoException, stats: fs.Stats): void => {
        if (err) {
          errorUtils.sendUnknownError(res, err, next);
          return;
        }

        // 이 변수들은 프로미스 결과를 호이스팅하고 다음 프로미스 체인을 평탄화 하기 위해 사용됩니다.
        let appId: string;
        let deploymentToReleaseTo: storageTypes.Deployment;
        // 저장소에 저장될 형태로 변환된 패키지
        let storagePackage: storageTypes.Package;
        // packageHash: 패키지 파일 또는 매니페스트에서 계산된 해시 값 (패키지의 고유 식별자)
        let lastPackageHashWithSameAppVersion: string;
        // ZIP 파일에서 생성도니 매니페스트 객체입니다.
        let newManifest: PackageManifest;

        nameResolver
          // 앱 이름을 사용하여 앱 ID를 찾습니다.
          .resolveApp(accountId, appName)
          .then((app: storageTypes.App) => {
            console.log("🔴 앱 이름을 사용하여 앱 ID를 찾습니다.", app);
            appId = app.id;
            // 사용자가 해당 앱에 대한 권한이 있는지 확인합니다.
            throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
            // 배포 이름을 사용하여 배포 정보를 가져옵니다.
            return nameResolver.resolveDeployment(accountId, appId, deploymentName);
          })
          .then((deployment: storageTypes.Deployment) => {
            console.log("🔴 배포 이름을 사용하여 배포 정보를 가져옵니다.", deployment);
            deploymentToReleaseTo = deployment;
            const existingPackage: storageTypes.Package = deployment.package;
            // 기존 패키지가 존재하고, 롤아웃이 완료되지 않은 경우, 오류를 발생시킵니다.
            if (existingPackage && isUnfinishedRollout(existingPackage.rollout) && !existingPackage.isDisabled) {
              throw errorUtils.restError(
                errorUtils.ErrorCode.Conflict,
                "Please update the previous release to 100% rollout before releasing a new package."
              );
            }

            // 배포에 대한 패키지 이력을 가져옵니다.
            return storage.getPackageHistory(accountId, appId, deploymentToReleaseTo.key);
          })
          .then((history: storageTypes.Package[]) => {
            console.log("🔴 배포에 대한 패키지 이력을 가져옵니다.", history);
            // 동일한 앱 버전에 대한 마지막 패키지의 해시를 가져옵니다.
            lastPackageHashWithSameAppVersion = getLastPackageHashWithSameAppVersion(history, restPackage.appVersion);
            // ZIP 파일에서 패키지 매니페스트를 생성합니다.
            return hashUtils.generatePackageManifestFromZip(filePath);
          })
          .then((manifest?: PackageManifest) => {
            console.log("🔴 ZIP 파일에서 패키지 매니페스트를 생성합니다.", manifest);
            if (manifest) {
              newManifest = manifest;
              // 업데이트가 ZIP 파일인 경우, 매니페스트를 사용하여 패키지 해시를 생성합니다.
              // 이는 ZIP 파일 내의 각 파일의 내용을 더 정확하게 나타냅니다.
              return newManifest.computePackageHash();
            } else {
              // 업데이트가 ZIP 파일이 아닌 경우(평탄화된 파일) 전체 파일 내용을 사용하여 패키지 해시를 생성합니다.
              return hashUtils.hashFile(filePath);
            }
          })
          .then((packageHash: string) => {
            console.log("🔴 패키지 해시를 생성합니다.", packageHash);
            restPackage.packageHash = packageHash;
            // 새 패키지 해시가 이전 패키지 해시와 동일하면 오류를 반환합니다.
            if (restPackage.packageHash === lastPackageHashWithSameAppVersion) {
              throw errorUtils.restError(
                errorUtils.ErrorCode.Conflict,
                "The uploaded package was not released because it is identical to the contents of the specified deployment's current release."
              );
            }

            console.log("🔴 패키지 파일을 스토리지에 추가하고 Blob ID를 받습니다.", security.generateSecureKey(accountId), stats.size);
            // 패키지 파일을 스토리지에 추가하고 Blob ID를 받습니다.
            return storage.addBlob(security.generateSecureKey(accountId), fs.createReadStream(filePath), stats.size);
          })
          .then((blobId: string) => {
            console.log("🔴 Blob ID를 사용하여 Blob URL을 가져옵니다.", blobId);
            // Blob ID를 사용하여 Blob URL을 가져옵니다.
            return storage.getBlobUrl(blobId);
          })
          .then((blobUrl: string) => {
            console.log("🔴 Blob URL을 패키지 정보에 추가합니다.", blobUrl);
            restPackage.blobUrl = blobUrl;
            restPackage.size = stats.size;

            // 매니페스트가 있는 경우 매니페스트도 스토리지에 추가하고 URL을 가져옵니다.
            if (newManifest) {
              const json: string = newManifest.serialize();
              const readStream: stream.Readable = streamifier.createReadStream(json);
              console.log("🔴 매니페스트를 스토리지에 추가하고 URL을 가져옵니다.", json.length);
              return storage.addBlob(security.generateSecureKey(accountId), readStream, json.length);
            }

            return q(<string>null);
          })
          .then((blobId?: string) => {
            console.log("🔴 Blob ID를 사용하여 Blob URL을 가져옵니다.", blobId);
            if (blobId) {
              // Blob ID를 사용하여 Blob URL을 가져옵니다.
              return storage.getBlobUrl(blobId);
            }

            return q(<string>null);
          })
          .then((manifestBlobUrl?: string /** 매니페스트가 저장된 URL */) => {
            console.log("🔴 패키지 정보를 스토리지 패키지로 변환합니다.", manifestBlobUrl);
            // 패키지 정보를 스토리지 패키지로 변환합니다.
            storagePackage = converterUtils.toStoragePackage(restPackage);
            if (manifestBlobUrl) {
              console.log("🔴 매니페스트 Blob URL이 있으면 패키지 정보에 추가합니다.", manifestBlobUrl);
              // 매니페스트 Blob URL이 있으면 패키지 정보에 추가합니다.
              storagePackage.manifestBlobUrl = manifestBlobUrl;
            }

            // 릴리즈 방법을 '업로드'로 설정하고 업로드 시간을 기록합니다.
            storagePackage.releaseMethod = storageTypes.ReleaseMethod.Upload;
            storagePackage.uploadTime = new Date().getTime();
            console.log("🔴 릴리즈 방법을 '업로드'로 설정하고 업로드 시간을 기록합니다.", storagePackage);
            // 패키지를 스토리지에 커밋합니다.
            return storage.commitPackage(accountId, appId, deploymentToReleaseTo.key, storagePackage);
          })
          .then((committedPackage: storageTypes.Package): Promise<void> => {
            console.log("🔴 커밋된 패키지를 패키지 정보에 추가합니다.", committedPackage);
            storagePackage.label = committedPackage.label;
            const restPackage: restTypes.Package = converterUtils.toRestPackage(committedPackage);
            // 응답 헤더에 위치를 설정하고 201 상태 코드와 함께 응답을 보냅니다.
            res.setHeader("Location", urlEncode([`/apps/${appName}/deployments/${deploymentName}`]));
            res.status(201).send({ package: restPackage }); // Send response without blocking on cleanup
            // 캐시를 무효화합니다. 
            return invalidateCachedPackage(deploymentToReleaseTo.key);
          })
          .then(() => {
            console.log("🔴 차이 정보를 처리합니다.");
            // 차이 정보를 처리합니다.
            return processDiff(accountId, appId, deploymentToReleaseTo.id, storagePackage);
          })
          .finally((): void => {
            console.log("🔴 임시 파일을 삭제합니다.");
            // 임시 파일을 삭제합니다.
            fs.unlink(filePath, (err: NodeJS.ErrnoException): void => {
              if (err) {
                errorUtils.sendUnknownError(res, err, next);
              }
            });
          })
          .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
          .done();
      });
    }
  );

  // 특정 배포의 패키지 이력을 삭제합니다.
  router.delete(
    "/apps/:appName/deployments/:deploymentName/history",
    (req: Request, res: Response, next: (err?: any) => void): any => {
      const accountId: string = req.user.id;
      const appName: string = req.params.appName;
      const deploymentName: string = req.params.deploymentName;
      let appId: string;
      let deploymentToGetHistoryOf: storageTypes.Deployment;

      nameResolver
        .resolveApp(accountId, appName)
        .then((app: storageTypes.App): Promise<storageTypes.Deployment> => {
          appId = app.id;
          throwIfInvalidPermissions(app, storageTypes.Permissions.Owner);
          return nameResolver.resolveDeployment(accountId, appId, deploymentName);
        })
        .then((deployment: storageTypes.Deployment): Promise<void> => {
          deploymentToGetHistoryOf = deployment;
          return storage.clearPackageHistory(accountId, appId, deploymentToGetHistoryOf.id);
        })
        .then(() => {
          if (redisManager.isEnabled) {
            return redisManager.clearMetricsForDeploymentKey(deploymentToGetHistoryOf.key);
          } else {
            return q(<void>null);
          }
        })
        .then(() => {
          res.sendStatus(204);
          return invalidateCachedPackage(deploymentToGetHistoryOf.key);
        })
        .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    }
  );

  // 패키지 릴리즈 이력을 Storage에서 조회합니다.
  // 저장소 데이터를 그대로 반환합니다.
  router.get("/apps/:appName/deployments/:deploymentName/history", (req: Request, res: Response, next: (err?: any) => void): any => {
    const accountId: string = req.user.id;
    const appName: string = req.params.appName;
    const deploymentName: string = req.params.deploymentName;
    let appId: string;

    nameResolver
      .resolveApp(accountId, appName)
      .then((app: storageTypes.App) => {
        appId = app.id;
        // 사용자가 최소한 팀원의 권한을 가지는지 확인합니다.
        throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
        return nameResolver.resolveDeployment(accountId, appId, deploymentName);
      })
      // 배포 객체를 찾습니다.
      .then((deployment: storageTypes.Deployment): Promise<storageTypes.Package[]> => {
        // 배포에 대한 모든 패키지 릴리즈 기록을 가져옵니다.
        return storage.getPackageHistory(accountId, appId, deployment.id);
      })
      .then((packageHistory: storageTypes.Package[]) => {
        res.send({ history: packageHistory });
      })
      .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  });

  // 배포 성능 및 사용 메트릭을 Redis에서 조회합니다.
  // Redis 데이터를 REST API 형식으로 변환하여 반환합니다.
  router.get("/apps/:appName/deployments/:deploymentName/metrics", (req: Request, res: Response, next: (err?: any) => void): any => {
    if (!redisManager.isEnabled) {
      // Redis가 비활성화된 경우 빈 메트릭 객체를 반환하고 종료합니다.
      res.send({ metrics: {} });
    } else {
      const accountId: string = req.user.id;
      const appName: string = req.params.appName;
      const deploymentName: string = req.params.deploymentName;
      let appId: string;

      nameResolver
        .resolveApp(accountId, appName)
        .then((app: storageTypes.App) => {
          appId = app.id;
          // 사용자가 최소한 팀원의 권한을 가지는지 확인합니다.
          throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
          // 배포 객체를 찾습니다.
          return nameResolver.resolveDeployment(accountId, appId, deploymentName);
        })
        // 특정 앱에 대한 배포 객체를 찾습니다.
        .then((deployment: storageTypes.Deployment): Promise<redis.DeploymentMetrics> => {
          // 배포 키를 사용하여 Redis에서 배포 메트릭을 조회합니다.
          return redisManager.getMetricsWithDeploymentKey(deployment.key);
        })
        .then((metrics: redis.DeploymentMetrics) => {
          // Redis 데이터를 REST API 형식으로 변환하여 반환합니다.
          const deploymentMetrics: restTypes.DeploymentMetrics = converterUtils.toRestDeploymentMetrics(metrics);
          res.send({ metrics: deploymentMetrics });
        })
        .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    }
  });

  // 특정 배포에서 다른 배포로 패키지를 승격합니다.
  router.post(
    "/apps/:appName/deployments/:sourceDeploymentName/promote/:destDeploymentName",
    (req: Request, res: Response, next: (err?: any) => void): any => {
      const accountId: string = req.user.id;
      const appName: string = req.params.appName;
      const sourceDeploymentName: string = req.params.sourceDeploymentName;
      const destDeploymentName: string = req.params.destDeploymentName;
      const info: restTypes.PackageInfo = req.body.packageInfo || {};
      const validationErrors: validationUtils.ValidationError[] = validationUtils.validatePackageInfo(info, /*allOptional*/ true);
      if (validationErrors.length) {
        errorUtils.sendMalformedRequestError(res, JSON.stringify(validationErrors));
        return;
      }

      let appId: string;
      let destDeployment: storageTypes.Deployment;
      let sourcePackage: storageTypes.Package;

      nameResolver
        .resolveApp(accountId, appName)
        .then((app: storageTypes.App) => {
          appId = app.id;
          throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
          // 소스 배포와 대상 배포의 매니페스트를 병렬로 가져옵니다.
          return q.all([
            nameResolver.resolveDeployment(accountId, appId, sourceDeploymentName),
            nameResolver.resolveDeployment(accountId, appId, destDeploymentName),
          ]);
        })
        .spread((sourceDeployment: storageTypes.Deployment, destinationDeployment: storageTypes.Deployment) => {
          destDeployment = destinationDeployment;

          // 특정 레이블을 지정한 경우 해당 레이블을 가진 패키지를 찾습니다.
          // 지정된 레이블이 없으면 소스 배포의 현재 패키지를 사용합니다.
          if (info.label) {
            return storage.getPackageHistory(accountId, appId, sourceDeployment.id).then((sourceHistory: storageTypes.Package[]) => {
              sourcePackage = getPackageFromLabel(sourceHistory, info.label);
            });
          } else {
            sourcePackage = sourceDeployment.package;
          }
        })
        .then(() => {
          const destPackage: storageTypes.Package = destDeployment.package;

          // 소스 배포에 패키지가 없는 경우 오류를 발생시킵니다.
          if (!sourcePackage) {
            throw errorUtils.restError(errorUtils.ErrorCode.NotFound, "Cannot promote from a deployment with no enabled releases.");
          } else if (validationUtils.isDefined(info.rollout) && !validationUtils.isValidRolloutField(info.rollout)) {
            // 롤아웃 값이 유효하지 않은 경우 오류를 발생시킵니다.
            throw errorUtils.restError(
              errorUtils.ErrorCode.MalformedRequest,
              "Rollout value must be an integer between 1 and 100, inclusive."
            );
          } else if (destPackage && isUnfinishedRollout(destPackage.rollout) && !destPackage.isDisabled) {
            // 대상 배포에 롤아웃이 진행중이고 비활성화되지 않은 경우 오류를 발생시킵니다.
            throw errorUtils.restError(
              errorUtils.ErrorCode.Conflict,
              "Cannot promote to an unfinished rollout release unless it is already disabled."
            );
          }

          // 대상 배포에 대한 패키지 이력을 가져옵니다.
          return storage.getPackageHistory(accountId, appId, destDeployment.id);
        })
        .then((destHistory: storageTypes.Package[]) => {
          // 소스 배포의 패키지 해시가 대상 배포의 패키지 이력에 존재하는 경우 오류를 발생시킵니다.
          if (sourcePackage.packageHash === getLastPackageHashWithSameAppVersion(destHistory, sourcePackage.appVersion)) {
            throw errorUtils.restError(
              errorUtils.ErrorCode.Conflict,
              "The uploaded package was not promoted because it is identical to the contents of the targeted deployment's current release."
            );
          }

          // 새로운 패키지 객체를 생성합니다.
          // 요청에 포함된 패키지 정보로 값을 설정합니다.
          // 프로모션 메타데이터를 추가합니다.(releaseMethod, originalLabel, originalDeployment)
          const isMandatory: boolean = validationUtils.isDefined(info.isMandatory) ? info.isMandatory : sourcePackage.isMandatory;
          const newPackage: storageTypes.Package = {
            appVersion: info.appVersion ? info.appVersion : sourcePackage.appVersion,
            blobUrl: sourcePackage.blobUrl,
            description: info.description || sourcePackage.description,
            isDisabled: validationUtils.isDefined(info.isDisabled) ? info.isDisabled : sourcePackage.isDisabled,
            isMandatory: isMandatory,
            manifestBlobUrl: sourcePackage.manifestBlobUrl,
            packageHash: sourcePackage.packageHash,
            rollout: info.rollout || null,
            size: sourcePackage.size,
            uploadTime: new Date().getTime(),
            releaseMethod: storageTypes.ReleaseMethod.Promote,
            originalLabel: sourcePackage.label,
            originalDeployment: sourceDeploymentName,
          };

          // 새로운 패키지를 대상 배포에 저장합니다.
          return storage
            .commitPackage(accountId, appId, destDeployment.id, newPackage)
            .then((committedPackage: storageTypes.Package): Promise<void> => {
              sourcePackage.label = committedPackage.label;
              const restPackage: restTypes.Package = converterUtils.toRestPackage(committedPackage);
              res.setHeader("Location", urlEncode([`/apps/${appName}/deployments/${destDeploymentName}`]));
              res.status(201).send({ package: restPackage });
              return invalidateCachedPackage(destDeployment.key);
            })
            // 차등 업데이트 정보를 생성합니다.
            .then(() => processDiff(accountId, appId, destDeployment.id, sourcePackage));
        })
        .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    }
  );

  // 특정 배포에서 이전 배포로 롤백합니다.
  router.post(
    "/apps/:appName/deployments/:deploymentName/rollback/:targetRelease",
    (req: Request, res: Response, next: (err?: any) => void): any => {
      const accountId: string = req.user.id;
      const appName: string = req.params.appName;
      const deploymentName: string = req.params.deploymentName;
      let appId: string;
      let deploymentToRollback: storageTypes.Deployment;
      const targetRelease: string = req.params.targetRelease;
      let destinationPackage: storageTypes.Package;

      nameResolver
        .resolveApp(accountId, appName)
        .then((app: storageTypes.App) => {
          appId = app.id;
          throwIfInvalidPermissions(app, storageTypes.Permissions.Collaborator);
          // 배포 객체를 찾습니다.
          return nameResolver.resolveDeployment(accountId, appId, deploymentName);
        })
        // 배포에 대한 패키지 이력을 가져옵니다.
        .then((deployment: storageTypes.Deployment): Promise<storageTypes.Package[]> => {
          deploymentToRollback = deployment;
          return storage.getPackageHistory(accountId, appId, deployment.id);
        })
        // 롤백 대상 패키지를 선택합니다.
        .then((packageHistory: storageTypes.Package[]) => {
          const sourcePackage: storageTypes.Package =
            packageHistory && packageHistory.length ? packageHistory[packageHistory.length - 1] : null;
          if (!sourcePackage) {
            errorUtils.sendNotFoundError(res, "Cannot perform rollback because there are no releases on this deployment.");
            return;
          }

          // 대상 릴리즈가 지정되지 않았다면 히스토리에서 두 번째 최신 패키지(이전 릴리즈)를 선택합니다.
          if (!targetRelease) {
            destinationPackage = packageHistory[packageHistory.length - 2];

            if (!destinationPackage) {
              errorUtils.sendNotFoundError(res, "Cannot perform rollback because there are no prior releases to rollback to.");
              return;
            }
          } else {
            // 대상 릴리즈가 지정되었고 최신 릴리즈와 같은 경우 오류를 발생시킵니다.
            if (targetRelease === sourcePackage.label) {
              errorUtils.sendConflictError(
                res,
                `Cannot perform rollback because the target release (${targetRelease}) is already the latest release.`
              );
              return;
            }

            // 히스토리에서 해당 라벨의 패키지를 찾습니다.
            packageHistory.forEach((packageEntry: storageTypes.Package) => {
              if (packageEntry.label === targetRelease) {
                destinationPackage = packageEntry;
              }
            });

            // 대상 릴리즈를 가진 패키지를 찾지 못한 경우 오류를 발생시킵니다.
            if (!destinationPackage) {
              errorUtils.sendNotFoundError(
                res,
                `Cannot perform rollback because the target release (${targetRelease}) could not be found in the deployment history.`
              );
              return;
            }
          }

          // 현재 패키지와 롤백 대상 패키지의 앱 버전이 다른 경우 오류를 발생시킵니다.
          if (sourcePackage.appVersion !== destinationPackage.appVersion) {
            errorUtils.sendConflictError(
              res,
              "Cannot perform rollback to a different app version. Please perform a new release with the desired replacement package."
            );
            return;
          }

          // 새로운 패키지 객체를 생성합니다.
          // 롤백 대상 패키지의 정보를 사용하여 값을 설정합니다.
          const newPackage: storageTypes.Package = {
            appVersion: destinationPackage.appVersion,
            blobUrl: destinationPackage.blobUrl,
            description: destinationPackage.description,
            diffPackageMap: destinationPackage.diffPackageMap,
            isDisabled: destinationPackage.isDisabled,
            isMandatory: destinationPackage.isMandatory,
            manifestBlobUrl: destinationPackage.manifestBlobUrl,
            packageHash: destinationPackage.packageHash,
            size: destinationPackage.size,
            uploadTime: new Date().getTime(),
            releaseMethod: storageTypes.ReleaseMethod.Rollback,
            originalLabel: destinationPackage.label,
          };

          // 새로운 패키지를 대상 배포에 저장합니다.
          return storage.commitPackage(accountId, appId, deploymentToRollback.id, newPackage).then((): Promise<void> => {
            const restPackage: restTypes.Package = converterUtils.toRestPackage(newPackage);
            res.setHeader("Location", urlEncode([`/apps/${appName}/deployments/${deploymentName}`]));
            res.status(201).send({ package: restPackage });
            return invalidateCachedPackage(deploymentToRollback.key);
          });
        })
        .catch((error: error.CodePushError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    }
  );

  /**
   * 주어진 배포 키에 대한 캐시를 무효화합니다.
   * @param deploymentKey 배포 키
   * @returns 무효화된 캐시
   */
  function invalidateCachedPackage(deploymentKey: string): q.Promise<void> {
    return redisManager.invalidateCache(redis.Utilities.getDeploymentKeyHash(deploymentKey));
  }

  /**
   * 주어진 앱과 필요한 권한을 확인하고, 권한이 없는 경우 오류를 발생시킵니다.
   * @param app 앱 객체
   * @param requiredPermission 필요한 권한
   * @returns 권한이 있는 경우 true, 권한이 없는 경우 false
   */
  function throwIfInvalidPermissions(app: storageTypes.App, requiredPermission: string): boolean {
    const collaboratorsMap: storageTypes.CollaboratorMap = app.collaborators;

    let isPermitted: boolean = false;

    if (collaboratorsMap) {
      for (const email of Object.keys(collaboratorsMap)) {
        if ((<storageTypes.CollaboratorProperties>collaboratorsMap[email]).isCurrentAccount) {
          const permission: string = collaboratorsMap[email].permission;
          isPermitted = permission === storageTypes.Permissions.Owner || permission === requiredPermission;
          break;
        }
      }
    }

    if (!isPermitted)
      throw errorUtils.restError(
        errorUtils.ErrorCode.Unauthorized,
        "This action requires " + requiredPermission + " permissions on the app!"
      );

    return true;
  }

  /**
   * 주어진 레이블과 일치하는 패키지를 반환합니다.
   * @param history 패키지 이력 목록
   * @param label 레이블
   * @returns 일치하는 패키지 또는 null
   */
  function getPackageFromLabel(history: storageTypes.Package[], label: string): storageTypes.Package {
    if (!history) {
      return null;
    }

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].label === label) {
        return history[i];
      }
    }

    return null;
  }

  /**
   * 주어진 앱 버전과 일치하는 패키지의 패키지 해시를 반환합니다.
   * @param history 패키지 이력 목록
   * @param appVersion 앱 버전
   * @returns 일치하는 패키지의 패키지 해시 또는 null
   */
  function getLastPackageHashWithSameAppVersion(history: storageTypes.Package[], appVersion: string): string {
    if (!history || !history.length) {
      return null;
    }

    const lastPackageIndex: number = history.length - 1;
    if (!semver.valid(appVersion)) {
      // appVersion is a range
      const oldAppVersion: string = history[lastPackageIndex].appVersion;
      const oldRange: string = semver.validRange(oldAppVersion);
      const newRange: string = semver.validRange(appVersion);
      return oldRange === newRange ? history[lastPackageIndex].packageHash : null;
    } else {
      // appVersion is not a range
      for (let i = lastPackageIndex; i >= 0; i--) {
        if (semver.satisfies(appVersion, history[i].appVersion)) {
          return history[i].packageHash;
        }
      }
    }

    return null;
  }

  /**
   * 패키지 차이 정보를 추가합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @param appPackage 앱 패키지
   * @param diffPackageMap 패키지 차이 정보
   */
  function addDiffInfoForPackage(
    accountId: string,
    appId: string,
    deploymentId: string,
    appPackage: storageTypes.Package,
    diffPackageMap: storageTypes.PackageHashToBlobInfoMap
  ) {
    let updateHistory: boolean = false;

    return storage
      .getApp(accountId, appId)
      .then((storageApp: storageTypes.App) => {
        throwIfInvalidPermissions(storageApp, storageTypes.Permissions.Collaborator);
        return storage.getPackageHistory(accountId, appId, deploymentId);
      })
      .then((history: storageTypes.Package[]) => {
        if (history) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].label === appPackage.label && !history[i].diffPackageMap) {
              history[i].diffPackageMap = diffPackageMap;
              updateHistory = true;
              break;
            }
          }

          if (updateHistory) {
            return storage.updatePackageHistory(accountId, appId, deploymentId, history);
          }
        }
      })
      .then(() => {
        if (updateHistory) {
          return storage.getDeployment(accountId, appId, deploymentId).then((deployment: storageTypes.Deployment) => {
            return invalidateCachedPackage(deployment.key);
          });
        }
      })
      .catch(diffErrorUtils.diffErrorHandler);
  }

  /**
   * 패키지 간의 차이점을 처리합니다.
   * @param accountId 계정 ID
   * @param appId 앱 ID
   * @param deploymentId 배포 ID
   * @param appPackage 앱 패키지
   * @returns 패키지 차이 처리 결과
   */
  function processDiff(accountId: string, appId: string, deploymentId: string, appPackage: storageTypes.Package): q.Promise<void> {
    if (!appPackage.manifestBlobUrl || process.env.ENABLE_PACKAGE_DIFFING) {
      // 차이점 처리가 필요하지 않은 경우:
      //   1. 단일 파일만 포함된 릴리스
      //   2. 차이점 처리가 비활성화된 경우
      return q(<void>null);
    }

    console.log(`Processing package: ${appPackage.label}`);

    return packageDiffing
      .generateDiffPackageMap(accountId, appId, deploymentId, appPackage)
      .then((diffPackageMap: storageTypes.PackageHashToBlobInfoMap) => {
        console.log(`Package processed, adding diff info`);
        addDiffInfoForPackage(accountId, appId, deploymentId, appPackage, diffPackageMap);
      });
  }

  return router;
}
