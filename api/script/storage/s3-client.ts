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
import * as storage from "./storage";
import { StorageKeys } from "./storage-keys";

export class CustomS3Client {
  private static HISTORY_BLOB_BUCKET_NAME = "packagehistoryv1";
  private static BLOB_BUCKET_NAME = "storagev2";
  private static MAX_PACKAGE_HISTORY_LENGTH = 50;

  private _s3Client: S3Client;
  private _setupPromise: q.Promise<void>;
  private _region: string;

  private _cloudFrontClient: CloudFrontClient;
  private _cloudFrontDistributionId: string;
  private _useCloudFront: boolean = false;

  constructor(region?: string, accessKeyId?: string, secretAccessKey?: string, cloudFrontDistributionId?: string) {
    const _region = region ?? process.env.AWS_REGION ?? "us-east-1";
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

  // S3 버킷 설정
  private setup(): q.Promise<void> {
    return q.Promise<void>((resolve, reject) => {
      // 버킷 존재 여부 확인 및 생성
      const checkAndCreateBucket = async (bucketName: string) => {
        try {
          await this._s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        } catch (error) {
          if (error.name === "NotFound") {
            await this._s3Client.send(
              new CreateBucketCommand({
                Bucket: bucketName,
                CreateBucketConfiguration: {
                  LocationConstraint: 'ap-northeast-2'
                },
              })
            );
          } else {
            throw error;
          }
        }
      };

      Promise.all([
        checkAndCreateBucket(CustomS3Client.BLOB_BUCKET_NAME),
        checkAndCreateBucket(CustomS3Client.HISTORY_BLOB_BUCKET_NAME),
      ])
        .then(() => {
          // 헬스 체크용 객체 생성
          return Promise.all([
            this.uploadString(CustomS3Client.BLOB_BUCKET_NAME, StorageKeys.getHealthCheckKey(), "health"),
            this.uploadString(CustomS3Client.HISTORY_BLOB_BUCKET_NAME, StorageKeys.getHealthCheckKey(), "health"),
          ]);
        })
        .then(() => resolve())
        .catch((error) => reject(error));
    });
  }

  // 헬스 체크
  public checkHealth(): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        Promise.all([this.healthCheck(CustomS3Client.BLOB_BUCKET_NAME), this.healthCheck(CustomS3Client.HISTORY_BLOB_BUCKET_NAME)])
          .then(() => resolve())
          .catch((error) => reject(error));
      });
    });
  }

  private healthCheck(bucketName: string): Promise<void> {
    return this._s3Client
      .send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: StorageKeys.getHealthCheckKey(),
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

  // 문자열 업로드
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

  // 스트림 업로드
  public uploadStream(bucketName: string, key: string, stream: stream.Readable, contentLength: number): q.Promise<void> {
    return this._setupPromise.then(() => {
      return q.Promise<void>((resolve, reject) => {
        // 스트림을 버퍼로 변환
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

  // 문자열 다운로드
  public downloadString(bucketName: string, key: string): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
        this._s3Client
          .send(
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

  // 객체 삭제
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

  // 서명된 URL 생성
  public getSignedUrl(bucketName: string, key: string, expiresIn: number = 3600): q.Promise<string> {
    return this._setupPromise.then(() => {
      return q.Promise<string>((resolve, reject) => {
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

  // 패키지 히스토리 저장
  public savePackageHistory(deploymentId: string, packageHistory: storage.Package[]): q.Promise<void> {
    const key = StorageKeys.getPackageHistoryBlobId(deploymentId);
    const content = JSON.stringify(packageHistory);

    return this.uploadString(CustomS3Client.HISTORY_BLOB_BUCKET_NAME, key, content);
  }

  // 패키지 히스토리 로드
  public loadPackageHistory(deploymentId: string): q.Promise<storage.Package[]> {
    const key = StorageKeys.getPackageHistoryBlobId(deploymentId);

    return this.downloadString(CustomS3Client.HISTORY_BLOB_BUCKET_NAME, key)
      .then((content) => {
        try {
          return JSON.parse(content);
        } catch (e) {
          return [];
        }
      })
      .catch(() => {
        // 히스토리가 없으면 빈 배열 반환
        return [];
      });
  }

  // CloudFront URL 생성 메서드 추가
  public getCloudFrontUrl(blobId: string): q.Promise<string> {
    return this._setupPromise.then(() => {
      if (!this._useCloudFront) {
        // CloudFront가 설정되지 않은 경우 일반 S3 URL 반환
        return this.getBlobUrl(blobId);
      }

      // CloudFront 도메인 사용
      const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
      if (!cloudFrontDomain) {
        return this.getBlobUrl(blobId);
      }

      // CloudFront URL 생성
      // 예: https://d1234abcd.cloudfront.net/package/hash123
      return q.Promise<string>((resolve) => {
        const url = `https://${cloudFrontDomain}/${blobId}`;
        resolve(url);
      });
    });
  }

  // CloudFront 캐시 무효화 메서드 추가
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

  // 패키지 업로드 후 CloudFront 캐시 무효화
  public addBlob(blobId: string, stream: stream.Readable, streamLength: number): q.Promise<string> {
    return this.uploadStream(CustomS3Client.BLOB_BUCKET_NAME, blobId, stream, streamLength).then(() => {
      // 새 객체가 업로드되면 관련 CloudFront 캐시 무효화
      if (this._useCloudFront) {
        return this.invalidateCache(["/" + blobId]).then(() => blobId);
      }
      return blobId;
    });
  }

  // 패키지 URL 가져오기
  public getBlobUrl(blobId: string): q.Promise<string> {
    // CloudFront가 활성화된 경우 CloudFront URL 반환
    if (this._useCloudFront) {
      return this.getCloudFrontUrl(blobId);
    }

    // 기존 S3 URL 생성 로직
    return this.getSignedUrl(CustomS3Client.BLOB_BUCKET_NAME, blobId);
  }

  // 패키지 삭제
  public removeBlob(blobId: string): q.Promise<void> {
    return this.deleteObject(CustomS3Client.BLOB_BUCKET_NAME, blobId);
  }

  // S3 에러 처리
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

  // S3 클라이언트 반환
  public getS3Client(): S3Client {
    return this._s3Client;
  }

  // 설정 프로미스 반환
  public getSetupPromise(): q.Promise<void> {
    return this._setupPromise;
  }
}
