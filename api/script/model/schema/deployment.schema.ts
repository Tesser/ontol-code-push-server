// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import mongoose from 'mongoose';
import { Deployment, DeploymentInfo, Package } from '../../infrastructure/storage-types';

// 패키지 스키마
const packageSchema = new mongoose.Schema<Package>({
  appVersion: { type: String, required: true },
  blobUrl: { type: String },
  description: { type: String },
  diffPackageMap: { type: Map, of: Object },
  isDisabled: { type: Boolean, default: false },
  isMandatory: { type: Boolean, default: false },
  label: { type: String },
  manifestBlobUrl: { type: String },
  originalDeployment: { type: String },
  originalLabel: { type: String },
  packageHash: { type: String },
  releasedBy: { type: String },
  releaseMethod: { type: String },
  rollout: { type: Number },
  size: { type: Number },
  uploadTime: { type: Number }
}, { _id: false });

const deploymentSchema = new mongoose.Schema<Deployment>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  key: { type: String, required: true, unique: true },
  createdTime: { type: Number, required: true, default: () => Date.now() },
  appId: { type: String, required: true },
  package: { type: packageSchema }
}, {
  timestamps: true,
  versionKey: false
});

const deploymentInfoSchema = new mongoose.Schema<DeploymentInfo>({
  appId: { type: String, required: true },
  deploymentId: { type: String, required: true },
  deploymentKey: { type: String }
}, { _id: false });

// 인덱스 설정
deploymentSchema.index({ key: 1 }, { unique: true });
deploymentInfoSchema.index({ appId: 1, deploymentId: 1 }, { unique: true });

// 모델 생성
export const DeploymentModel = mongoose.model<Deployment>('Deployment', deploymentSchema);
export const DeploymentInfoModel = mongoose.model<DeploymentInfo>('DeploymentInfo', deploymentInfoSchema);