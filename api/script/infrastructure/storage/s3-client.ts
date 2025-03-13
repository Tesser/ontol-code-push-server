// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as q from "q";
import * as stream from "stream";
import * as storage from "../storage";
import { StorageKeys } from "../storage-keys";

export class CustomS3Client {
  private static BUCKET_NAME = "ontol-code-push";
  private static HISTORY_PREFIX = "history/";
  private static BLOB_PREFIX = "blob/";

  private _s3Client: S3Client;
  private _setupPromise: q.Promise<void>;
  private _region: string;

  private _cloudFrontClient: CloudFrontClient;
  private _cloudFrontDistributionId: string;
  private _useCloudFront: boolean = false;

  /**
   * S3 클라이언트 생성자
   * @param region 지역 코드 (기본값: process.env.AWS_REGION)
   * @param accessKeyId AWS 액세스 키 ID (기본값: process.env.AWS_ACCESS_KEY_ID)
   * @param secretAccessKey AWS 비밀 액세스 키 (기본값: process.env.AWS_SECRET_ACCESS_KEY)
   * @param cloudFrontDistributionId CloudFront 배포 ID (기본값: process.env.CLOUDFRONT_DISTRIBUTION_ID)
   */
  constructor(region?: string, accessKeyId?: string, secretAccessKey?: string, cloudFrontDistributionId?: string) {
    const _region = region ?? process.env.AWS_REGION ?? "ap-northeast-2";
    const _accessKeyId = accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    const _secretAccessKey = secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;

    if (!_accessKeyId || !_secretAccessKey) {
      throw new Error("AWS credentials not set");
    }

    this._region = _region;
    this._s3Client = new S3Client({
      region: _region,
      credentials: {
        accessKeyId: _accessKeyId,
        secretAccessKey: _secretAccessKey,
      },
    });

    this._cloudFrontDistributionId = cloudFrontDistributionId ?? process.env.CLOUDFRONT_DISTRIBUTION_ID;
    this._useCloudFront = !!this._cloudFrontDistributionId;

    // CloudFront 클라이언트 생성
    if (this._useCloudFront) {
      this._cloudFrontClient = new CloudFrontClient({
        region: _region,
        credentials: {
          accessKeyId: _accessKeyId,
          secretAccessKey: _secretAccessKey,
        },
      });
    }

    this._setupPromise = this.setup();
  }

  /**
   * S3 버킷 설정
   * @returns 설정 완료 Promise
   */
  private setup(): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      // 버킷 존재 여부 확인 및 생성
      const checkAndCreateBucket = async (bucketName: string) => {
        try {
          // 버킷의 존재 여부를 확인합니다.
          await this._s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        } catch (error) {
          if (error.name === "NotFound") {
            // 버킷이 존재하지 않는 경우 버킷을 생성합니다.
            await this._s3Client.send(
              new CreateBucketCommand({
                Bucket: bucketName,
                CreateBucketConfiguration: {
                  LocationConstraint: "ap-northeast-2",
                },
              })
            );
          } else {
            throw error;
          }
        }
      };

      checkAndCreateBucket(CustomS3Client.BUCKET_NAME)
        .then(() => {
          //
          return Promise.all([
            // blob, history 헬스 체크
            this.uploadString(CustomS3Client.BUCKET_NAME, CustomS3Client.BLOB_PREFIX + StorageKeys.getHealthCheckKey(), "health"),
            this.uploadString(CustomS3Client.BUCKET_NAME, CustomS3Client.HISTORY_PREFIX + StorageKeys.getHealthCheckKey(), "health"),
          ]);
        })
        .then(() => resolve())
        .catch((error) => reject(error));
    });
  }

  /**
   * S3 버킷 헬스 체크
   * @returns 헬스 체크 완료 Promise
   */
  public checkHealth(): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        Promise.all([
          this.healthCheck(CustomS3Client.BUCKET_NAME, CustomS3Client.BLOB_PREFIX + StorageKeys.getHealthCheckKey()),
          this.healthCheck(CustomS3Client.BUCKET_NAME, CustomS3Client.HISTORY_PREFIX + StorageKeys.getHealthCheckKey()),
        ])
          .then(() => resolve())
          .catch((error) => reject(error));
      });
    });
  }

/**
 * S3 버킷의 특정 키에 대한 헬스 체크를 위한 함수입니다.
 * - `health` 문자열이 저장되어 있는지 확인하여 스토리지 시스템의 정상 작동 여부를 검증합니다.
 * 
 * @param bucketName - 확인할 S3 버킷 이름
 * @param key - 확인할 객체의 키 값
 * @returns 헬스 체크 성공 결과 
 * @throws {StorageError} 저장된 값이 "health"가 아니거나 접근에 실패한 경우 ConnectionFailed 에러 발생
 */
  private healthCheck(bucketName: string, key: string): Promise<void> {
    return this._s3Client
      .send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      )
      .then(async (response) => {
        const bodyContents = await response.Body.transformToString();
        if (bodyContents !== "health") {
          throw storage.storageError(
            storage.ErrorCode.ConnectionFailed,
            "The AWS S3 service failed the health check for " + bucketName
          );
        }
      });
  }

  /**
   * 헬스 체크를 위해 간단한 문자열을 업로드합니다.
   * - 버킷 접근 가능 여부, 쓰기 권한 정상 동작 여부, 전반적인 스토리지 시스템 작동 여부를 확인합니다.
   * @param bucketName 버킷 이름
   * @param key 키
   * @param content 업로드할 문자열
   * @returns 업로드 완료 Promise
   */
  public uploadString(bucketName: string, key: string, content: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._s3Client
          .send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: content,
            })
          )
          .then(() => resolve())
          .catch((error) => reject(this.handleS3Error(error)));
      });
    });
  }

  /**
   * 스트림 형태의 데이터를 S3에 업로드합니다.
   * @param bucketName 버킷 이름
   * @param key 키
   * @param stream 업로드할 스트림
   * @param contentLength 스트림 길이
   * @returns 업로드 완료 Promise
   */
  public uploadStream(bucketName: string, key: string, stream: stream.Readable, contentLength: number): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        // 스트림을 버퍼로 변환하여 S3에 업로드합니다.
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => {
          const buffer = Buffer.concat(chunks);

          this._s3Client
            .send(
              new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: buffer,
                // 업로드할 데이터의 크기를 미리 지정합니다.
                ContentLength: contentLength,
              })
            )
            .then(() => resolve())
            .catch((error) => reject(this.handleS3Error(error)));
        });
        stream.on("error", (error) => reject(error));
      });
    });
  }

  /**
   * 문자열 형태의 데이터를 S3에서 다운로드합니다.
   * @param bucketName 버킷 이름
   * @param key 키
   * @returns 다운로드 완료 Promise
   */
  public downloadString(bucketName: string, key: string): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        this._s3Client
          .send(
            // 지정된 키에 해당하는 객체를 다운로드합니다.
            new GetObjectCommand({
              Bucket: bucketName,
              Key: key,
            })
          )
          .then(async (response) => {
            const bodyContents = await response.Body.transformToString();
            resolve(bodyContents);
          })
          .catch((error) => reject(this.handleS3Error(error)));
      });
    });
  }

  /**
   * 지정된 키에 해당하는 객체를 삭제합니다.
   * @param bucketName 버킷 이름
   * @param key 키
   * @returns 삭제 완료 Promise
   */
  public deleteObject(bucketName: string, key: string): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        this._s3Client
          .send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: key,
            })
          )
          .then(() => resolve())
          .catch((error) => reject(this.handleS3Error(error)));
      });
    });
  }

  /**
   * Signed URL을 생성하여 특정 객체에 일시적으로 접근할 수 있도록 합니다.
   * @param bucketName 버킷 이름
   * @param key 키
   * @param expiresIn 만료 시간 (기본값: 3600초)
   * @returns Signed URL
   */
  public getSignedUrl(bucketName: string, key: string, expiresIn: number = 3600): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        // S3에서 객체(파일)를 가져옵니다.
        const command = new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        });

        getSignedUrl(this._s3Client, command, { expiresIn })
          .then((url) => resolve(url))
          .catch((error) => reject(this.handleS3Error(error)));
      });
    });
  }

  /**
   * 패키지 히스토리를 S3에 저장합니다.
   * @param deploymentId 배포 ID
   * @param packageHistory 패키지 히스토리
   * @returns 저장 완료 Promise
   */
  public savePackageHistory(deploymentId: string, packageHistory: storage.Package[]): q.Promise<void> {
    const key = CustomS3Client.HISTORY_PREFIX + StorageKeys.getPackageHistoryBlobId(deploymentId);
    const content = JSON.stringify(packageHistory);

    return this.uploadString(CustomS3Client.BUCKET_NAME, key, content);
  }

  /**
   * 패키지 히스토리를 S3에서 로드합니다.
   * @param deploymentId 배포 ID
   * @returns 로드 완료 Promise
   */
  public loadPackageHistory(deploymentId: string): q.Promise<storage.Package[]> {
    const key = CustomS3Client.HISTORY_PREFIX + StorageKeys.getPackageHistoryBlobId(deploymentId);

    return this.downloadString(CustomS3Client.BUCKET_NAME, key)
      .then((content) => {
        try {
          return JSON.parse(content);
        } catch (e) {
          return [];
        }
      })
      .catch(() => {
        // 히스토리가 없으면 빈 배열을 반환합니다.
        return [];
      });
  }

  /**
   * AWS CloudFront CDN을 통한 URL을 생성합니다.
   * @param blobId 
   * @returns CloudFront URL
   */
  public getCloudFrontUrl(blobId: string): q.Promise<string> {
    return this._setupPromise.then(() => {
      if (!this._useCloudFront) {
        // CloudFront가 설정되지 않은 경우 일반 S3 URL을 반환합니다.
        return this.getBlobUrl(blobId);
      }

      // 도메인이 설정되지 않은 경우 일반 S3 URL을 반환합니다.
      const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
      if (!cloudFrontDomain) {
        return this.getBlobUrl(blobId);
      }

      // CloudFront가 설정된 경우 CDN Url을 생성합니다.
      return q.Promise<string>((resolve) => {
        const url = `https://${cloudFrontDomain}/${blobId}`;
        resolve(url);
      });
    });
  }

  /**
   * CloudFront 캐시를 무효화합니다.
   * - 콘텐츠가 업데이트 된 경우
   * - 오래된 캐시를 강제로 삭제하고 최신 콘텐츠를 즉시 반영하고 싶은 경우
   * @param paths 무효화할 경로 배열
   * @returns 무효화 완료 Promise
   */
  public invalidateCache(paths: string[]): q.Promise<void> {
    if (!this._useCloudFront) {
      return q(<void>null);
    }

    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        // CloudFront 캐시 무효화 요청
        const invalidationParams = {
          DistributionId: this._cloudFrontDistributionId,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: paths.length,
              Items: paths,
            },
          },
        };

        this._cloudFrontClient
          .send(new CreateInvalidationCommand(invalidationParams))
          .then(() => resolve())
          .catch((error) => reject(this.handleS3Error(error)));
      });
    });
  }

  /**
   * 블롭 파일을 추가합니다.
   * @param blobId 블롭 ID
   * @param stream 업로드할 스트림
   * @param streamLength 스트림 길이
   * @returns 추가 완료 Promise
   */
  public addBlob(blobId: string, stream: stream.Readable, streamLength: number): q.Promise<string> {
    const key = CustomS3Client.BLOB_PREFIX + blobId;
    return this.uploadStream(CustomS3Client.BUCKET_NAME, key, stream, streamLength).then(() => {
      // 새 객체가 업로드되면 관련 CloudFront 캐시를 무효화합니다.
      if (this._useCloudFront) {
        return this.invalidateCache(["/" + key]).then(() => blobId);
      }
      return blobId;
    });
  }

  /**
   * 블롭 파일의 URL을 가져옵니다.
   * @param blobId 블롭 ID
   * @returns 블롭 파일 URL
   */
  public getBlobUrl(blobId: string): q.Promise<string> {
    const key = CustomS3Client.BLOB_PREFIX + blobId;
    // CloudFront가 활성화된 경우 CloudFront URL을 반환합니다.
    if (this._useCloudFront) {
      return this.getCloudFrontUrl(key);
    }

    // CloudFront가 활성화되지 않은 경우 기존 S3 URL을 반환합니다.
    return this.getSignedUrl(CustomS3Client.BUCKET_NAME, key);
  }

  /**
   * 블롭 파일을 삭제합니다.
   * @param blobId 블롭 ID
   * @returns 삭제 완료 Promise
   */
  public removeBlob(blobId: string): q.Promise<void> {
    const key = CustomS3Client.BLOB_PREFIX + blobId;
    return this.deleteObject(CustomS3Client.BUCKET_NAME, key);
  }

  /**
   * S3 에러 처리
   * @param error 에러 객체
   * @returns 에러 처리 결과
   */
  private handleS3Error(error: any): any {
    let errorCode: storage.ErrorCode;

    if (error.name === "NoSuchKey" || error.name === "NotFound") {
      errorCode = storage.ErrorCode.NotFound;
    } else if (error.name === "EntityTooLarge") {
      errorCode = storage.ErrorCode.TooLarge;
    } else if (error.name === "AccessDenied") {
      errorCode = storage.ErrorCode.Invalid;
    } else if (error.name === "NetworkingError" || error.name === "TimeoutError") {
      errorCode = storage.ErrorCode.ConnectionFailed;
    } else {
      errorCode = storage.ErrorCode.Other;
    }

    return storage.storageError(errorCode, error.message);
  }

  /**
   * S3 클라이언트 반환
   * @returns S3 클라이언트
   */
  public getS3Client(): S3Client {
    return this._s3Client;
  }

  /**
   * 설정 프로미스 반환
   * @returns 설정 프로미스
   */
  public getSetupPromise(): q.Promise<void> {
    return this._setupPromise;
  }
}
