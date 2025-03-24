// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import mongoose from "mongoose";
import * as q from "q";
import {
  AccessKeyModel,
  AccessKeyPointerModel,
  AccountModel,
  AppModel,
  DeploymentModel
} from "./schema";

/**
 * Mongoose 모델 모음
 */
export interface MongooseModels {
  Account: typeof AccountModel;
  App: typeof AppModel;
  Deployment: typeof DeploymentModel;
  AccessKey: typeof AccessKeyModel;
  AccessKeyPointer: typeof AccessKeyPointerModel;
}

/**
 * Mongoose 연결 옵션
 */
export const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  autoIndex: true,
};

/**
 * Mongoose 연결을 설정합니다.
 * @param mongoUrl MongoDB 연결 URL
 * @returns 설정 완료 Promise와 Mongoose 인스턴스
 */
export function setupMongoose(mongoUrl: string): q.Promise<typeof mongoose> {
  return q.Promise<typeof mongoose>((resolve, reject) => {
    // Mongoose 연결 이벤트 핸들러 설정
    mongoose.connection.on("connected", () => {
      console.log("✅ Mongoose가 MongoDB에 연결되었습니다.");
    });

    mongoose.connection.on("error", (err) => {
      console.error("🔴 Mongoose 연결 오류:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.log("⚠️ Mongoose 연결이 끊어졌습니다.");
    });

    // Mongoose 연결 시도
    mongoose
      .connect(mongoUrl, mongooseOptions)
      .then(() => {
        // 모든 모델 초기화 확인
        console.log(`🦊 Mongoose 모델 초기화: ${Object.keys({ 
          Account: AccountModel,
          App: AppModel,
          Deployment: DeploymentModel,
          AccessKey: AccessKeyModel,
          AccessKeyPointer: AccessKeyPointerModel
        }).join(', ')}`);
        
        resolve(mongoose);
      })
      .catch((error) => {
        console.error("🔴 Mongoose 연결 실패:", error);
        reject(error);
      });
  });
}

/**
 * Mongoose 연결을 종료합니다.
 * @returns 종료 Promise
 */
export function closeMongoose(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    return mongoose.connection.close();
  }
  return Promise.resolve();
}

/**
 * Mongoose 모델을 반환합니다.
 * @returns Mongoose 모델 객체
 */
export function getMongooseModels(): MongooseModels {
  return {
    Account: AccountModel,
    App: AppModel, 
    Deployment: DeploymentModel,
    AccessKey: AccessKeyModel,
    AccessKeyPointer: AccessKeyPointerModel
  };
}