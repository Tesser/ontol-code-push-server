// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import mongoose from 'mongoose';
import { AccessKey } from '../../infrastructure/storage-types';

const accessKeySchema = new mongoose.Schema<AccessKey>({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  friendlyName: { type: String, required: true },
  createdBy: { type: String, required: true },
  createdTime: { type: Number, required: true, default: () => Date.now() },
  expires: { type: Number, required: true },
  description: { type: String },
  isSession: { type: Boolean, default: false }
}, {
  timestamps: true,
  versionKey: false
});

// 액세스 키 포인터 스키마
const accessKeyPointerSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  accountId: { type: String, required: true },
  expires: { type: Number, required: true }
}, {
  timestamps: true,
  versionKey: false
});

// 인덱스 설정
accessKeyPointerSchema.index({ name: 1 }, { unique: true });

// 모델 생성
export const AccessKeyModel = mongoose.model<AccessKey>('AccessKey', accessKeySchema);
export const AccessKeyPointerModel = mongoose.model('AccessKeyPointer', accessKeyPointerSchema);