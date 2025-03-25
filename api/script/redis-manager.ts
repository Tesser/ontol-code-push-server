// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as dotenv from 'dotenv';
import * as q from "q";
import * as redis from "redis";

import Promise = q.Promise;
dotenv.config();

export const DEPLOYMENT_SUCCEEDED = "DeploymentSucceeded";
export const DEPLOYMENT_FAILED = "DeploymentFailed";
export const ACTIVE = "Active";
export const DOWNLOADED = "Downloaded";

export interface CacheableResponse {
  statusCode: number;
  body: any;
}

export interface DeploymentMetrics {
  [labelStatus: string]: number;
}

export const Utilities = {
  isValidDeploymentStatus(status: string): boolean {
    return status === DEPLOYMENT_SUCCEEDED || status === DEPLOYMENT_FAILED || status === DOWNLOADED;
  },

  getLabelStatusField(label: string, status: string): string {
    if (this.isValidDeploymentStatus(status)) {
      return label + ":" + status;
    } else {
      return null;
    }
  },

  getLabelActiveCountField(label: string): string {
    if (label) {
      return label + ":" + ACTIVE;
    } else {
      return null;
    }
  },

  getDeploymentKeyHash(deploymentKey: string): string {
    return "deploymentKey:" + deploymentKey;
  },

  getDeploymentKeyLabelsHash(deploymentKey: string): string {
    return "deploymentKeyLabels:" + deploymentKey;
  },

  getDeploymentKeyClientsHash(deploymentKey: string): string {
    return "deploymentKeyClients:" + deploymentKey;
  }
} as const;


class PromisifiedRedisClient {
  // An incomplete set of promisified versions of the original redis methods
  public del: (...key: string[]) => Promise<number> = null;
  public execBatch: (redisBatchClient: any) => Promise<any[]> = null;
  public exists: (...key: string[]) => Promise<number> = null;
  public expire: (key: string, seconds: number) => Promise<number> = null;
  public hdel: (key: string, field: string) => Promise<number> = null;
  public hget: (key: string, field: string) => Promise<string> = null;
  public hgetall: (key: string) => Promise<any> = null;
  public hincrby: (key: string, field: string, value: number) => Promise<number> = null;
  public hset: (key: string, field: string, value: string) => Promise<number> = null;
  public ping: (payload?: any) => Promise<any> = null;
  public quit: () => Promise<void> = null;
  public select: (databaseNumber: number) => Promise<void> = null;
  public set: (key: string, value: string) => Promise<void> = null;

  constructor(redisClient: redis.RedisClient) {
    this.execBatch = (redisBatchClient: any) => {
      return q.ninvoke<any[]>(redisBatchClient, "exec");
    };

    for (const functionName in this) {
      if (this.hasOwnProperty(functionName) && (<any>this)[functionName] === null) {
        const originalFunction = (<any>redisClient)[functionName];
        assert(!!originalFunction, "Binding a function that does not exist: " + functionName);
        (<any>this)[functionName] = q.nbind(originalFunction, redisClient);
      }
    }
  }
}

/**
 * Redis 클라이언트 관리
*/
export class RedisManager {
  private static DEFAULT_EXPIRY: number = 3600; // one hour, specified in seconds
  private static METRICS_DB: number = 1;
  
  private _opsClient: redis.RedisClient;
  private _promisifiedOpsClient: PromisifiedRedisClient;
  private _metricsClient: redis.RedisClient;
  private _promisifiedMetricsClient: PromisifiedRedisClient;
  private _setupMetricsClientPromise: Promise<void>;
  
  /**
   * 환경 변수에서 Redis 호스트, 포트, 키 정보를 가져와 운영용과 메트릭용 두 개의 Redis 클라이언트를 생성합니다.
   */
  constructor() {
    if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
      const redisConfig = {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
        auth_pass: process.env.REDIS_KEY,
        tls: {
          // Note: Node defaults CA's to those trusted by Mozilla
          rejectUnauthorized: true,
        },
      };
      this._opsClient = redis.createClient(redisConfig);
      this._metricsClient = redis.createClient(redisConfig);
      this._opsClient.on("error", (err: Error) => {
        console.error(err);
      });

      this._metricsClient.on("error", (err: Error) => {
        console.error(err);
      });

      this._promisifiedOpsClient = new PromisifiedRedisClient(this._opsClient);
      this._promisifiedMetricsClient = new PromisifiedRedisClient(this._metricsClient);
      this._setupMetricsClientPromise = this._promisifiedMetricsClient
        .select(RedisManager.METRICS_DB)
        .then(() => this._promisifiedMetricsClient.set("health", "health"));
    } else {
      console.warn("No REDIS_HOST or REDIS_PORT environment variable configured.");
    }
  }

  /**
   * Redis 클라이언트가 활성화되었는지 여부를 확인합니다.
   * @returns `boolean` Redis 클라이언트가 활성화되었는지 여부
   */
  public get isEnabled(): boolean {
    return !!this._opsClient && !!this._metricsClient;
  }

  /**
   * Redis 클라이언트의 상태를 확인합니다.
   * @returns `Promise<void>` Redis 클라이언트의 상태
   */
  public checkHealth(): Promise<void> {
    if (!this.isEnabled) {
      return q.reject<void>("Redis manager is not enabled");
    }

    return q.all([this._promisifiedOpsClient.ping(), this._promisifiedMetricsClient.ping()]).spread<void>(() => {});
  }

  /**
   * API 요청에 대한 응답을 Redis 캐시에서 조회하여, 동일한 요청이 반복될 때 데이터베이스 조회를 줄이고 응답 시간을 개선합니다.
   * @param expiryKey: 캐시된 응답을 가져오기 위한 식별자
   * @param url: 캐시할 요청의 URL
   * @return 형식 CacheableResponse의 객체
   */
  public getCachedResponse(expiryKey: string, url: string): Promise<CacheableResponse> {
    // Redis가 비활성화되었거나 초기화되지 않은 경우 캐시 없이 항상 원본 데이터를 반환합니다.
    if (!this.isEnabled) {
      return q<CacheableResponse>(null);
    }

    // Redis의 해시 데이터 구조에서 주어진 키와 URL에 해당하는 값을 조회합니다.
    // expiryKey는 해시 테이블의 이름으로 사용됩니다. (예: 배포 키의 해시)
    // url은 해시 테이블 내의 필드 이름으로 사용됩니다.
    return this._promisifiedOpsClient.hget(expiryKey, url).then((serializedResponse: string): Promise<CacheableResponse> => {
      if (serializedResponse) {
        // 캐시된 응답이 있으면 JSON 문자열을 JS 객체로 파싱하여 반환합니다.
        const response = <CacheableResponse>JSON.parse(serializedResponse);
        return q<CacheableResponse>(response);
      } else {
        // 캐시된 응답이 없으면 null을 반환하여 캐시 미스를 나타냅니다.
        return q<CacheableResponse>(null);
      }
    });
  }

  /**
   * API 응답을 Redis 캐시에 저장합니다.
   * @param expiryKey: 캐시된 응답을 가져오기 위한 식별자
   * @param url: 캐시할 요청의 URL
   * @param response: 캐시할 응답
   */
  public setCachedResponse(expiryKey: string, url: string, response: CacheableResponse): Promise<void> {
    if (!this.isEnabled) {
      return q<void>(null);
    }

    // 캐시에 응답을 저장하고 시간 제한 만료 기간을 설정합니다.
    const serializedResponse: string = JSON.stringify(response);
    let isNewKey: boolean;
    return this._promisifiedOpsClient
      .exists(expiryKey)
      .then((isExisting: number) => {
        isNewKey = !isExisting;
        return this._promisifiedOpsClient.hset(expiryKey, url, serializedResponse);
      })
      .then(() => {
        if (isNewKey) {
          return this._promisifiedOpsClient.expire(expiryKey, RedisManager.DEFAULT_EXPIRY);
        }
      })
      .then(() => {});
  }

  /**
   * 특정 배포 키, 라벨, 상태에 대한 카운터를 증가시킵니다.
   * - 배포 상태 메트릭을 추적하는 데 사용됩니다.
   * @param deploymentKey: 배포 키
   * @param label: 레이블
   * @param status: 상태
   */
  public incrementLabelStatusCount(deploymentKey: string, label: string, status: string): Promise<void> {
    if (!this.isEnabled) {
      return q(<void>null);
    }

    const hash: string = Utilities.getDeploymentKeyLabelsHash(deploymentKey);
    const field: string = Utilities.getLabelStatusField(label, status);

    return this._setupMetricsClientPromise.then(() => this._promisifiedMetricsClient.hincrby(hash, field, 1)).then(() => {});
  }

  /**
   * 특정 배포 키에 대한 모든 메트릭을 삭제합니다.
   * - 배포 키 관련 라벨과 클라이언트 해시를 삭제합니다.
   * @param deploymentKey: 배포 키
   */
  public clearMetricsForDeploymentKey(deploymentKey: string): Promise<void> {
    if (!this.isEnabled) {
      return q(<void>null);
    }

    return this._setupMetricsClientPromise
      .then(() =>
        this._promisifiedMetricsClient.del(
          Utilities.getDeploymentKeyLabelsHash(deploymentKey),
          Utilities.getDeploymentKeyClientsHash(deploymentKey)
        )
      )
      .then(() => {});
  }

  /**
   * 특정 배포 키에 대한 모든 메트릭을 조회합니다.
   * - 배포 성공, 실패, 활성 사용자 수 등의 메트릭을 반환합니다.
   * @param deploymentKey: 배포 키
   * @returns `Promise<DeploymentMetrics>` 배포 키에 대한 모든 메트릭
   */
  public getMetricsWithDeploymentKey(deploymentKey: string): Promise<DeploymentMetrics> {
    if (!this.isEnabled) {
      return q(<DeploymentMetrics>null);
    }

    return this._setupMetricsClientPromise
      .then(() => this._promisifiedMetricsClient.hgetall(Utilities.getDeploymentKeyLabelsHash(deploymentKey)))
      .then((metrics) => {
        // Redis는 숫자 값을 문자열로 반환하므로 여기서 파싱을 처리합니다.
        if (metrics) {
          Object.keys(metrics).forEach((metricField) => {
            if (!isNaN(metrics[metricField])) {
              metrics[metricField] = +metrics[metricField];
            }
          });
        }

        return <DeploymentMetrics>metrics;
      });
  }

  /**
   * 현재 배포 키와 라벨을 기록하고, 이전 배포 키와 라벨을 선택적으로 업데이트합니다.
   * - 앱 업데이트 정보를 기록합니다.
   * - 현재 배포 키의 활성 카운트와 성공 카운트를 증가시키고, 이전 배포 키가 있으면 해당 활성 카운트를 감소시킵니다.
   * @param currentDeploymentKey: 현재 배포 키
   * @param currentLabel: 현재 라벨
   * @param previousDeploymentKey: 이전 배포 키
   * @param previousLabel: 이전 라벨
   */
  public recordUpdate(currentDeploymentKey: string, currentLabel: string, previousDeploymentKey?: string, previousLabel?: string) {
    if (!this.isEnabled) {
      return q(<void>null);
    }

    return this._setupMetricsClientPromise
      .then(() => {
        const batchClient: any = (<any>this._metricsClient).batch();
        const currentDeploymentKeyLabelsHash: string = Utilities.getDeploymentKeyLabelsHash(currentDeploymentKey);
        const currentLabelActiveField: string = Utilities.getLabelActiveCountField(currentLabel);
        const currentLabelDeploymentSucceededField: string = Utilities.getLabelStatusField(currentLabel, DEPLOYMENT_SUCCEEDED);
        batchClient.hincrby(currentDeploymentKeyLabelsHash, currentLabelActiveField, /* incrementBy */ 1);
        batchClient.hincrby(currentDeploymentKeyLabelsHash, currentLabelDeploymentSucceededField, /* incrementBy */ 1);

        if (previousDeploymentKey && previousLabel) {
          const previousDeploymentKeyLabelsHash: string = Utilities.getDeploymentKeyLabelsHash(previousDeploymentKey);
          const previousLabelActiveField: string = Utilities.getLabelActiveCountField(previousLabel);
          batchClient.hincrby(previousDeploymentKeyLabelsHash, previousLabelActiveField, /* incrementBy */ -1);
        }

        return this._promisifiedMetricsClient.execBatch(batchClient);
      })
      .then(() => {});
  }

  /**
   * 특정 배포 키에 대한 클라이언트의 활성 라벨을 제거합니다.
   * - 특정 클라이언트 ID에 대한 배포 키 연결을 삭제합니다.
   * @param deploymentKey: 배포 키
   * @param clientUniqueId: 고유 클라이언트 ID
   */
  public removeDeploymentKeyClientActiveLabel(deploymentKey: string, clientUniqueId: string) {
    if (!this.isEnabled) {
      return q(<void>null);
    }

    return this._setupMetricsClientPromise
      .then(() => {
        const deploymentKeyClientsHash: string = Utilities.getDeploymentKeyClientsHash(deploymentKey);
        return this._promisifiedMetricsClient.hdel(deploymentKeyClientsHash, clientUniqueId);
      })
      .then(() => {});
  }

  /**
   * 캐시 데이터를 무효화합니다.
   * @param expiryKey: 캐시된 응답을 가져오기 위한 식별자
   */
  public invalidateCache(expiryKey: string): Promise<void> {
    if (!this.isEnabled) return q(<void>null);

    return this._promisifiedOpsClient.del(expiryKey).then(() => {});
  }

  /**
   * Redis 연결을 종료합니다.
   * - 단위 테스트에만 사용됩니다.
   */
  public close(): Promise<void> {
    const promiseChain: Promise<void> = q(<void>null);
    if (!this._opsClient && !this._metricsClient) return promiseChain;

    return promiseChain
      .then(() => this._opsClient && this._promisifiedOpsClient.quit())
      .then(() => this._metricsClient && this._promisifiedMetricsClient.quit())
      .then(() => <void>null);
  }

  /**
   * 특정 배포 키에 대한 클라이언트의 현재 활성 라벨을 조회합니다.
   * @param deploymentKey: 배포 키
   * @param clientUniqueId: 고유 클라이언트 ID
   * @returns `Promise<string>` 현재 활성 라벨
   */
  public getCurrentActiveLabel(deploymentKey: string, clientUniqueId: string): Promise<string> {
    if (!this.isEnabled) {
      return q(<string>null);
    }

    return this._setupMetricsClientPromise.then(() =>
      this._promisifiedMetricsClient.hget(Utilities.getDeploymentKeyClientsHash(deploymentKey), clientUniqueId)
    );
  }

  /**
   * 특정 배포 키에 대한 클라이언트의 현재 활성 라벨을 업데이트합니다.
   * @param deploymentKey: 배포 키
   * @param clientUniqueId: 고유 클라이언트 ID
   * @param toLabel: 새로운 라벨
   * @param fromLabel: 이전 라벨
   */
  public updateActiveAppForClient(deploymentKey: string, clientUniqueId: string, toLabel: string, fromLabel?: string): Promise<void> {
    if (!this.isEnabled) {
      return q(<void>null);
    }

    return this._setupMetricsClientPromise
      .then(() => {
        const batchClient: any = (<any>this._metricsClient).batch();
        const deploymentKeyLabelsHash: string = Utilities.getDeploymentKeyLabelsHash(deploymentKey);
        const deploymentKeyClientsHash: string = Utilities.getDeploymentKeyClientsHash(deploymentKey);
        const toLabelActiveField: string = Utilities.getLabelActiveCountField(toLabel);

        batchClient.hset(deploymentKeyClientsHash, clientUniqueId, toLabel);
        batchClient.hincrby(deploymentKeyLabelsHash, toLabelActiveField, /* incrementBy */ 1);
        if (fromLabel) {
          const fromLabelActiveField: string = Utilities.getLabelActiveCountField(fromLabel);
          batchClient.hincrby(deploymentKeyLabelsHash, fromLabelActiveField, /* incrementBy */ -1);
        }

        return this._promisifiedMetricsClient.execBatch(batchClient);
      })
      .then(() => {});
  }
}
