// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import mongoose from 'mongoose';
import { App, CollaboratorProperties } from '../../infrastructure/storage-types';

// 공동 작업자 스키마
const collaboratorPropertiesSchema = new mongoose.Schema<CollaboratorProperties>({
  accountId: { type: String },
  isCurrentAccount: { type: Boolean },
  permission: { type: String, required: true }
}, { _id: false });


const appSchema = new mongoose.Schema<App>({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    createdTime: { type: Number, required: true, default: () => Date.now() },
    collaborators: { 
      type: Map, 
      of: collaboratorPropertiesSchema 
    }
  }, {
    timestamps: true,
    versionKey: false
  });

// 인덱스 설정
appSchema.index({ "collaborators.email": 1 });

// 모델 생성
export const AppModel = mongoose.model<App>('App', appSchema);
